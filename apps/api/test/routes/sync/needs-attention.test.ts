import { NeedsAttentionList } from "@dulja/contracts/sync/needs-attention";
import { encodeCursor, type Problem } from "@dulja/contracts";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import {
  buildTicket,
  posFixture,
  syncRequest,
  uuidv7Sync,
  type PosFixture,
} from "../../../../../tests/invariants/support/pos";

describe("manager queue preserves company scope and actor attribution", () => {
  let api: StartedApi;
  let f: PosFixture;
  let rowId: string;
  beforeAll(async () => {
    api = await startApi();
    f = await posFixture(api, "Needs attention");
    await grantCodes(api.db, f.s, {
      principalId: f.supervisorId,
      roleCode: "queue-manager",
      codes: ["pos.needs_attention.resolve"],
    });
    const ticket = buildTicket(f, { cashierPrincipalId: f.s.system });
    await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: {
        terminalId: f.terminal.terminalId,
        batchId: uuidv7Sync(),
        tickets: [ticket, buildTicket(f, { cashierPrincipalId: f.s.system })],
        shifts: [],
        tillEvents: [],
      },
    });
    rowId = (
      await api.db.admin<
        { id: string }[]
      >`select id from app.needs_attention where client_ref=${ticket.clientRef}`
    )[0]!.id;
  }, 240000);
  afterAll(async () => api.stop());
  const base = () => `/v1/companies/${f.s.company}/needs-attention`;
  it("lists exact ISO timestamps without payload and returns the registered cursor key", async () => {
    const res = await api.request({ as: f.supervisorId, method: "GET", path: base() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; createdAt: string }[] };
    expect(Object.keys(body).toSorted()).toEqual(["items", "next_cursor"]);
    expect(body.items).toHaveLength(2);
    const row = body.items.find((item) => item.id === rowId)!;
    expect(row).toBeDefined();
    expect(row.createdAt).toMatch(/Z$/);
    expect("payload" in row).toBe(false);
  });
  it("rejects malformed keysets before database casts", async () => {
    for (const cursor of [
      { k: [], id: rowId },
      { k: ["not-a-date"], id: rowId },
      { k: ["2026-01-01T00:00:00.000Z"], id: "bad-id" },
    ]) {
      const response = await api.request({
        as: f.supervisorId,
        method: "GET",
        path: `${base()}?cursor=${encodeURIComponent(encodeCursor(cursor))}`,
      });
      expect(response.status).toBe(400);
    }
  });
  it("pages both rows exactly once using the returned keyset", async () => {
    const first = await api.request({
      as: f.supervisorId,
      method: "GET",
      path: `${base()}?limit=1`,
    });
    expect(first.status).toBe(200);
    const page = NeedsAttentionList.parse(await first.json());
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeTypeOf("string");
    const second = await api.request({
      as: f.supervisorId,
      method: "GET",
      path: `${base()}?limit=1&cursor=${encodeURIComponent(page.next_cursor!)}`,
    });
    expect(second.status).toBe(200);
    const last = NeedsAttentionList.parse(await second.json());
    expect(last.items).toHaveLength(1);
    expect(last.next_cursor).toBeNull();
    const expected = await api.db.admin<{ id: string }[]>`
      select id from app.needs_attention where company_id=${f.s.company}
      order by created_at desc,id desc`;
    expect([...page.items, ...last.items].map((item) => item.id)).toEqual(
      expected.map((row) => row.id),
    );
  });
  it("a permitted sibling company cannot resolve this company's row", async () => {
    const [company] = await withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.s.system, requestId: "other-company" },
      (tx) =>
        tx<
          { id: string }[]
        >`insert into app.company(tenant_id,code,name,base_currency) values(${f.s.tenant},'OTHER','Other','MYR') returning id`,
    );
    await withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.s.system, requestId: "other-company-branch" },
      async (tx) => {
        const [type] = await tx<
          { id: string }[]
        >`insert into app.dimension_type(tenant_id,company_id,code,name_en) values(${f.s.tenant},${company!.id},'BRANCH','Branch') returning id`;
        await tx`insert into app.dimension_value(tenant_id,dimension_type_id,code,name_en) values(${f.s.tenant},${type!.id},'OTHER-HQ','Other HQ')`;
      },
    );
    await grantCodes(
      api.db,
      { ...f.s, company: company!.id },
      {
        principalId: f.supervisorId,
        roleCode: "other-queue",
        codes: ["pos.needs_attention.resolve"],
      },
    );
    const res = await api.request({
      as: f.supervisorId,
      method: "POST",
      path: `/v1/companies/${company!.id}/needs-attention/${rowId}/resolve`,
      body: { note: "wrong company" },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Problem).code).toBe("ERR_NOT_FOUND");
    expect(
      (
        await api.db.admin<
          { resolved_at: null }[]
        >`select resolved_at from app.needs_attention where id=${rowId}`
      )[0]!.resolved_at,
    ).toBeNull();
  });
  it("resolves with the authenticated manager and repeated resolution is indistinguishable from missing", async () => {
    const res = await api.request({
      as: f.supervisorId,
      method: "POST",
      path: `${base()}/${rowId}/resolve`,
      body: { note: "manager checked" },
    });
    expect(res.status).toBe(204);
    expect(
      (
        await api.db.admin<
          { resolved_by: string }[]
        >`select resolved_by from app.needs_attention where id=${rowId}`
      )[0]!.resolved_by,
    ).toBe(f.supervisorId);
    const again = await api.request({
      as: f.supervisorId,
      method: "POST",
      path: `${base()}/${rowId}/resolve`,
      body: { note: "repeat" },
    });
    expect(again.status).toBe(404);
  });
});
