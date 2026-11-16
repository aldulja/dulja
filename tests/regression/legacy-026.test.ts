import { fullRegression } from "../support/api";

fullRegression("LEGACY-026", "Session identity is unauthenticated, client-writable context", {
  "the tenant and actor come from the verified token, never from a header": async ({
    api,
    a,
    b,
    expect,
  }) => {
    const res = await api.request({
      method: "GET",
      path: "/v1/session",
      as: a.human,
      headers: { "X-Tenant-Id": b.tenant, "X-Actor-Id": b.human, "X-Principal-Id": b.human },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      tenantId: a.tenant,
      principalId: a.human,
      principalKind: "human",
    });
  },

  "a body field named tenant_id is stripped by the schema and never reaches the row": async ({
    api,
    a,
    b,
    expect,
  }) => {
    const res = await api.request({
      method: "POST",
      path: "/v1/companies",
      as: a.human,
      body: {
        code: "LEGACY026",
        name: "LEGACY-026",
        baseCurrency: "MYR",
        tenant_id: b.tenant,
        tenantId: b.tenant,
      },
    });
    expect(res.status).toBe(201);
    const [row] = await api.db.admin<{ tenant_id: string }[]>`
      select tenant_id from app.company where code = 'LEGACY026'`;
    expect(row!.tenant_id).toBe(a.tenant);
  },

  "the session variables the database reads are set by withTenant, and app_rw cannot set them itself":
    async ({ api, b, expect }) => {
      // A connection that never entered withTenant sees nothing: current_tenant() is the only door, and it is
      // written by the server (plan0A:957), not by anything the caller can send.
      const rows = await api.db.rw<{ n: number }[]>`select count(*)::int as n from app.company`;
      expect(rows[0]!.n).toBe(0);
      const forged = await api.db.rw<{ n: number }[]>`
      select count(*)::int as n from app.company where tenant_id = ${b.tenant}`;
      expect(forged[0]!.n).toBe(0);
    },
});

import { buildTicket, posFixture, syncRequest, uuidv7Sync } from "../invariants/support/pos";
fullRegression("LEGACY-026", "session identity is client-writable context — 6C", {
  "forged actor JSON is refused and accepted attendance uses terminal identity": async ({
    api,
    b,
    expect,
  }) => {
    const f = await posFixture(api, "LEGACY026 STAFF");
    const [employee] = await api.db.admin<
      { id: string }[]
    >`select employee_id as id from app.pos_cashier where principal_id=${f.cashierId}`;
    const ticket = buildTicket(f);
    ticket.attendance = [
      { principalId: f.cashierId, kind: "clock_in", at: new Date().toISOString() },
    ];
    const batch = (t: unknown) => ({
      terminalId: f.terminal.terminalId,
      batchId: uuidv7Sync(),
      tickets: [t],
      shifts: [],
      tillEvents: [],
    });
    const forged = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: batch({ ...ticket, actor_id: b.human }),
    });
    expect(forged.status).toBe(400);
    expect((await forged.json()) as { code: string }).toMatchObject({
      code: "ERR_VALIDATION_FAILED",
    });
    const good = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: batch(ticket),
      headers: { "X-Actor-Id": b.human, "X-Tenant-Id": b.tenant },
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ results: [{ status: "accepted" }] });
    const [attendance] = await api.db.admin<
      { recorded_by: string }[]
    >`select recorded_by from app.attendance_event where employee_id=${employee!.id}`;
    expect(attendance!.recorded_by).toBe(f.terminal.principalId);
    const [document] = await api.db.admin<
      { created_by: string }[]
    >`select created_by from app.document where client_ref=${ticket.clientRef}`;
    expect(document!.created_by).toBe(f.terminal.principalId);
  },
});
