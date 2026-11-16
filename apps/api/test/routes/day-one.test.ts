/**
 * Full review 2026-11-15, PRD-05..PRD-08 (ADR 0097): the four steps a new shop needed an engineer for on day one —
 * creating a fiscal year, administering a company it just created, editing or terminating an employee, and linking
 * the payroll accounts — each reached through an API route. Every case below failed on `main` (no route: 404, or the
 * new company refused its own creator: 403) before the fix.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  grantCodes,
  seedAccount,
  seedEmployee,
  seedPayComponent,
  seedStatutoryScheme,
  seedTenantV2,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
import { startApi, type StartedApi } from "../support/app";
import { problemOf } from "../../../../tests/support/api";

let api: StartedApi;
let s: Seed;
/** A second company in the SAME tenant, to prove each route binds its path company. */
let other: string;

async function secondCompany(seed: Seed, code: string): Promise<string> {
  const id = await uuidv7(api.db.admin);
  await withTenant(api.db.migrator, seed.tenant, seed.system, async (tx) => {
    await tx`insert into app.company (id, tenant_id, code, name, base_currency)
             values (${id}, ${seed.tenant}, ${code}, ${code}, 'MYR')`;
  });
  return id;
}

const employeePath = (id: string, company = s.company) =>
  `/v1/companies/${company}/employees/${id}`;
const yearPath = (company = s.company) => `/v1/companies/${company}/fiscal-years`;
const linkPath = (company = s.company) => `/v1/companies/${company}/payroll-accounts`;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "DAY-ONE");
  other = await secondCompany(s, "OTHER");
}, 180_000);
afterAll(async () => api.stop());

describe("PRD-05 — POST /v1/companies/{companyId}/fiscal-years", () => {
  let closer: string;
  beforeAll(async () => {
    closer = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${closer}, 'human', ${`closer:${closer}`}, 'closer')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${closer})`;
    });
    await grantCodes(api.db, s, { codes: ["accounting.period.close"], principalId: closer });
  });
  const periodsOf = (company: string, from: string, to: string) =>
    api.db.admin<{ starts_on: string; ends_on: string; status: string }[]>`
      select starts_on::text, ends_on::text, status::text from app.fiscal_period
       where company_id = ${company} and starts_on between ${from}::date and ${to}::date order by starts_on`;

  it("creates the year's twelve open monthly periods, and a repeat creates nothing", async () => {
    const res = await api.request({
      method: "POST",
      path: yearPath(),
      as: closer,
      body: { fiscalYear: 2027, startMonth: 1 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { inserted: number; items: { startsOn: string }[] };
    expect(body.inserted).toBe(12);
    expect(body.items.map((p) => p.startsOn)).toEqual(
      Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, "0")}-01`),
    );
    const rows = await periodsOf(s.company, "2027-01-01", "2027-12-31");
    expect(rows).toHaveLength(12);
    expect(rows[1]).toEqual({ starts_on: "2027-02-01", ends_on: "2027-02-28", status: "open" });
    expect(rows.every((r) => r.status === "open")).toBe(true);

    const again = await api.request({
      method: "POST",
      path: yearPath(),
      as: closer,
      body: { fiscalYear: 2027, startMonth: 1 },
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { inserted: number }).inserted).toBe(0);
    expect(await periodsOf(s.company, "2027-01-01", "2027-12-31")).toHaveLength(12);
  });

  it("takes the start month from the company's existing periods when it is omitted", async () => {
    const res = await api.request({
      method: "POST",
      path: yearPath(),
      as: closer,
      body: { fiscalYear: 2028 },
    });
    expect(res.status).toBe(201);
    expect((await periodsOf(s.company, "2028-01-01", "2028-12-31"))[0]?.starts_on).toBe(
      "2028-01-01",
    );
  });

  it("a fiscal year that starts mid-calendar spans two calendar years", async () => {
    const c = await secondCompany(s, "JULY");
    await grantCodes(
      api.db,
      { ...s, company: c },
      {
        codes: ["accounting.period.close"],
        principalId: closer,
      },
    );
    const res = await api.request({
      method: "POST",
      path: yearPath(c),
      as: closer,
      body: { fiscalYear: 2026, startMonth: 7 },
    });
    expect(res.status).toBe(201);
    const rows = await periodsOf(c, "2026-01-01", "2027-12-31");
    expect(rows.at(0)?.starts_on).toBe("2026-07-01");
    expect(rows.at(-1)?.ends_on).toBe("2027-06-30");
  });

  it("refuses a year that overlaps a period with other bounds, and writes nothing", async () => {
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.fiscal_period (tenant_id, company_id, starts_on, ends_on, status)
               values (${s.tenant}, ${s.company}, '2029-04-01', '2029-06-30', 'open')`;
    });
    const res = await api.request({
      method: "POST",
      path: yearPath(),
      as: closer,
      body: { fiscalYear: 2029, startMonth: 1 },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
    expect(await periodsOf(s.company, "2029-01-01", "2029-12-31")).toHaveLength(1);
  });

  it("asks for the start month when the company has no period to take it from", async () => {
    const c = await secondCompany(s, "EMPTY");
    await grantCodes(
      api.db,
      { ...s, company: c },
      {
        codes: ["accounting.period.close"],
        principalId: closer,
      },
    );
    const res = await api.request({
      method: "POST",
      path: yearPath(c),
      as: closer,
      body: { fiscalYear: 2026 },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("is refused without accounting.period.close, and in a company the caller holds it nowhere", async () => {
    const reader = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${reader}, 'human', ${`reader:${reader}`}, 'reader')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${reader})`;
    });
    await grantCodes(api.db, s, { codes: ["accounting.ledger.read"], principalId: reader });
    const body = { fiscalYear: 2030, startMonth: 1 };
    expect((await api.request({ method: "POST", path: yearPath(), as: reader, body })).status).toBe(
      403,
    );
    expect(
      (await api.request({ method: "POST", path: yearPath(other), as: closer, body })).status,
    ).toBe(403);
    expect(await periodsOf(other, "2030-01-01", "2030-12-31")).toHaveLength(0);
  });
});

