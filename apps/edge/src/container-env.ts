import type { Env } from "./env";

/**
 * The environment the container process receives (§3.11, spec:2273). Two names are deliberately absent:
 * SUPABASE_SERVICE_ROLE_KEY is the seed CLI's alone, and DATABASE_URL_MIGRATOR would let a serving process run DDL
 * (spec:104, SAH-053). An unset optional is omitted rather than passed empty, so readConfig() fails loudly at boot.
 */
export function containerSecrets(env: Env, entrypoint: "api" | "worker"): Record<string, string> {
  const output: Record<string, string> = {
    DULJA_ENTRYPOINT: entrypoint,
    APP_ENV: env.APP_ENV,
    DATABASE_URL: env.DATABASE_URL,
  };
  const optional: readonly (keyof Env & string)[] = [
    "LOG_LEVEL",
    "SUPABASE_URL",
    "SUPABASE_JWT_ISSUER",
    "SUPABASE_JWKS_URL",
    // readConfig() reads this one and defaults it to "authenticated" when unset. Absent from this list it
    // was not optional but unreachable: a deployed container could never be told anything else, whatever
    // `wrangler secret put` held, so the override existed only for a process started from a shell.
    "SUPABASE_JWT_AUDIENCE",
    "SENTRY_DSN",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    // 2C — attachments: the api uploads and downloads (ADR 0031). §3.11's holder is `api, worker` from 7A on:
    // the reporting.render job writes the rendered report through the same ObjectStore port (ADR 0066), and
    // 7C's tenant export after it. Optional here, as for the api: the worker's objectStoreFromEnv refuses a
    // staging or production process that lacks any of the four.
    "R2_ACCOUNT_ID",
    "R2_ATTACHMENTS_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    // 2C — the print engine's host Chromium (readConfig reads it; absent from this list it could be set as a
    // Worker secret and never reach the container, the same failure SUPABASE_JWT_AUDIENCE had).
    "CHROMIUM_EXECUTABLE_PATH",
    "EINVOICE_CLIENT_SECRET",
    // 8A — the HR field-encryption key ring (§3.11, contracts round 16 A8). §3.11's holder is `api, worker`: 8D's
    // key rotation and payslip render run in the worker. Optional here as the R2 names are, so an unbound key is
    // omitted and readConfig() fails loudly at boot outside dev.
    "HR_FIELD_ENCRYPTION_KEY",
    "HR_FIELD_ENCRYPTION_KEY_PREVIOUS",
    // 8D A1 — the version the current key seals under (default 1). Both containers must read the same value, or the
    // API seals new writes under one version while hr.encryption_key.rotate re-seals under another (ADR 0080).
    "HR_FIELD_ENCRYPTION_KEY_VERSION",
  ];
  for (const name of optional) {
    const value = env[name];
    if (typeof value === "string" && value.length) output[name] = value;
  }
  // Required by the API, so passed like DATABASE_URL rather than through the optional list — and to the API
  // alone: the worker signs and verifies no terminal JWT, and a signing secret in a second container widens
  // what a compromised image holds for nothing (contracts §3.11's holder column is `api`).
  if (entrypoint === "api") output.TERMINAL_JWT_SIGNING_KEY = env.TERMINAL_JWT_SIGNING_KEY;
  // 9B (contracts §3.11, round 20 C10): the admin.import.run handler runs in the WORKER and must reach the legacy
  // Firebird database; apps/api only enqueues the job and never connects, so the credential stays out of the API
  // container. Optional: unbound, the worker refuses a load with ERR_IMPORT_SOURCE_UNREADABLE naming the variable.
  // LEGACY_MPOS_DSN stays the importer CLI's alone (OD-16's default).
  if (
    entrypoint === "worker" &&
    typeof env.LEGACY_ODBC_DSN === "string" &&
    env.LEGACY_ODBC_DSN.length
  )
    output.LEGACY_ODBC_DSN = env.LEGACY_ODBC_DSN;
  // 9B review, finding 1 (round 20 C19): the DSN is process-wide and the worker serves every tenant, so the one company
  // it may be loaded into travels beside it — to the worker alone, where the handler refuses any other run before the
  // source is opened. The API does not refuse up front (ADR 0084 decision 21): it never sees the binding.
  if (
    entrypoint === "worker" &&
    typeof env.LEGACY_IMPORT_TARGET === "string" &&
    env.LEGACY_IMPORT_TARGET.length
  )
    output.LEGACY_IMPORT_TARGET = env.LEGACY_IMPORT_TARGET;
  return output;
}
