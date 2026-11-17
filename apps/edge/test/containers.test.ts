import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containerSecrets } from "../src/container-env"; // NOT ../src/containers — that imports cloudflare:workers
import type { Env } from "../src/env";

/** Every name docs/runbooks/deploy.md's "Secrets" block binds with `wrangler secret put` (PR 12 review, R15). */
function runbookSecrets(): string[] {
  const runbook = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "docs",
      "runbooks",
      "deploy.md",
    ),
    "utf8",
  );
  const block =
    /The container's secrets are set once per environment[\s\S]*?```bash\n([\s\S]*?)```/.exec(
      runbook,
    )?.[1];
  if (block === undefined)
    throw new Error("docs/runbooks/deploy.md has no container-secrets block");
  const looped = /for name in ([\s\S]*?); do/.exec(block)?.[1]?.split(/[\s\\]+/) ?? [];
  const single = [...block.matchAll(/wrangler secret put ([A-Z0-9_]+)/g)].map((m) => m[1]!);
  return [...looped, ...single].filter((name) => /^[A-Z0-9_]+$/.test(name));
}

const env = {
  APP_ENV: "staging",
  LOG_LEVEL: "info",
  DATABASE_URL: "postgres://app_rw:pw@db.ref.supabase.co:5432/postgres",
  TERMINAL_JWT_SIGNING_KEY: "fixture-terminal-signing-key-0123456789abcdef",
  SUPABASE_URL: "https://ref.supabase.co",
  SUPABASE_JWT_ISSUER: "https://ref.supabase.co/auth/v1",
  SUPABASE_JWT_AUDIENCE: "authenticated",
  SUPABASE_JWKS_URL: "https://ref.supabase.co/auth/v1/.well-known/jwks.json",
  SENTRY_DSN: "https://key@o0.ingest.sentry.io/0",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example/v1/traces",
  R2_ACCOUNT_ID: "acc",
  R2_ATTACHMENTS_BUCKET: "dulja-attachments",
  R2_ACCESS_KEY_ID: "AKIA",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  CHROMIUM_EXECUTABLE_PATH: "/usr/bin/chromium",
  EINVOICE_CLIENT_SECRET: "fixture-einvoice-secret",
  HR_FIELD_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
} as unknown as Env;