describe("PRD-06 — a company created through the API is administered by its creator", () => {
  let creator: Seed;
  beforeAll(async () => {
    creator = await seedTenantV2(api.db, "DAY-ONE-CO");
    await grantCodes(api.db, creator, { codes: ["admin.company.manage"] });
    // The tenant's `admin` role, as the roles loader seeds it (here with the two codes the case reads).
    await grantCodes(api.db, creator, {
      roleCode: "admin",
      codes: ["admin.company.manage", "admin.role.assign"],
      principalId: await otherHuman(creator),
    });
  });

  async function otherHuman(seed: Seed): Promise<string> {
    const id = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, seed.tenant, seed.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${id}, 'human', ${`owner:${id}`}, 'owner')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${seed.tenant}, ${id})`;
    });
    return id;
  }

  it("assigns the creator the tenant's admin role in the new company, the creator's own grant refused by R5 notwithstanding", async () => {
    const res = await api.request({
      method: "POST",
      path: "/v1/companies",
      as: creator.human,
      body: { code: "SECOND", name: "Second company", baseCurrency: "MYR" },
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const assignments = await api.db.admin<{ code: string }[]>`
      select r.code from app.role_assignment ra
        join app.role r on r.id = ra.role_id
       where ra.principal_id = ${creator.human} and ra.company_id = ${id} and ra.expires_at is null`;
    expect(assignments.map((a) => a.code)).toEqual(["admin"]);

    // The creator now administers what they created: before the fix this was 403, since nobody held a code there.
    const patch = await api.request({
      method: "PATCH",
      path: `/v1/companies/${id}`,
      as: creator.human,
      body: { name: "Second company, renamed" },
    });
    expect(patch.status).toBe(200);
  });
});

describe("PRD-07 — PATCH …/employees/{id} and POST …/employees/{id}/terminate", () => {
  let employee: string;
  let staff: string;
  beforeAll(async () => {
    await grantCodes(api.db, s, { codes: ["hr.employee.read", "hr.employee.manage"] });
    staff = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${staff}, 'human', ${`staff:${staff}`}, 'staff')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${staff})`;
    });
    await grantCodes(api.db, s, { codes: ["accounting.ledger.read"], principalId: staff });
    employee = await seedEmployee(api.db, s, {
      employeeNumber: "E-DAY1",
      principalId: staff,
      hiredOn: "2026-01-05",
    });
  });

  it("edits the non-sensitive fields, the name through the employee's party", async () => {
    const res = await api.request({
      method: "PATCH",
      path: employeePath(employee),
      as: s.human,
      body: {
        nameEn: "Aina binti Ali",
        position: "Cashier",
        employmentType: "part_time",
        hiredOn: "2026-01-06",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: employee,
      position: "Cashier",
      employmentType: "part_time",
      hiredOn: "2026-01-06",
      terminatedOn: null,
    });
    const [party] = await api.db.admin<{ name_en: string }[]>`
      select p.name_en from app.party p join app.employee e on e.party_id = p.id where e.id = ${employee}`;
    expect(party?.name_en).toBe("Aina binti Ali");
  });

  it("refuses a field the route does not edit (number, branch, termination, a sensitive field)", async () => {
    for (const body of [
      { employeeNumber: "E-OTHER" },
      { homeBranchId: s.hq },
      { terminatedOn: "2026-02-01" },
      { nationalId: "900101-01-1234" },
    ]) {
      const res = await api.request({
        method: "PATCH",
        path: employeePath(employee),
        as: s.human,
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("terminates through the 0093 trigger: the date is set and the person's role assignments expire", async () => {
    const early = await api.request({
      method: "POST",
      path: `${employeePath(employee)}/terminate`,
      as: s.human,
      body: { terminatedOn: "2025-12-31" },
    });
    expect(early.status).toBe(400);

    const res = await api.request({
      method: "POST",
      path: `${employeePath(employee)}/terminate`,
      as: s.human,
      body: { terminatedOn: "2026-03-31" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { terminatedOn: string }).terminatedOn).toBe("2026-03-31");
    const live = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_assignment
       where principal_id = ${staff} and (expires_at is null or expires_at > now())`;
    expect(live[0]?.n).toBe(0);

    const listed = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/employees?filter[active][eq]=false`,
      as: s.human,
    });
    const ids = ((await listed.json()) as { items: { id: string }[] }).items.map((e) => e.id);
    expect(ids).toContain(employee);
  });

  it("binds the path company: an employee is not found through another company's path", async () => {
    const victim = await seedEmployee(api.db, s, { employeeNumber: "E-VICTIM" });
    // A BRANCH in the other company, so the directory gate admits the caller there and the refusal below is the
    // company-bound lookup's, not the gate's.
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      const [type] = await tx<{ id: string }[]>`
        insert into app.dimension_type (tenant_id, company_id, code, name_en)
        values (${s.tenant}, ${other}, 'BRANCH', 'Branch') returning id::text as id`;
      await tx`insert into app.dimension_value (tenant_id, dimension_type_id, code, name_en)
               values (${s.tenant}, ${type!.id}, 'HQ', 'Head office')`;
    });
    await grantCodes(
      api.db,
      { ...s, company: other },
      {
        codes: ["hr.employee.read", "hr.employee.manage"],
      },
    );
    const patch = await api.request({
      method: "PATCH",
      path: employeePath(victim, other),
      as: s.human,
      body: { nameEn: "renamed" },
    });
    expect(patch.status).toBe(404);
    const term = await api.request({
      method: "POST",
      path: `${employeePath(victim, other)}/terminate`,
      as: s.human,
      body: { terminatedOn: "2026-03-31" },
    });
    expect(term.status).toBe(404);
    const [row] = await api.db.admin<{ terminated_on: string | null }[]>`
      select terminated_on::text from app.employee where id = ${victim}`;
    expect(row?.terminated_on).toBeNull();
  });
});

describe("PRD-08 — POST /v1/companies/{companyId}/payroll-accounts", () => {
  let component: string;

  it("names the missing codes and links nothing while the chart lacks them", async () => {
    await grantCodes(api.db, s, { codes: ["hr.pay_component.manage"] });
    component = await seedPayComponent(api.db, s, { code: "BASIC-D1", kind: "earning" });
    const res = await api.request({ method: "POST", path: linkPath(), as: s.human, body: {} });
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_POLICY_REQUIRES_MISSING");
    expect(problem.detail).toContain("5300");
  });

  it("links the pay components and schemes to the §4.15 accounts, idempotently", async () => {
    const salaries = await seedAccount(api.db, s, {
      code: "5300",
      nameEn: "Salaries",
      type: "expense",
    });
    const payable = await seedAccount(api.db, s, {
      code: "2411",
      nameEn: "EPF payable",
      type: "liability",
    });
    const expense = await seedAccount(api.db, s, {
      code: "5311",
      nameEn: "EPF employer",
      type: "expense",
    });
    const scheme = await seedStatutoryScheme(api.db, s, { code: "EPF" });
    const res = await api.request({ method: "POST", path: linkPath(), as: s.human, body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      componentsLinked: 1,
      schemesLinked: 1,
      missingCodes: [],
    });
    const [pc] = await api.db.admin<{ a: string }[]>`
      select expense_account_id::text as a from app.pay_component where id = ${component}`;
    expect(pc?.a).toBe(salaries);
    const [sc] = await api.db.admin<{ p: string; e: string }[]>`
      select payable_account_id::text as p, employer_expense_account_id::text as e
        from app.statutory_scheme where id = ${scheme}`;
    expect(sc).toEqual({ p: payable, e: expense });

    const again = await api.request({ method: "POST", path: linkPath(), as: s.human, body: {} });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ componentsLinked: 0, schemesLinked: 0 });
  });

  it("is refused in a company the caller holds no hr.pay_component.manage in", async () => {
    const res = await api.request({ method: "POST", path: linkPath(other), as: s.human, body: {} });
    expect(res.status).toBe(403);
  });
});
