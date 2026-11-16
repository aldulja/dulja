import { grantCodes } from "@dulja/db/test";
import { fullRegression, problemOf } from "../support/api";
import { seedTenantV2, uuidv7 } from "@dulja/db/test";
import { sliceRegression } from "../support/regression";

fullRegression("SAH-035", "Tenant (Site) scoping is a client convention", {
  "reading another tenant's row by its uuid is 404, not a row": async ({ api, a, b, expect }) => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${b.company}`,
      as: a.human,
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  },

  "writing into another tenant's row by its uuid is refused and leaves it untouched": async ({
    api,
    a,
    b,
    expect,
  }) => {
    const [before] = await api.db.admin<
      { name: string }[]
    >`select name from app.company where id = ${b.company}`;
    const res = await api.request({
      method: "PATCH",
      path: `/v1/companies/${b.company}`,
      as: a.human,
      body: { name: "Taken over" },
    });
    expect([403, 404]).toContain(res.status);
    const [after] = await api.db.admin<
      { name: string }[]
    >`select name from app.company where id = ${b.company}`;
    expect(after!.name).toBe(before!.name);
  },

  "the list endpoint is scoped by the transaction, not by a WHERE the caller could drop": async ({
    api,
    a,
    b,
    expect,
  }) => {
    const res = await api.request({ method: "GET", path: "/v1/companies?limit=1000", as: a.human });
    const ids = ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).toContain(a.company);
    expect(ids).not.toContain(b.company);
  },

  "app_rw itself cannot insert a row for another tenant even holding the uuid": async ({
    api,
    a,
    b,
    expect,
  }) => {
    await expect(
      api.db.rw.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
        await tx`insert into app.company (tenant_id, code, name, base_currency) values (${b.tenant}, 'SAH035', 'Forged', 'MYR')`;
      }),
    ).rejects.toThrow(/row-level security/);
  },
});

sliceRegression(
  "SAH-035",
  "Tenant scoping is a client convention",
  "1A",
  "every Phase 1 table refuses a cross-tenant reference through its composite FK",
  async ({ db, rw, withTenant, expect }) => {
    const alpha = await seedTenantV2(db, "SAH035-A");
    await grantCodes(db, alpha);
    const beta = await seedTenantV2(db, "SAH035-B");
    await grantCodes(db, beta);
    const ctxA = { tenantId: alpha.tenant, actorId: alpha.human, requestId: "sah035" };
    const doc = await uuidv7(db.admin);
    await withTenant(
      rw,
      ctxA,
      (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${doc}, ${alpha.tenant}, ${alpha.company}, ${alpha.docType}, 'JV', '2026-01-15', 'MYR', ${alpha.hq})`,
    );
    await expect(
      withTenant(
        rw,
        ctxA,
        (tx) => tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
        values (${alpha.tenant}, ${alpha.company}, ${doc}, 1, ${beta.cash}, 1.0000)`,
      ),
    ).rejects.toThrow(/document_line_tenant_id_account_id_fkey/);
    await expect(
      withTenant(
        rw,
        ctxA,
        (tx) => tx`
        insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency, debit)
        values (${alpha.tenant}, ${alpha.company}, ${beta.cash}, ${alpha.period}, 'MYR', 1.0000)`,
      ),
    ).rejects.toThrow(/account_balance_tenant_id_account_id_fkey/);
  },
);
