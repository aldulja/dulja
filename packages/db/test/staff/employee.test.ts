import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  seedTenant,
  seedEmployee,
  seedBranch,
  seedParty,
  grantCodes,
  type Seed,
} from "../fixtures";
import { lintSchema, listApplied } from "../../src";

let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenant(db, "alpha");
  b = await seedTenant(db, "beta");
  // `a.human` reads `app.employee` below, and from Task 5's migration 0068 that table carries Form A′ of
  // the RESTRICTIVE `branch_isolation` family: a principal with no live `app.role_assignment` in the
  // company sees ZERO rows and every read here would come back empty. One company-wide grant (no
  // `branchIds`) is amendment A15's remedy and what `app.actor_has` already calls company-wide authority.
  await grantCodes(db, a);
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("app.employee — the minimal master (§4.6.2, spec:2075)", () => {
  it("migration 64 is applied and the table carries exactly the frozen columns", async () => {
    expect(await listApplied(db.migrator)).toContain(64);
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'employee' order by column_name`;
    // EXACTLY these ten from 0064: 8A adds position, employment_type, statutory_profile_note and archived_at in
    // its own migration 0080 — never here (§4.6.1) — so an early extra column is a contract break, not a bonus.
    // 0080 is applied in this database, so its four are set aside by name and asserted as exactly those four — and
    // 8D's 0098 `contract_ends_on` (contracts round 19, 8D A2) beside them.
    const EIGHT_A = [
      "archived_at",
      "contract_ends_on",
      "employment_type",
      "position",
      "statutory_profile_note",
    ];
    expect(cols.map((c) => c.column_name).filter((c) => EIGHT_A.includes(c))).toEqual(EIGHT_A);
    // 9B's 0101 `legacy_ref` (contracts §4.13.3), set aside the same way: nullable, never a 0064 column.
    const NINE_B = ["legacy_ref"];
    expect(cols.map((c) => c.column_name).filter((c) => NINE_B.includes(c))).toEqual(NINE_B);
    const later = [...EIGHT_A, ...NINE_B];
    expect(cols.map((c) => c.column_name).filter((c) => !later.includes(c))).toEqual([
      "company_id",
      "created_at",
      "employee_number",
      "hired_on",
      "home_branch_id",
      "id",
      "party_id",
      "principal_id",
      "tenant_id",
      "terminated_on",
    ]);
    const nullable = cols
      .filter((c) => c.is_nullable === "YES" && !later.includes(c.column_name))
      .map((c) => c.column_name);
    expect(nullable).toEqual(["principal_id", "terminated_on"]);
  });

  it("seedEmployee creates one party of kind employee and one employee", async () => {
    const id = await seedEmployee(db, a, { employeeNumber: "E-0001" });
    const rows = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ employee_number: string; home_branch_id: string; kind: string }[]>`
        select e.employee_number, e.home_branch_id, p.kind
          from app.employee e join app.party p on p.id = e.party_id where e.id = ${id}`,
    );
    expect([...rows]).toEqual([
      { employee_number: "E-0001", home_branch_id: a.hq, kind: "employee" },
    ]);
  });

  it("employee_number is unique within a company and free across tenants", async () => {
    await seedEmployee(db, a, { employeeNumber: "E-DUP" });
    // Not a second `seedEmployee(…, "E-DUP")`: its party code `EMP-E-DUP` would collide on the party's own
    // unique key first, and the case would pass on the wrong constraint. A distinct party isolates the
    // employee table's `unique (company_id, employee_number)`.
    const party = await seedParty(db, a, { kind: "employee", code: "EMP-E-DUP-2" });
    await expect(
      withTenant(
        db.migrator,
        a.tenant,
        a.system,
        (tx) => tx`
        insert into app.employee (tenant_id, company_id, party_id, employee_number, home_branch_id, hired_on)
        values (${a.tenant}, ${a.company}, ${party}, 'E-DUP', ${a.hq}, '2026-01-01')`,
      ),
    ).rejects.toThrow(/employee_company_id_employee_number_key/);
    await expect(seedEmployee(db, b, { employeeNumber: "E-DUP" })).resolves.toEqual(
      expect.any(String),
    );
  });

  it("principal_id is unique across the whole table — one till identity, one person (spec:2097)", async () => {
    const pid = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${pid}, 'human', ${"sub-" + pid}, 'Cashier One')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${pid})`;
    });
    await seedEmployee(db, a, { employeeNumber: "E-P1", principalId: pid });
    await expect(seedEmployee(db, a, { employeeNumber: "E-P2", principalId: pid })).rejects.toThrow(
      /employee_principal_id_key/,
    );
  });

  it("tenant B cannot read tenant A's employees — tenant isolation, not branch isolation", async () => {
    await seedEmployee(db, a, { employeeNumber: "E-ISO" });
    // Both readers are their tenant's system principal, which passes every branch_isolation form, so the
    // only thing that can hide the row from B is tenant_isolation. The positive control comes first, so the
    // zero below cannot be vacuous.
    const mine = await withTenant(
      db.rw,
      a.tenant,
      a.system,
      (tx) => tx`select id from app.employee where employee_number = 'E-ISO'`,
    );
    expect(mine).toHaveLength(1);
    const theirs = await withTenant(
      db.rw,
      b.tenant,
      b.system,
      (tx) => tx`select id from app.employee where employee_number = 'E-ISO'`,
    );
    expect(theirs).toHaveLength(0);
  });

  it("home_branch_id must be a dimension_value of this tenant (composite foreign key)", async () => {
    const other = await seedBranch(db, b, { code: "B2" });
    await expect(
      seedEmployee(db, a, { employeeNumber: "E-XB", homeBranchId: other }),
    ).rejects.toThrow(/employee_tenant_id_home_branch_id_fkey/);
  });

  it("the schema linter reports zero violations after 0064", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
