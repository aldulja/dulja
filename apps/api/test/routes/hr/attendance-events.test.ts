import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi, type StartedApi } from "../../support/app";
import {
  seedTenant,
  seedTenantV2,
  seedEmployee,
  seedBranch,
  grantCodes,
  type Seed,
  uuidv7,
  withTenant,
} from "@dulja/db/test";
import { AttendanceEventSchema } from "@dulja/contracts/hr/attendance";
import { encodeCursor } from "@dulja/contracts";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
let api: StartedApi;
let s: Seed;
let employee: string;
let branchA: string;
beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "Attendance");
  branchA = await seedBranch(api.db, s, { code: "ATT-HOME" });
  employee = await seedEmployee(api.db, s, { employeeNumber: "ATT-API", homeBranchId: branchA });
  await grantAdmin(api, s);
  await grantCodes(api.db, s, { codes: ["hr.attendance.record", "hr.employee.read"] });
  await api.loadPrincipals();
}, 180_000);
afterAll(async () => api.stop());
const path = () => `/v1/companies/${s.company}/attendance-events`;
const clock = () => ({
  employeeId: employee,
  kind: "clock_in",
  occurredAt: "2026-01-15T01:00:00.123456Z",
});
describe("POST|GET attendance events", () => {
  it("attributes to the employee and stamps the caller, defaulting to the home branch", async () => {
    const res = await api.request({ method: "POST", path: path(), as: s.human, body: clock() });
    expect(res.status).toBe(201);
    const body = AttendanceEventSchema.parse(await res.json());
    expect(body).toMatchObject({
      employeeId: employee,
      recordedBy: s.human,
      branchId: branchA,
      terminalId: null,
      occurredAt: "2026-01-15T01:00:00.123456Z",
    });
  });
  it("refuses another tenant or same-tenant other-company employee without confirming existence", async () => {
    const other = await seedTenant(api.db, "ATT-FOREIGN");
    const foreign = await seedEmployee(api.db, other, { employeeNumber: "ATT-X" });
    const company = await uuidv7(api.db.admin),
      branchType = await uuidv7(api.db.admin),
      home = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.company(id,tenant_id,code,name,base_currency) values(${company},${s.tenant},'ATT-OTHER','Other','MYR')`;
      await tx`insert into app.dimension_type(id,tenant_id,company_id,code,name_en) values(${branchType},${s.tenant},${company},'BRANCH','Branch')`;
      await tx`insert into app.dimension_value(id,tenant_id,dimension_type_id,code,name_en) values(${home},${s.tenant},${branchType},'HQ','HQ')`;
    });
    const sameTenant = await seedEmployee(
      api.db,
      { ...s, company, hq: home },
      { employeeNumber: "ATT-SAME-TENANT" },
    );
    for (const id of [foreign, sameTenant]) {
      const res = await api.request({
        method: "POST",
        path: path(),
        as: s.human,
        body: { ...clock(), employeeId: id },
      });
      expect(res.status).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
    }
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${other.company}/attendance-events`,
      as: s.human,
      body: clock(),
    });
    expect(res.status).toBe(403);
  });
  it("a reader can list but cannot record", async () => {
    const reader = await seedTenantV2(api.db, "ATT-READER");
    await grantCodes(api.db, reader, { codes: ["hr.employee.read"] });
    await api.loadPrincipals();
    expect(
      (
        await api.request({
          method: "GET",
          path: `/v1/companies/${reader.company}/attendance-events`,
          as: reader.human,
        })
      ).status,
    ).toBe(200);
    const write = await api.request({
      method: "POST",
      path: `/v1/companies/${reader.company}/attendance-events`,
      as: reader.human,
      body: clock(),
    });
    expect(write.status).toBe(403);
    expect((await problemOf(write)).code).toBe("ERR_RBAC_FORBIDDEN");
  });
  it("honours employee and date filters and pages without leaking internal fields", async () => {
    await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: { ...clock(), kind: "clock_out", occurredAt: "2026-01-15T09:00:00Z" },
    });
    const filter = `filter[employeeId][eq]=${employee}&filter[occurredAt][gte]=2026-01-15T00:00:00Z&filter[occurredAt][lt]=2026-01-16T00:00:00Z`;
    const res = await api.request({
      method: "GET",
      path: `${path()}?${filter}&limit=1`,
      as: s.human,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; employeeId: string }[];
      next_cursor: string | null;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.employeeId).toBe(employee);
    expect(body.next_cursor).toBeTruthy();
    expect(body.items[0]).not.toHaveProperty("createdAt");
    const next = await api.request({
      method: "GET",
      path: `${path()}?${filter}&limit=1&cursor=${encodeURIComponent(body.next_cursor!)}`,
      as: s.human,
    });
    const page = (await next.json()) as typeof body;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.id).not.toBe(body.items[0]!.id);
  });
  it("requires the idempotency key", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: clock(),
      idempotencyKey: null,
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });
  it("refuses forged attribution and malformed cursor as registered Problems", async () => {
    const forged = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: { ...clock(), recordedBy: s.system },
    });
    expect(forged.status).toBe(400);
    expect((await problemOf(forged)).code).toBe("ERR_VALIDATION_FAILED");
    const malformed = await api.request({
      method: "GET",
      path: `${path()}?cursor=${encodeCursor({ k: ["wrong"], id: employee })}`,
      as: s.human,
    });
    expect(malformed.status).toBe(400);
    expect((await problemOf(malformed)).code).toBe("ERR_VALIDATION_FAILED");
  });
});
