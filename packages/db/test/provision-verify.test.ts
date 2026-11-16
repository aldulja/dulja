import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatPosture, verifySupabase } from "../provision/verify-supabase";
import { startDb, type Db } from "./harness";

describe("Supabase posture probe (OD-19 local default)", () => {
  let db: Db;
  let clean: string;
  let dirty: string;

  beforeAll(async () => {
    db = await startDb();
    const directory = mkdtempSync(join(tmpdir(), "dulja-config-"));
    clean = join(directory, "clean.jsonc");
    dirty = join(directory, "dirty.jsonc");
    writeFileSync(clean, '{ "DATABASE_URL": "postgres://app_rw@db.example:5432/postgres" }');
    writeFileSync(dirty, '{ "DATABASE_URL": "postgres://app_rw@pooler.example:6543/postgres" }');
  });
  afterAll(async () => db.stop());

  it("prints the four frozen posture lines", async () => {
    const checks = await verifySupabase({
      rwUrl: db.url("app_rw"),
      adminUrl: db.url("app_migrator"),
      configFiles: [clean],
    });
    expect(formatPosture(checks)).toBe(
      "rls-forced: ok\nbypassrls-probe: refused\napp_auth-login: refused\npooler-url: absent",
    );
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it("reports every tenant table as forced RLS", async () => {
    const [check] = await verifySupabase({
      rwUrl: db.url("app_rw"),
      adminUrl: db.url("app_migrator"),
      configFiles: [clean],
    });
    expect(check?.detail).toMatch(/^\d+ tables in schema app, all forced$/);
  });

  it("finds a transaction-mode pooler URL", async () => {
    const checks = await verifySupabase({
      rwUrl: db.url("app_rw"),
      adminUrl: db.url("app_migrator"),
      configFiles: [clean, dirty],
    });
    const pooler = checks.find((check) => check.name === "pooler-url");
    expect(pooler?.ok).toBe(false);
    expect(pooler?.detail).toContain("dirty.jsonc");
    expect(formatPosture(checks)).toContain("pooler-url: PRESENT");
  });

  it("proves app_rw cannot bypass RLS and app_auth cannot log in", async () => {
    const checks = await verifySupabase({
      rwUrl: db.url("app_rw"),
      adminUrl: db.url("app_migrator"),
      configFiles: [clean],
    });
    expect(checks.find((check) => check.name === "bypassrls-probe")?.detail).toBe(
      "app_rw rolbypassrls=false and set role refused",
    );
    expect(checks.find((check) => check.name === "app_auth-login")?.detail).toBe(
      "app_auth rolcanlogin=false, rolbypassrls=false",
    );
  });
});
