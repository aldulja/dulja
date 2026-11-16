import { fullRegression } from "../support/api";

fullRegression("LEGACY-027", "One client-settable variable disables every write-time control", {
  "a query parameter naming a session variable is stripped and changes nothing": async ({
    api,
    a,
    b,
    expect,
  }) => {
    const res = await api.request({
      method: "GET",
      as: a.human,
      path: `/v1/companies?limit=100&app.tenant_id=${b.tenant}&set_config=1&silent=1&audit=off`,
    });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).toContain(a.company);
    expect(ids).not.toContain(b.company);
  },

  "setting any app.* GUC by hand does not switch off RLS, the audit trigger or the actor stamp":
    async ({ api, a, expect }) => {
      const before = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant}`;
      await api.db.rw.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
        // Every off-switch the legacy system had, invented back: none of them exists, and setting them is inert.
        await tx`select set_config('app.silent', '1', true), set_config('app.audit', 'off', true),
                      set_config('app.skip_checks', 'true', true), set_config('app.admin', '1', true)`;
        await tx`insert into app.company (tenant_id, code, name, base_currency) values (${a.tenant}, 'LEGACY027', 'LEGACY-027', 'MYR')`;
      });
      const after = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant}`;
      expect(after[0]!.n).toBe(before[0]!.n + 1);
    },

  "there is no session setting that lets app_rw write another tenant's row": async ({
    api,
    a,
    b,
    expect,
  }) => {
    await expect(
      api.db.rw.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
        await tx`select set_config('app.bypass_rls', 'on', true), set_config('row_security', 'off', true)`;
        await tx`insert into app.company (tenant_id, code, name, base_currency) values (${b.tenant}, 'LEGACY027X', 'Forged', 'MYR')`;
      }),
    ).rejects.toThrow(/row-level security|permission denied/);
  },
});

import { buildTicket, posFixture, syncRequest, uuidv7Sync } from "../invariants/support/pos";
fullRegression("LEGACY-027", "No client flag bypasses POS posting controls — 6A", {
  "unsupported flags refuse before posting and normal stock controls still apply": async ({
    api,
    b,
    expect,
  }) => {
    const f = await posFixture(api, "LEGACY027 POS");
    const ticket = buildTicket(f);
    const batch = {
      terminalId: f.terminal.terminalId,
      batchId: uuidv7Sync(),
      tickets: [ticket],
      shifts: [],
      tillEvents: [],
    };
    const flags = JSON.parse(
      '{"internal":true,"skipChecks":true,"__proto__":{"actorId":"' + b.human + '"}}',
    );
    const refused = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: { ...batch, ...flags },
    });
    expect(refused.status).toBe(400);
    expect(
      await api.db.admin`select id from app.document where client_ref=${ticket.clientRef}`,
    ).toHaveLength(0);
    const normal = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: batch,
    });
    expect(normal.status).toBe(200);
    const out = (await normal.json()) as { results: { documentId: string }[] };
    expect(
      (
        await api.db
          .admin`select id from app.ledger_entry where document_id=${out.results[0]!.documentId}`
      ).length,
    ).toBeGreaterThan(0);
    const oversell = buildTicket(f, { quantity: "999999.000000" });
    const rejected = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: { ...batch, batchId: uuidv7Sync(), tickets: [oversell] },
    });
    expect(
      ((await rejected.json()) as { results: { error: { code: string } }[] }).results[0]!.error
        .code,
    ).toBe("ERR_STOCK_INSUFFICIENT");
  },
});