describe("containerSecrets — the §3.11 inventory the container receives (spec:2273)", () => {
  it("passes the declared serving-process bindings to both containers", () => {
    expect(Object.keys(containerSecrets(env, "api")).toSorted()).toEqual([
      "APP_ENV",
      "CHROMIUM_EXECUTABLE_PATH",
      "DATABASE_URL",
      "DULJA_ENTRYPOINT",
      "EINVOICE_CLIENT_SECRET",
      "HR_FIELD_ENCRYPTION_KEY",
      "LOG_LEVEL",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "R2_ACCESS_KEY_ID",
      "R2_ACCOUNT_ID",
      "R2_ATTACHMENTS_BUCKET",
      "R2_SECRET_ACCESS_KEY",
      "SENTRY_DSN",
      "SUPABASE_JWKS_URL",
      "SUPABASE_JWT_AUDIENCE",
      "SUPABASE_JWT_ISSUER",
      "SUPABASE_URL",
      "TERMINAL_JWT_SIGNING_KEY",
    ]);
    expect(containerSecrets(env, "worker")["DULJA_ENTRYPOINT"]).toBe("worker");
    expect(containerSecrets(env, "worker")["EINVOICE_CLIENT_SECRET"]).toBe(
      "fixture-einvoice-secret",
    );
  });

  it("passes the four R2 names and the host Chromium to the worker too — 7A's reporting.render (§3.11)", () => {
    const worker = containerSecrets(env, "worker");
    for (const name of [
      "R2_ACCOUNT_ID",
      "R2_ATTACHMENTS_BUCKET",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "CHROMIUM_EXECUTABLE_PATH",
    ])
      expect(worker[name], name).toBe(env[name as keyof Env]);
  });

  it("passes the HR field-encryption key to both containers, and the previous key only when bound (8A)", () => {
    for (const entrypoint of ["api", "worker"] as const)
      expect(containerSecrets(env, entrypoint)["HR_FIELD_ENCRYPTION_KEY"], entrypoint).toBe(
        env.HR_FIELD_ENCRYPTION_KEY,
      );
    expect(containerSecrets(env, "api")).not.toHaveProperty("HR_FIELD_ENCRYPTION_KEY_PREVIOUS");
    const rotating = { ...env, HR_FIELD_ENCRYPTION_KEY_PREVIOUS: "previous-key" } as unknown as Env;
    expect(containerSecrets(rotating, "worker")["HR_FIELD_ENCRYPTION_KEY_PREVIOUS"]).toBe(
      "previous-key",
    );
  });

  it("passes HR_FIELD_ENCRYPTION_KEY_VERSION to both containers when bound, and omits it otherwise (8D A1)", () => {
    for (const entrypoint of ["api", "worker"] as const)
      expect(containerSecrets(env, entrypoint), entrypoint).not.toHaveProperty(
        "HR_FIELD_ENCRYPTION_KEY_VERSION",
      );
    const rotated = {
      ...env,
      HR_FIELD_ENCRYPTION_KEY_PREVIOUS: "previous-key",
      HR_FIELD_ENCRYPTION_KEY_VERSION: "2",
    } as unknown as Env;
    // The API seals new writes and the worker re-seals old ones: both must see the SAME version (ADR 0080).
    for (const entrypoint of ["api", "worker"] as const)
      expect(
        containerSecrets(rotated, entrypoint)["HR_FIELD_ENCRYPTION_KEY_VERSION"],
        entrypoint,
      ).toBe("2");
  });

  it("passes LEGACY_ODBC_DSN to the worker alone, and only when bound (9B, round 20 C10)", () => {
    for (const entrypoint of ["api", "worker"] as const)
      expect(containerSecrets(env, entrypoint), entrypoint).not.toHaveProperty("LEGACY_ODBC_DSN");
    const cutOver = {
      ...env,
      LEGACY_ODBC_DSN: "DSN=legacy;UID=reader;PWD=fixture",
    } as unknown as Env;
    // The admin.import.run handler reads the legacy database from the worker; the API only enqueues it.
    expect(containerSecrets(cutOver, "worker")["LEGACY_ODBC_DSN"]).toBe(cutOver.LEGACY_ODBC_DSN);
    expect(containerSecrets(cutOver, "api")).not.toHaveProperty("LEGACY_ODBC_DSN");
    // OD-16's default: the historical POS database stays the CLI's alone, in neither container.
    const mpos = { ...cutOver, LEGACY_MPOS_DSN: "DSN=mpos" } as unknown as Env;
    for (const entrypoint of ["api", "worker"] as const)
      expect(containerSecrets(mpos, entrypoint), entrypoint).not.toHaveProperty("LEGACY_MPOS_DSN");
  });

  it("passes LEGACY_IMPORT_TARGET to the worker alone, beside the DSN it binds (9B review, finding 1; round 20 C19)", () => {
    for (const entrypoint of ["api", "worker"] as const)
      expect(containerSecrets(env, entrypoint), entrypoint).not.toHaveProperty(
        "LEGACY_IMPORT_TARGET",
      );
    const cutOver = {
      ...env,
      LEGACY_ODBC_DSN: "DSN=legacy;UID=reader;PWD=fixture",
      LEGACY_IMPORT_TARGET:
        "01930000-0000-7000-8000-000000000001:01930000-0000-7000-8000-000000000002",
    } as unknown as Env;
    expect(containerSecrets(cutOver, "worker")["LEGACY_IMPORT_TARGET"]).toBe(
      cutOver.LEGACY_IMPORT_TARGET,
    );
    expect(containerSecrets(cutOver, "api")).not.toHaveProperty("LEGACY_IMPORT_TARGET");
  });

  it("passes the terminal signing secret only to the API", () => {
    const withTerminalKey = {
      ...env,
      TERMINAL_JWT_SIGNING_KEY: "terminal-only-secret",
    } as unknown as Env;
    expect(containerSecrets(withTerminalKey, "api")["TERMINAL_JWT_SIGNING_KEY"]).toBe(
      "terminal-only-secret",
    );
    expect(containerSecrets(withTerminalKey, "worker")).not.toHaveProperty(
      "TERMINAL_JWT_SIGNING_KEY",
    );
  });

  // PR 12 review, R15: readConfig() requires TERMINAL_JWT_SIGNING_KEY, and the runbook never bound it — the
  // image would have crashed at boot exactly as PR 11's did. apps/api/test/config-and-auth.test.ts boots
  // readConfig() on this same list; this case proves every name on it reaches the API container.
  it("forwards every secret the deploy runbook binds to the API container, the terminal key included", () => {
    const names = runbookSecrets();
    expect(names).toContain("TERMINAL_JWT_SIGNING_KEY");
    const bound = {
      APP_ENV: "staging",
      LOG_LEVEL: "info",
      ...Object.fromEntries(
        names.map((name) => [name, `value-of-${name}-0123456789abcdef0123456789`]),
      ),
    } as unknown as Env;
    const api = containerSecrets(bound, "api");
    for (const name of names)
      expect(api[name], name).toBe(`value-of-${name}-0123456789abcdef0123456789`);
    expect(containerSecrets(bound, "worker")).not.toHaveProperty("TERMINAL_JWT_SIGNING_KEY");
  });

  it("never passes the Supabase service-role key — it is the seed CLI's alone (§3.11)", () => {
    const withKey = { ...env, SUPABASE_SERVICE_ROLE_KEY: "sb-secret" } as unknown as Env;
    expect(Object.keys(containerSecrets(withKey, "api"))).not.toContain(
      "SUPABASE_SERVICE_ROLE_KEY",
    );
    expect(Object.values(containerSecrets(withKey, "api"))).not.toContain("sb-secret");
  });

  it("never passes the migrator URL — the container must not be able to run DDL (spec:104, LEGACY-053)", () => {
    const withMigrator = {
      ...env,
      DATABASE_URL_MIGRATOR: "postgres://app_migrator:pw@db.ref.supabase.co:5432/postgres",
    } as unknown as Env;
    expect(Object.keys(containerSecrets(withMigrator, "api"))).not.toContain(
      "DATABASE_URL_MIGRATOR",
    );
  });

  it("omits an unset optional rather than passing an empty string, so readConfig() fails loudly", () => {
    const bare = {
      APP_ENV: "dev",
      LOG_LEVEL: "debug",
      DATABASE_URL: "postgres://x@h:5432/d",
      TERMINAL_JWT_SIGNING_KEY: "fixture-terminal-signing-key-0123456789abcdef",
    } as unknown as Env;
    expect(Object.keys(containerSecrets(bare, "api")).toSorted()).toEqual([
      "APP_ENV",
      "DATABASE_URL",
      "DULJA_ENTRYPOINT",
      "LOG_LEVEL",
      "TERMINAL_JWT_SIGNING_KEY",
    ]);
  });
});
