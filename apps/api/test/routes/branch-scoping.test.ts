import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAttendance, withTenant } from "@dulja/db";
import { grantCodes } from "@dulja/db/test";
import { startApi, type StartedApi } from "../support/app";
import {
  staffFixture,
  branchActor,
  type StaffFixture,
} from "../../../../tests/invariants/support/staff";
let api: StartedApi, f: StaffFixture, managerA: string;
const paths = ["employees", "cashiers", "attendance-events", "branch-pos-policies"] as const;
beforeAll(async () => {
  api = await startApi();
  f = await staffFixture(api, "SCOPE-API");
  managerA = await branchActor(
    api.db,
    f.seed,
    f.branchA,
    ["hr.employee.read", "hr.attendance.record", "pos.cashier.manage_pin", "admin.company.manage"],
    "scope-a",
  );
  await withTenant(
    api.db.rw,
    { tenantId: f.seed.tenant, actorId: f.seed.system, requestId: "attendance-setup" },
    async (tx) => {
      for (const branchId of [f.branchA, f.branchB]) {
        const [employee] = await tx<
          { id: string }[]
        >`select id from app.employee where home_branch_id=${branchId} limit 1`;
        await recordAttendance(tx, f.seed.company, {
          employeeId: employee!.id,
          branchId,
          terminalId: null,
          kind: "clock_in",
          occurredAt: "2026-10-09T04:00:00Z",
        });
      }
    },
  );
}, 300_000);
afterAll(async () => api.stop());
describe("acceptance36 endpoint branch scope", () => {
  it.each(paths)("GET %s returns positive A rows and hides B", async (resource) => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${f.seed.company}/${resource}`,
      as: managerA,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { branchId?: string; homeBranchId?: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const row of body.items) expect(row.branchId ?? row.homeBranchId).toBe(f.branchA);
  });
  it("a filter cannot widen branch scope and a by-ID cashier read is indistinguishable from missing", async () => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${f.seed.company}/branch-pos-policies?filter[branchId][eq]=${f.branchB}`,
      as: managerA,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [] });
    for (const id of [f.cashierB, crypto.randomUUID()])
      expect(
        (
          await api.request({
            method: "GET",
            path: `/v1/companies/${f.seed.company}/cashiers/${id}`,
            as: managerA,
          })
        ).status,
      ).toBe(404);
  });
  it("cannot write attendance or branch limits at B using an A grant", async () => {
    const [employee] = await api.db.admin<
      { employee_id: string }[]
    >`select employee_id from app.pos_cashier where principal_id=${f.cashierA}`;
    for (const resource of ["attendance-events", "branch-pos-policies"]) {
      const res = await api.request({
        method: resource === "attendance-events" ? "POST" : "PUT",
        path: `/v1/companies/${f.seed.company}/${resource}`,
        as: managerA,
        body:
          resource === "attendance-events"
            ? {
                employeeId: employee!.employee_id,
                branchId: f.branchB,
                kind: "clock_in",
                occurredAt: "2026-10-09T05:00:00Z",
              }
            : { branchId: f.branchB, maxVoidAmount: "999.0000" },
      });
      expect(res.status).toBe(403);
    }
  });
  it("an unrelated blank assignment at B cannot expose policy or attendance rows when read codes are held only at A", async () => {
    await grantCodes(api.db, f.seed, { principalId: managerA, branchIds: [f.branchB] });
    for (const resource of ["branch-pos-policies", "attendance-events"]) {
      const res = await api.request({
        method: "GET",
        path: `/v1/companies/${f.seed.company}/${resource}`,
        as: managerA,
      });
      expect(res.status).toBe(200);
      const rows = ((await res.json()) as { items: { branchId: string }[] }).items;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.branchId === f.branchA)).toBe(true);
    }
  });
});

describe("branch manager quarantine authority", () => {
  let queueA: string, queueB: string;
  beforeAll(async () => {
    await grantCodes(api.db, f.seed, {
      principalId: managerA,
      branchIds: [f.branchA],
      roleCode: "scope-queue",
      codes: ["pos.needs_attention.resolve"],
    });
    await withTenant(
      api.db.rw,
      { tenantId: f.seed.tenant, actorId: f.seed.system, requestId: "queue-setup" },
      async (tx) => {
        for (const branchId of [f.branchA, f.branchB]) {
          const [row] = await tx<
            { id: string }[]
          >`insert into app.needs_attention(tenant_id,company_id,branch_id,terminal_id,client_ref,payload,error_code,error_detail) values(${f.seed.tenant},${f.seed.company},${branchId},null,${crypto.randomUUID()},'{}'::jsonb,'ERR_POS_LIMIT_EXCEEDED','branch queue proof') returning id`;
          if (branchId === f.branchA) queueA = row!.id;
          else queueB = row!.id;
        }
      },
    );
  });
  it("lists its real A queue while an unrelated B assignment cannot leak B errors", async () => {
    const response = await api.request({
      as: managerA,
      method: "GET",
      path: `/v1/companies/${f.seed.company}/needs-attention?limit=1`,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ id: queueA, branchId: f.branchA }],
      next_cursor: null,
    });
  });
  it("refuses B resolution and stamps successful A resolution with the authenticated manager", async () => {
    const path = `/v1/companies/${f.seed.company}/needs-attention`;
    const other = await api.request({
      as: managerA,
      method: "POST",
      path: `${path}/${queueB}/resolve`,
      body: { note: "cannot reach B" },
    });
    expect(other.status).toBe(404);
    const own = await api.request({
      as: managerA,
      method: "POST",
      path: `${path}/${queueA}/resolve`,
      body: { note: "reviewed own branch" },
    });
    expect(own.status).toBe(204);
    const rows = await api.db.admin<
      { id: string; resolved_by: string | null }[]
    >`select id,resolved_by from app.needs_attention where id=any(${[queueA, queueB]})`;
    expect(rows.find((r) => r.id === queueA)!.resolved_by).toBe(managerA);
    expect(rows.find((r) => r.id === queueB)!.resolved_by).toBeNull();
  });
});

describe("scoped staff gates validate resource keys before SQL casts", () => {
  it("rejects malformed queue row IDs through the shared validator", async () => {
    const response = await api.request({
      as: managerA,
      method: "POST",
      path: `/v1/companies/${f.seed.company}/needs-attention/not-a-uuid/resolve`,
      body: { note: "malformed" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "ERR_VALIDATION_FAILED" });
  });
});
