import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StaffContextSchema } from "@dulja/contracts/admin/staff-context";
import { grantCodes, seedBranch, seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../support/app";

describe("staff-screen context", () => {
  let api: StartedApi;
  let staff: Seed;
  let foreign: Seed;
  let otherBranch: string;
  let roleId: string;
  beforeAll(async () => {
    api = await startApi();
    staff = await seedTenant(api.db, "Staff context");
    foreign = await seedTenant(api.db, "Foreign staff context");
    otherBranch = await seedBranch(api.db, staff);
    roleId = await grantCodes(api.db, staff, {
      codes: ["pos.cashier.manage_pin"],
      branchIds: [staff.hq],
    });
  });
  afterAll(async () => api.stop());

  it("admits branch PIN authority without granting company administration", async () => {
    const response = await api.request({
      method: "GET",
      path: "/v1/staff-context",
      as: staff.human,
    });
    expect(response.status).toBe(200);
    const context = StaffContextSchema.parse(await response.json());
    expect(context.companies).toHaveLength(1);
    expect(context.companies[0]?.id).toBe(staff.company);
    expect(context.companies[0]?.branches.map((branch) => branch.id)).toEqual([staff.hq]);
    expect(JSON.stringify(context)).not.toContain(otherBranch);
    expect(JSON.stringify(context)).not.toContain(foreign.company);
    const admin = await api.request({ method: "GET", path: "/v1/companies", as: staff.human });
    expect(admin.status).toBe(403);
  });
  it("admits a report-only or branch-policy-only principal to their own branches (PR 12 review)", async () => {
    // 8B T15: the payroll run screens' read code, held alone by the seeded accountant and auditor.
    for (const code of ["pos.report.read", "admin.company.manage", "hr.payroll.read"]) {
      const reader = await seedTenant(api.db, `Context ${code}`);
      const other = await seedBranch(api.db, reader);
      await grantCodes(api.db, reader, { codes: [code], branchIds: [reader.hq] });
      const response = await api.request({
        method: "GET",
        path: "/v1/staff-context",
        as: reader.human,
      });
      expect(response.status, code).toBe(200);
      const context = StaffContextSchema.parse(await response.json());
      expect(context.companies[0]?.branches.map((branch) => branch.id)).toEqual([reader.hq]);
      expect(JSON.stringify(context)).not.toContain(other);
    }
  });
  it("refuses a human without staff authority and anonymous callers", async () => {
    expect(
      (await api.request({ method: "GET", path: "/v1/staff-context", as: foreign.human })).status,
    ).toBe(403);
    expect((await api.request({ method: "GET", path: "/v1/staff-context" })).status).toBe(401);
  });
  it("excludes same-tenant other-company and non-BRANCH dimension values", async () => {
    const companyId = await uuidv7(api.db.admin);
    const branchTypeId = await uuidv7(api.db.admin);
    const branchId = await uuidv7(api.db.admin);
    const departmentTypeId = await uuidv7(api.db.admin);
    const departmentId = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, staff.tenant, staff.system, async (tx) => {
      await tx`insert into app.company(id,tenant_id,code,name,base_currency,timezone)
        values(${companyId},${staff.tenant},'OTHER','Other company','MYR','Asia/Kuala_Lumpur')`;
      await tx`insert into app.dimension_type(id,tenant_id,company_id,code,name_en)
        values(${branchTypeId},${staff.tenant},${companyId},'BRANCH','Branch'),
              (${departmentTypeId},${staff.tenant},${staff.company},'DEPARTMENT','Department')`;
      await tx`insert into app.dimension_value(id,tenant_id,dimension_type_id,code,name_en)
        values(${branchId},${staff.tenant},${branchTypeId},'OTHER','Other branch'),
              (${departmentId},${staff.tenant},${departmentTypeId},'HR','HR')`;
    });
    const response = await api.request({
      method: "GET",
      path: "/v1/staff-context",
      as: staff.human,
    });
    expect(response.status).toBe(200);
    const context = StaffContextSchema.parse(await response.json());
    expect(context.companies.map((company) => company.id)).toEqual([staff.company]);
    expect(context.companies[0]?.branches.map((branch) => branch.id)).toEqual([staff.hq]);
    expect(JSON.stringify(context)).not.toContain(departmentId);
  });
  it("re-evaluates expired assignments instead of retaining selector access", async () => {
    await withTenant(api.db.migrator, staff.tenant, staff.system, async (tx) => {
      await tx`update app.role_assignment set expires_at=now()-interval '1 second'
        where principal_id=${staff.human} and role_id=${roleId} and company_id=${staff.company}`;
    });
    expect(
      (await api.request({ method: "GET", path: "/v1/staff-context", as: staff.human })).status,
    ).toBe(403);
  });
});
