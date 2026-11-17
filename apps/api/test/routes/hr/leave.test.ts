import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCodes, seedBranch, uuidv7, withTenant } from "@dulja/db/test";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api"; // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

// 8D Task 8 — ⚠️ OD-13 answered BUILD on 2026-11-07 (contracts round 19, 8D A14): the leave register through the API,
// and test 31's leave clause (R4, spec:2175) on the API path. The data-layer proof is packages/db/test/hr/leave.test.ts.

describe("/v1/companies/{companyId}/leave-records — ⚠️ OD-13; test 31's leave clause", () => {
  let f: HrFixture;
  /** A different principal holding hr.leave.approve and hr.employee.read. */
  let approver: string;
  /** Holds hr.leave.record and hr.employee.read only — never hr.leave.approve. */
  let clerk: string;
  let typeId: string;
  let otherEmployeeId: string;
  /** E-1003, whose principal IS the officer: the R4 subject (hrFixture's own). */
  let selfEmployeeId: string;

  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-leave");
    const mint = async (name: string) => {
      const id = await uuidv7(f.db.admin);
      await withTenant(f.db.migrator, f.seed.tenant, f.seed.system, async (tx) => {
        await tx`insert into app.principal (id, auth_subject, kind, display_name)
                 values (${id}, ${`human:hr-leave:${id}`}, 'human', ${name})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${f.seed.tenant}, ${id})`;
      });
      return id;
    };
    approver = await mint("Leave approver");
    clerk = await mint("Leave clerk");
    // The officer records AND approves (a one-person HR office, hr_payroll's seeded shape) — R4 still refuses its own.
    await grantCodes(f.db, f.seed, {
      codes: ["hr.leave.record", "hr.leave.approve"],
      principalId: f.officer,
      roleCode: "hr-leave-officer",
    });
    await grantCodes(f.db, f.seed, {
      codes: ["hr.leave.approve", "hr.employee.read"],
      principalId: approver,
      roleCode: "hr-leave-approver",
    });
    await grantCodes(f.db, f.seed, {
      codes: ["hr.leave.record", "hr.employee.read"],
      principalId: clerk,
      roleCode: "hr-leave-clerk",
    });
    await f.api.loadPrincipals();
    otherEmployeeId = f.employees[0]!.id;
    selfEmployeeId = f.employees.find((e) => e.principalId === f.officer)!.id;
    const created = await f.api.request({
      method: "POST",
      path: `${base()}/types`,
      as: f.officer,
      body: { code: "annual", nameEn: "Annual leave", nameAr: "إجازة سنوية", paid: true },
    });
    expect(created.status).toBe(201);
    typeId = ((await created.json()) as { id: string }).id;
  }, 300_000);
  afterAll(async () => {
    await f.api.stop();
  });

  const base = () => `/v1/companies/${f.companyId}/leave-records`;
  const request = (employeeId: string, startsOn: string, endsOn: string, as = f.officer) =>
    f.api.request({
      method: "POST",
      path: base(),
      as,
      body: { employeeId, leaveTypeId: typeId, startsOn, endsOn, days: "2.00", reason: "family" },
    });
  const decide = (id: string, as: string, decision: "approved" | "rejected", reason?: string) =>
    f.api.request({
      method: "POST",
      path: `${base()}/${id}/decision`,
      as,
      body: reason === undefined ? { decision } : { decision, reason },
    });

  it("a clerk requests leave: 201 at status requested with no decider", async () => {
    const res = await request(otherEmployeeId, "2026-04-01", "2026-04-02", clerk);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      approvedBy: string | null;
      employeeNumber: string;
      leaveTypeCode: string;
      days: string;
    };
    expect(body).toMatchObject({
      status: "requested",
      approvedBy: null,
      employeeNumber: "E-1001",
      leaveTypeCode: "annual",
      days: "2.00",
    });
  });

  it("test 31 — approving one's OWN leave is 409 ERR_HR_SELF_PAY even with hr.leave.approve (R4, spec:2175)", async () => {
    const created = (await (await request(selfEmployeeId, "2026-05-01", "2026-05-02")).json()) as {
      id: string;
    };
    const res = await decide(created.id, f.officer, "approved");
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_HR_SELF_PAY");
    // …and a DIFFERENT principal's approval succeeds, stamped from the session, never from the body.
    const ok = await decide(created.id, approver, "approved");
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { status: string; approvedBy: string }).toMatchObject({
      status: "approved",
      approvedBy: approver,
    });
  });

  it("a decision body naming a decider is refused — approvedBy is never the caller's (LEGACY-044)", async () => {
    const created = (await (await request(otherEmployeeId, "2026-05-11", "2026-05-12")).json()) as {
      id: string;
    };
    const res = await f.api.request({
      method: "POST",
      path: `${base()}/${created.id}/decision`,
      as: approver,
      body: { decision: "approved", approvedBy: f.officer },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a decided record is final: a second decision is 409 ERR_TABLE_IMMUTABLE and the first stands", async () => {
    const created = (await (await request(otherEmployeeId, "2026-06-01", "2026-06-02")).json()) as {
      id: string;
    };
    const rejected = await decide(created.id, approver, "rejected", "no cover");
    expect(rejected.status).toBe(200);
    expect((await rejected.json()) as { status: string; reason: string }).toMatchObject({
      status: "rejected",
      reason: "no cover",
    });
    const again = await decide(created.id, f.officer, "approved");
    expect(again.status).toBe(409);
    expect((await problemOf(again)).code).toBe("ERR_TABLE_IMMUTABLE");
  });

  it("a principal without hr.leave.approve is refused at the gate with 403", async () => {
    const created = (await (await request(otherEmployeeId, "2026-08-01", "2026-08-02")).json()) as {
      id: string;
    };
    const res = await decide(created.id, clerk, "approved");
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("a decision on an id this company does not hold is 404, never someone else's row", async () => {
    const res = await decide(await uuidv7(f.db.admin), approver, "approved");
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("an employee unknown to the company is 404; a bad span is 400 naming the field", async () => {
    const unknown = await request(await uuidv7(f.db.admin), "2026-09-01", "2026-09-02");
    expect(unknown.status).toBe(404);
    expect((await problemOf(unknown)).code).toBe("ERR_NOT_FOUND");
    for (const [startsOn, endsOn, days, field] of [
      ["2026-09-03", "2026-09-02", "1.00", "endsOn"],
      ["2026-09-01", "2026-09-02", "3.00", "days"],
      ["2026-09-01", "2026-09-01", "0.00", "days"],
    ] as const) {
      const res = await f.api.request({
        method: "POST",
        path: base(),
        as: f.officer,
        body: { employeeId: otherEmployeeId, leaveTypeId: typeId, startsOn, endsOn, days },
      });
      expect(res.status, `${startsOn}..${endsOn} ${days}`).toBe(400);
      const p = await problemOf(res);
      expect(p.code).toBe("ERR_VALIDATION_FAILED");
      expect(JSON.stringify(p.errors ?? p.detail)).toContain(field);
    }
  });

  it("the register: hr.employee.read reads it, filter[status][eq] narrows it, and a stranger is 403", async () => {
    const res = await f.api.request({
      method: "GET",
      path: `${base()}?filter%5Bstatus%5D%5Beq%5D=approved`,
      as: f.outsider, // holds hr.employee.read only
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { status: string }[]; next_cursor: null };
    expect(body.items.length).toBeGreaterThan(0);
    for (const i of body.items) expect(i.status).toBe("approved");
    expect(body.next_cursor).toBeNull();
    const undeclared = await f.api.request({
      method: "GET",
      path: `${base()}?filter%5Breason%5D%5Beq%5D=x`,
      as: f.officer,
    });
    expect(undeclared.status).toBe(400);
    const stranger = await f.api.request({
      method: "GET",
      path: `${base()}/types`,
      as: f.outsider,
    });
    expect(stranger.status).toBe(403); // the leave configuration is hr.leave.record's, not the directory's
  });

  it("POST /types creates a type, GET /types lists it, and a duplicate code is 409", async () => {
    const created = await f.api.request({
      method: "POST",
      as: f.officer,
      path: `${base()}/types`,
      body: { code: "sick", nameEn: "Sick leave", nameAr: "إجازة مرضية" },
    });
    expect(created.status).toBe(201);
    expect(
      (await created.json()) as { code: string; paid: boolean; archivedAt: null },
    ).toMatchObject({ code: "sick", paid: true, archivedAt: null });
    const listed = await f.api.request({ method: "GET", as: clerk, path: `${base()}/types` });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { items: { code: string }[]; next_cursor: null };
    expect(body.items.map((i) => i.code)).toEqual(["annual", "sick"]);
    expect(body.next_cursor).toBeNull();
    const dup = await f.api.request({
      method: "POST",
      as: f.officer,
      path: `${base()}/types`,
      body: { code: "sick", nameEn: "Sick leave again", nameAr: null, paid: true },
    });
    expect(dup.status).toBe(409);
    expect((await problemOf(dup)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("PUT /entitlements is an upsert on the natural key and returns THAT row", async () => {
    const put = (days: string) =>
      f.api.request({
        method: "PUT",
        as: clerk,
        path: `${base()}/entitlements`,
        body: { employeeId: otherEmployeeId, year: 2026, leaveTypeId: typeId, days },
      });
    const first = await put("14.00");
    expect(first.status).toBe(200);
    expect(((await first.json()) as { days: string }).days).toBe("14.00");
    // The same key REPLACES the figure — no accrual engine (spec:2085), so 14 then 16 is never 30.
    const second = await put("16.00");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      employeeId: otherEmployeeId,
      employeeNumber: "E-1001",
      year: 2026,
      leaveTypeId: typeId,
      leaveTypeCode: "annual",
      days: "16.00",
    });
    const listed = await f.api.request({
      method: "GET",
      as: clerk,
      path: `${base()}/entitlements?filter%5Bemployee_id%5D%5Beq%5D=${otherEmployeeId}`,
    });
    const body = (await listed.json()) as { items: { days: string }[] };
    expect(body.items.map((i) => i.days)).toEqual(["16.00"]);
    const unknown = await f.api.request({
      method: "PUT",
      as: clerk,
      path: `${base()}/entitlements`,
      body: { employeeId: await uuidv7(f.db.admin), year: 2026, leaveTypeId: typeId, days: "1.00" },
    });
    expect(unknown.status).toBe(404);
  });

  it("POST /holidays refuses a second COMPANY-WIDE holiday on one date (nulls not distinct) and a foreign branch", async () => {
    const holiday = (branchId: string | null, holidayOn: string, nameEn: string) =>
      f.api.request({
        method: "POST",
        as: f.officer,
        path: `${base()}/holidays`,
        body: { branchId, holidayOn, nameEn, nameAr: null },
      });
    const created = await holiday(null, "2026-08-31", "National Day");
    expect(created.status).toBe(201);
    expect(((await created.json()) as { branchId: string | null }).branchId).toBeNull();
    const dup = await holiday(null, "2026-08-31", "National Day (again)");
    expect(dup.status).toBe(409);
    expect((await problemOf(dup)).code).toBe("ERR_CONFLICT_UNIQUE");
    // A branch of this company on the same date is a different row …
    const branch = await holiday(f.seed.hq, "2026-08-31", "Head office");
    expect(branch.status).toBe(201);
    // … and a dimension value that is no branch of this company is 404.
    const foreign = await holiday(await seedBranchOfAnotherCompany(), "2026-09-01", "Elsewhere");
    expect(foreign.status).toBe(404);
    const listed = await f.api.request({
      method: "GET",
      as: clerk,
      path: `${base()}/holidays?filter%5Bholiday_on%5D%5Bgte%5D=2026-08-01&filter%5Bholiday_on%5D%5Blte%5D=2026-08-31`,
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      items: { holidayOn: string; branchId: string | null }[];
      next_cursor: null;
    };
    expect(body.items.map((i) => [i.holidayOn, i.branchId])).toEqual([
      ["2026-08-31", null],
      ["2026-08-31", f.seed.hq],
    ]);
  });

  /** A BRANCH dimension value of a SECOND company of the same tenant — RLS admits it, the company bind must not. */
  async function seedBranchOfAnotherCompany(): Promise<string> {
    return seedBranch(
      f.db,
      { ...f.seed, branchType: await otherCompanyBranchType() },
      { code: "ELSE" },
    );
  }
  async function otherCompanyBranchType(): Promise<string> {
    return withTenant(f.db.migrator, f.seed.tenant, f.seed.system, async (tx) => {
      const [c] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${f.seed.tenant}, 'LEAVE-SIBLING', 'Sibling company', 'MYR') returning id`;
      const [t] = await tx<{ id: string }[]>`
        insert into app.dimension_type (tenant_id, company_id, code, name_en)
        values (${f.seed.tenant}, ${c!.id}, 'BRANCH', 'Branch') returning id`;
      return t!.id;
    });
  }
});
