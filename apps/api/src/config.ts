import type { LogLevel } from "@dulja/contracts";
import { decodeHrKey, DEV_HR_KEY } from "@dulja/db";

export interface ApiConfig {
  /** §3.11 — signs the short-lived terminal JWT (spec:2273). Required in every environment: an API that
   *  cannot mint one cannot serve /v1/sync/*, and a default would be a shared secret in the repository. A
   *  deployment binds it as a container secret (docs/runbooks/deploy.md, "Secrets"); the edge forwards it to
   *  the API container only (`apps/edge/src/container-env.ts`). */
  readonly terminalJwtSigningKey: string;
  readonly appEnv: "dev" | "staging" | "production";
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly supabaseJwksUrl: string;
  readonly supabaseJwtIssuer: string;
  readonly supabaseJwtAudience: string;
  /** Both null wherever the identity provider is not reachable — see `createAuthAdmin`. */
  readonly supabaseUrl: string | null;
  readonly supabaseServiceRoleKey: string | null;
  readonly port: number;
  /** 2C — the four R2 values of contracts §3.11. Optional in `dev` (a MemoryObjectStore serves a laptop),
   *  required everywhere else: attachments would otherwise have nowhere to go. */
  readonly r2AccountId: string | null;
  readonly r2AttachmentsBucket: string | null;
  readonly r2AccessKeyId: string | null;
  readonly r2SecretAccessKey: string | null;
  /** 2C — a host-installed Chromium for the print engine. Optional everywhere: unset, Playwright launches
   *  the build its own version pins. Forwarded by `apps/edge/src/container-env.ts` like the other optionals. */
  readonly chromiumExecutablePath: string | null;
  /** 8A — §3.11's HR field-encryption key, base64 of exactly 32 bytes (amendment A8, ADR 0071). Optional only in
   *  `dev`, where the all-zero DEV_HR_KEY stands in; required everywhere else, or employee_sensitive has nowhere
   *  to go. */
  readonly hrFieldEncryptionKey: string;
  /** 8A — the previous key, present only while 8D's rotation runs; never required and never defaulted. */
  readonly hrFieldEncryptionKeyPrevious: string | null;
  /** 8D A1 — HR_FIELD_ENCRYPTION_KEY_VERSION, the envelope version the current key seals under: optional, default 1,
   *  an integer from 1 to 255. The previous key's version is this one minus one (`createHrKeyRing`). The worker reads
   *  the same name on the same terms (`apps/worker/src/hr-keys.ts`), so both halves agree on the current key. */
  readonly hrFieldEncryptionKeyVersion: number;
}
export class ConfigError extends Error {}
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const appEnv = env["APP_ENV"] ?? "dev";
  const logLevel = env["LOG_LEVEL"] ?? "info";
  if (!(["dev", "staging", "production"] as const).includes(appEnv as ApiConfig["appEnv"]))
    throw new ConfigError("invalid APP_ENV");
  if (!(["debug", "info", "warn", "error"] as const).includes(logLevel as LogLevel))
    throw new ConfigError("invalid LOG_LEVEL");
  const port = Number(env["PORT"] ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigError("PORT must be an integer from 1 to 65535");
  const r2AccountId = env["R2_ACCOUNT_ID"] ?? null;
  const r2AttachmentsBucket = env["R2_ATTACHMENTS_BUCKET"] ?? null;
  const r2AccessKeyId = env["R2_ACCESS_KEY_ID"] ?? null;
  const r2SecretAccessKey = env["R2_SECRET_ACCESS_KEY"] ?? null;
  if (appEnv !== "dev") {
    for (const [name, value] of [
      ["R2_ACCOUNT_ID", r2AccountId],
      ["R2_ATTACHMENTS_BUCKET", r2AttachmentsBucket],
      ["R2_ACCESS_KEY_ID", r2AccessKeyId],
      ["R2_SECRET_ACCESS_KEY", r2SecretAccessKey],
    ] as const) {
      if (!value)
        throw new ConfigError(
          `${name} is required when APP_ENV=${appEnv} — attachments have nowhere to go (contracts §3.11)`,
        );
    }
  }
  // The message names the one command that fixes it: a missing key is a deployment that skipped the
  // runbook's secret step, and the container exits 2 here rather than serving without terminal sync.
  const terminalJwtSigningKey = env["TERMINAL_JWT_SIGNING_KEY"] ?? "";
  if (terminalJwtSigningKey.length < 32)
    throw new ConfigError(
      `TERMINAL_JWT_SIGNING_KEY ${terminalJwtSigningKey ? "must be at least 32 characters" : "is not set"} — ` +
        "generate one with `openssl rand -base64 48` and bind it as a container secret (contracts §3.11; docs/runbooks/deploy.md)",
    );
  // 8A (amendment A8): the key is validated HERE, with this file's ConfigError, so a deployment's bad key exits 2 at
  // boot naming the variable rather than surfacing from the key ring later. …_PREVIOUS is validated the same way
  // when present; its absence is the normal state.
  const hrFieldEncryptionKey =
    env["HR_FIELD_ENCRYPTION_KEY"] || (appEnv === "dev" ? DEV_HR_KEY : undefined);
  if (hrFieldEncryptionKey === undefined)
    throw new ConfigError(
      `HR_FIELD_ENCRYPTION_KEY is required when APP_ENV=${appEnv} — employee_sensitive has nowhere to go without it. ` +
        "Generate one with `openssl rand -base64 32` and bind it as a container secret (contracts §3.11; docs/runbooks/deploy.md)",
    );
  const hrFieldEncryptionKeyPrevious = env["HR_FIELD_ENCRYPTION_KEY_PREVIOUS"] || null;
  for (const [name, value] of [
    ["HR_FIELD_ENCRYPTION_KEY", hrFieldEncryptionKey],
    ["HR_FIELD_ENCRYPTION_KEY_PREVIOUS", hrFieldEncryptionKeyPrevious],
  ] as const) {
    if (value === null) continue;
    try {
      decodeHrKey(name, value);
    } catch (error) {
      throw new ConfigError((error as Error).message);
    }
  }
  // 8D (A1): the version the current key seals under. Strict digits — Number() would read "", " 2 " and "1e0" — and
  // one envelope byte. A previous key beside version 1 has no version to live at (createHrKeyRing derives it as the
  // current one minus one), so it is refused here by name rather than surfacing as a key-ring error.
  const rawHrKeyVersion = env["HR_FIELD_ENCRYPTION_KEY_VERSION"] || "1";
  const hrFieldEncryptionKeyVersion = /^[1-9][0-9]{0,2}$/.test(rawHrKeyVersion)
    ? Number(rawHrKeyVersion)
    : Number.NaN;
  if (!(hrFieldEncryptionKeyVersion >= 1 && hrFieldEncryptionKeyVersion <= 255))
    throw new ConfigError(
      `HR_FIELD_ENCRYPTION_KEY_VERSION must be an integer between 1 and 255; received ${JSON.stringify(rawHrKeyVersion)} (contracts §3.11, 8D A1)`,
    );
  if (hrFieldEncryptionKeyPrevious !== null && hrFieldEncryptionKeyVersion === 1)
    throw new ConfigError(
      "HR_FIELD_ENCRYPTION_KEY_PREVIOUS is bound but HR_FIELD_ENCRYPTION_KEY_VERSION is 1 — set the version to the previous one plus one (docs/runbooks/hr-key-rotation.md)",
    );
  return {
    terminalJwtSigningKey,
    appEnv: appEnv as ApiConfig["appEnv"],
    logLevel: logLevel as LogLevel,
    databaseUrl: required(env, "DATABASE_URL"),
    supabaseJwksUrl: required(env, "SUPABASE_JWKS_URL"),
    supabaseJwtIssuer: required(env, "SUPABASE_JWT_ISSUER"),
    // Supabase stamps every access token `aud: "authenticated"`, so that is the default rather than a
    // required name: `apps/edge/src/container-env.ts` passes the container a fixed list and this is not on
    // it, so requiring it would fail boot on a decision this file does not own. The override exists for a
    // deployment that mints something else.
    supabaseJwtAudience: env["SUPABASE_JWT_AUDIENCE"] || "authenticated",
    // Optional, and read as null when absent rather than "" so `createAuthAdmin` has one thing to test.
    supabaseUrl: env["SUPABASE_URL"] || null,
    supabaseServiceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"] || null,
    port,
    r2AccountId,
    r2AttachmentsBucket,
    r2AccessKeyId,
    r2SecretAccessKey,
    chromiumExecutablePath: env["CHROMIUM_EXECUTABLE_PATH"] || null,
    hrFieldEncryptionKey,
    hrFieldEncryptionKeyPrevious,
    hrFieldEncryptionKeyVersion,
  };
}
