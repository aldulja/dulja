import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { down, up } from "../../src/migrate";
import { MIGRATIONS_DIR, startDb, type Db } from "../harness";
import { schemaFingerprint } from "../support/schema-fingerprint";

describe("0064 alternate-order branch policy", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => {
    await db?.stop();
  });
  it("applies the same restrictive role clause when actor_in_branch already exists, then round-trips exactly", async () => {
    const before = await schemaFingerprint(db.admin);
    await down(db.migrator, MIGRATIONS_DIR, 63);
    const migration68 = readFileSync(
      join(MIGRATIONS_DIR, "0068_create_branch_isolation_policies.sql"),
      "utf8",
    );
    const start = migration68.indexOf("create function app.actor_in_branch(");
    const end = migration68.indexOf("$$;", start) + 3;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const predicate = migration68.slice(start, end);
    const employee = readFileSync(join(MIGRATIONS_DIR, "0064_create_employee_minimal.sql"), "utf8");
    const employeeDown = readFileSync(join(MIGRATIONS_DIR, "0064.down.sql"), "utf8");
    const directory = mkdtempSync(join(tmpdir(), "dulja-employee-order-"));
    try {
      // The migration runner is the SQL execution boundary. The production predicate
      // is installed first only in this isolated test database to exercise 0064's conditional.
      writeFileSync(
        join(directory, "0064_employee_with_existing_branch_predicate.sql"),
        `${predicate}\n${employee}`,
      );
      writeFileSync(
        join(directory, "0064.down.sql"),
        `${employeeDown}\ndrop function app.actor_in_branch(uuid,uuid);\n`,
      );
      await up(db.migrator, directory);
      const rows = await db.admin<{ permissive: boolean; roles: string[]; expression: string }[]>`
        select p.polpermissive as permissive,
               array(select r.rolname::text from pg_roles r where r.oid=any(p.polroles) order by r.rolname) as roles,
               pg_get_expr(p.polqual,p.polrelid) as expression
          from pg_policy p where p.polrelid='app.employee'::regclass and p.polname='branch_isolation'`;
      expect([...rows]).toEqual([
        {
          permissive: false,
          roles: ["app_migrator", "app_rw"],
          expression: "app.actor_in_branch(company_id, home_branch_id)",
        },
      ]);
      await down(db.migrator, directory, 63);
      await up(db.migrator, MIGRATIONS_DIR);
      expect(await schemaFingerprint(db.admin)).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
