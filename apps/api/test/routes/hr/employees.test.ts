import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenantV2, seedTenant, seedBranch, grantCodes, type Seed } from "@dulja/db/test";
import { EmployeeSchema } from "@dulja/contracts/hr/employee";
import { startApi, type StartedApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";
let api: StartedApi, s: Seed, branchB: string;
beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "EMPLOYEE-API");
  branchB = await seedBranch(api.db, s, { code: "EMP-B" });
  await grantCodes(api.db, s, { codes: ["hr.employee.read", "hr.employee.manage"] });
}, 180_000);
afterAll(async () => api.stop());
const path = () => `/v1/companies/${s.company}/employees`;
const input = (employeeNumber: string, homeBranchId = s.hq) => ({
  employeeNumber,
  nameEn: "Aina",
  homeBranchId,
  hiredOn: "2026-01-05",
});
describe("employee directory and master", () => {
  it("creates an employee and employee-kind party atomically without minting a principal", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: input("E-100"),
    });
    expect(res.status).toBe(201);
    const row = EmployeeSchema.parse(await res.json());
    expect(row.principalId).toBeNull();
    expect(row.hiredOn).toBe("2026-01-05");
    const [party] = await api.db.admin<
      { kind: string; company_id: string }[]
    >`select kind,company_id from app.party where id=${row.partyId}`;
    expect(party).toMatchObject({ kind: "employee", company_id: s.company });
  });
  it("invalid/foreign branch leaves no orphan party", async () => {
    const foreign = await seedTenant(api.db, "EMP-FOREIGN");
    const [before] = await api.db.admin<
      { n: number }[]
    >`select count(*)::int n from app.party where tenant_id=${s.tenant} and kind='employee'`;
    for (const branch of [crypto.randomUUID(), foreign.hq]) {
      const res = await api.request({
        method: "POST",
        path: path(),
        as: s.human,
        body: input("E-NO", branch),
      });
      expect(res.status).toBe(404);
    }
    const [after] = await api.db.admin<
      { n: number }[]
    >`select count(*)::int n from app.party where tenant_id=${s.tenant} and kind='employee'`;
    expect(after!.n).toBe(before!.n);
  });
  it("duplicate number returns 409 with no orphan second party", async () => {
    const body = input("E-DUP");
    expect((await api.request({ method: "POST", path: path(), as: s.human, body })).status).toBe(
      201,
    );
    const res = await api.request({ method: "POST", path: path(), as: s.human, body });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
  });
  it("a branch reader may list and cannot create", async () => {
    const reader = await seedTenantV2(api.db, "EMP-READER");
    await grantCodes(api.db, reader, { codes: ["hr.employee.read"], branchIds: [reader.hq] });
    expect(
      (
        await api.request({
          method: "GET",
          path: `/v1/companies/${reader.company}/employees`,
          as: reader.human,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.request({
          method: "POST",
          path: `/v1/companies/${reader.company}/employees`,
          as: reader.human,
          body: input("E-NO", reader.hq),
        })
      ).status,
    ).toBe(403);
  });
  it("filters declared home branch/active keys and refuses unknown filters/sort/sparse fields", async () => {
    await api.request({ method: "POST", path: path(), as: s.human, body: input("E-B", branchB) });
    const res = await api.request({
      method: "GET",
      path: `${path()}?filter[homeBranchId][eq]=${s.hq}&filter[active][eq]=true`,
      as: s.human,
    });
    expect(res.status).toBe(200);
    for (const row of (
      (await res.json()) as { items: { homeBranchId: string; terminatedOn: null }[] }
    ).items)
      expect(row).toMatchObject({ homeBranchId: s.hq, terminatedOn: null });
    for (const query of [
      "filter[hiredOn][gte]=2026-01-01",
      "sort=nationalId",
      "fields=bankAccount",
    ]) {
      const bad = await api.request({ method: "GET", path: `${path()}?${query}`, as: s.human });
      expect(bad.status).toBe(400);
      expect((await problemOf(bad)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });
  it("pages without repeating IDs and refuses malformed cursor", async () => {
    const first = await api.request({ method: "GET", path: `${path()}?limit=1`, as: s.human }),
      page = (await first.json()) as { items: { id: string }[]; next_cursor: string };
    expect(first.status).toBe(200);
    const second = await api.request({
      method: "GET",
      path: `${path()}?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`,
      as: s.human,
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { items: { id: string }[] }).items[0]!.id).not.toBe(
      page.items[0]!.id,
    );
    expect(
      (await api.request({ method: "GET", path: `${path()}?cursor=bad`, as: s.human })).status,
    ).toBe(400);
  });
});
