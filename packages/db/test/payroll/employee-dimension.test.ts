import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import {
  EMPLOYEE_DIMENSION_CODE,
  ensureEmployeeDimensionType,
  ensureEmployeeDimensionValue,
} from "../../src/hr/employee-dimension";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { grantCodes, seedEmployee, seedTenantV2, type Seed } from "../fixtures";

let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "Alpha");
  b = await seedTenantV2(db, "Beta");
  // 6C's branch_isolation on app.employee hides every employee from a principal with no live role in the
  // company, so the repair path's actor holds an (empty) company-wide role — the 8A test rule.
  await grantCodes(db, a, { codes: [] });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("migration 0088 — the EMPLOYEE dimension (§4.12.7, spec:2101)", () => {
  it("inserting an employee creates the company's EMPLOYEE dimension type on FIRST use", async () => {
    const before = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.dimension_type where company_id = ${a.company} and code = ${EMPLOYEE_DIMENSION_CODE}`;
    expect(before[0]!.n).toBe(0);
    await seedEmployee(db, a, { employeeNumber: "E-1001" });
    const after = await db.admin<{ n: number; name_en: string; name_ar: string | null }[]>`
      select count(*)::int as n, min(name_en) as name_en, min(name_ar) as name_ar from app.dimension_type
       where company_id = ${a.company} and code = ${EMPLOYEE_DIMENSION_CODE}`;
    expect(after[0]!.n).toBe(1);
    expect(after[0]!.name_en).toBe("Employee");
    expect(after[0]!.name_ar).toBe("الموظف");
  });

  it("a SECOND employee reuses the type and adds one value coded by employee_number", async () => {
    await seedEmployee(db, a, { employeeNumber: "E-1002" });
    const types = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.dimension_type where company_id = ${a.company} and code = ${EMPLOYEE_DIMENSION_CODE}`;
    expect(types[0]!.n).toBe(1);
    const values = await db.admin<{ code: string }[]>`
      select v.code from app.dimension_value v
        join app.dimension_type t on t.id = v.dimension_type_id
       where t.company_id = ${a.company} and t.code = ${EMPLOYEE_DIMENSION_CODE}
       order by v.code`;
    expect(values.map((v) => v.code)).toEqual(["E-1001", "E-1002"]);
  });

  it("the value's name_en is the employee's party name, not the number (a dimension is read by humans)", async () => {
    const [row] = await db.admin<{ name_en: string }[]>`
      select v.name_en from app.dimension_value v
        join app.dimension_type t on t.id = v.dimension_type_id
       where t.company_id = ${a.company} and t.code = ${EMPLOYEE_DIMENSION_CODE} and v.code = 'E-1001'`;
    const [party] = await db.admin<{ name_en: string }[]>`
      select p.name_en from app.party p join app.employee e on e.party_id = p.id
       where e.company_id = ${a.company} and e.employee_number = 'E-1001'`;
    expect(row!.name_en).toBe(party!.name_en);
  });

  it("the BRANCH dimension is untouched — the EMPLOYEE type is a second type beside it", async () => {
    const rows = await db.admin<{ code: string }[]>`
      select code from app.dimension_type where company_id = ${a.company} order by code`;
    expect(rows.map((r) => r.code)).toEqual(["BRANCH", EMPLOYEE_DIMENSION_CODE]);
  });

  it("tenant B's employees do not appear in tenant A's dimension (test 12)", async () => {
    await seedEmployee(db, b, { employeeNumber: "E-1001" }); // the SAME number, a different tenant
    const seen = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.dimension_value v
        join app.dimension_type t on t.id = v.dimension_type_id
       where t.code = ${EMPLOYEE_DIMENSION_CODE}`,
    );
    expect(seen[0]!.n).toBe(2); // A's two, never B's
  });

  it("ensureEmployeeDimensionValue REPAIRS an employee inserted before 0088 (hazard 10 — no migration backfill)", async () => {
    // Simulate the pre-0088 state: an employee whose value the trigger never wrote.
    const legacyId = await seedEmployee(db, a, { employeeNumber: "E-0900" });
    // Removed inside a tenant transaction (the audit trigger needs a tenant) as the owner role — app_rw holds no
    // DELETE on dimension_value, and that is the point: only a test can reach this state.
    await withTenant(
      db.migrator,
      a.tenant,
      a.system,
      (tx) => tx`
      delete from app.dimension_value v
       using app.dimension_type t
       where v.dimension_type_id = t.id and t.company_id = ${a.company}
         and t.code = ${EMPLOYEE_DIMENSION_CODE} and v.code = 'E-0900'`,
    );

    const first = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      ensureEmployeeDimensionValue(tx, a.company, legacyId),
    );
    const second = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      ensureEmployeeDimensionValue(tx, a.company, legacyId),
    );
    expect(second).toBe(first); // idempotent: the second call creates nothing

    const [n] = await db.admin<{ n: number; id: string }[]>`
      select count(*)::int as n, min(v.id::text) as id from app.dimension_value v
        join app.dimension_type t on t.id = v.dimension_type_id
       where t.company_id = ${a.company} and t.code = ${EMPLOYEE_DIMENSION_CODE} and v.code = 'E-0900'`;
    expect(n!.n).toBe(1);
    expect(n!.id).toBe(first);
  });

  it("ensureEmployeeDimensionType is idempotent and returns the one type", async () => {
    const one = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      ensureEmployeeDimensionType(tx, a.company),
    );
    const two = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      ensureEmployeeDimensionType(tx, a.company),
    );
    expect(two).toBe(one);
  });

  it("ensureEmployeeDimensionValue names the employee when there is none to repair", async () => {
    const ghost = await uuidv7(db.admin);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        ensureEmployeeDimensionValue(tx, a.company, ghost),
      ),
    ).rejects.toThrow(new RegExp(`ERR_NOT_FOUND: no employee ${ghost} in company ${a.company}`));
  });

  it("an employee of ANOTHER company of the tenant is not repaired into this company's dimension", async () => {
    const someone = await seedEmployee(db, a, { employeeNumber: "E-0901" });
    const otherCompany = await uuidv7(db.admin);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        ensureEmployeeDimensionValue(tx, otherCompany, someone),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND/);
  });

  it("the schema linter reports zero violations after 0088 (§3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
