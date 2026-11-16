import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { grantCodes, seedBranch, seedEmployee, seedTenant, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("migration 0080 — the employee master grows the §3.10.1 columns and the R4 guard", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let self: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-emp-a");
    b = await seedTenant(db, "8a-emp-b");
    // app.employee carries 6C's Form A′ branch_isolation (0068): a principal sees an employee only through a
    // live role in the company. One company-wide grant with no codes is what lets each human below reach the
    // rows at all; the codes are irrelevant to what is asserted (6C's attendance suite, amendment A15).
    await grantCodes(db, a);
    await grantCodes(db, b);
    self = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name)
               values (${self}, ${`sub-self-${self}`}, 'human', 'Self')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${self})`;
    });
    await grantCodes(db, a, { principalId: self });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("carries position, employment_type, statutory_profile_note and archived_at", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'employee'
         and column_name in ('position', 'employment_type', 'statutory_profile_note', 'archived_at') order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "archived_at",
      "employment_type",
      "position",
      "statutory_profile_note",
    ]);
    expect(cols.every((c) => c.is_nullable === "YES")).toBe(true); // expand, never contract (§3.4.7)
  });

  it("refuses an employment_type outside the four §4.6.1 values", async () => {
    const id = await seedEmployee(db, a, { employeeNumber: "E-KIND" });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.employee set employment_type = 'intern' where id = ${id}`,
      ),
    ).rejects.toThrow(/employee_employment_type_check/);
    const ok = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.employee set employment_type = 'contract' where id = ${id}`,
    );
    expect(ok.count).toBe(1);
  });

  it("R4: a principal cannot terminate their own employee row (ERR_HR_SELF_PAY, spec:2175)", async () => {
    const mine = await seedEmployee(db, a, { employeeNumber: "E-SELF", principalId: self });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        self,
        (tx) => tx`update app.employee set terminated_on = '2026-06-30' where id = ${mine}`,
      ),
    ).rejects.toThrow(/ERR_HR_SELF_PAY/);
    // the guard is on terminated_on only: the same principal may still be described (position)
    const described = await withTenant(
      db.rw,
      a.tenant,
      self,
      (tx) => tx`update app.employee set position = 'Clerk' where id = ${mine}`,
    );
    expect(described.count).toBe(1);
    // another principal may terminate
    const other = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.employee set terminated_on = '2026-06-30' where id = ${mine}`,
    );
    expect(other.count).toBe(1);
  });

  it("R4 does not fire for an employee with no principal", async () => {
    const other = await seedEmployee(db, a, { employeeNumber: "E-NOPRIN" });
    const res = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.employee set terminated_on = '2026-07-31' where id = ${other}`,
    );
    expect(res.count).toBe(1);
  });

  it("tenant B cannot see or archive tenant A's employee (test 12)", async () => {
    const branch = await seedBranch(db, b, { code: "BR-2" });
    expect(branch).toBeTruthy();
    const id = await seedEmployee(db, a, { employeeNumber: "E-ISO-80" });
    const rows = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ id: string }[]>`select id from app.employee where id = ${id}`,
    );
    expect(rows).toHaveLength(0);
    const res = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx`update app.employee set archived_at = now() where id = ${id}`,
    );
    expect(res.count).toBe(0);
  });

  it("the schema linter reports zero violations after 0080", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
