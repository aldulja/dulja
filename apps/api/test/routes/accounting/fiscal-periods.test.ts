import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { postDocument, withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/fiscal-periods — spec:2223, 2179, test 9 (API and admin paths)", () => {
  let api: StartedApi;
  let a: Seed;
  /** A second human principal in tenant a. */
  let second: string;
  const grant = async (seed: Seed, principalId: string, ...codes: string[]): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${seed.tenant}, true), set_config('app.actor_id', ${seed.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${seed.tenant}, ${`r-${roleId.slice(-12)}`}, 'grant')`;
      for (const code of codes) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${seed.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${seed.tenant}, ${principalId}, ${roleId}, ${seed.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await grantCodes(api.db, a, { codes: ["accounting.journal.post"] });
    second = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${second}, 'human', ${`human2:${a.tenant}`}, 'Second')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${second})`;
    });
    await grant(a, a.human, "accounting.period.close", "accounting.period.reopen");
    await grant(a, second, "accounting.period.close");
  });
  afterAll(async () => {
    await api.stop();
  });

  it("lists the company's periods with their status", async () => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/fiscal-periods`,
      as: a.human,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; status: string }[] };
    expect(body.items.find((period) => period.id === a.period)!.status).toBe("open");
    expect(body.items.find((period) => period.id === a.lockedPeriod)!.status).toBe("locked");
  });

  it("closes a period and stamps closed_by from the session", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/close`,
      as: a.human,
      body: {},
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "closed", closedBy: a.human });
  });

  it("refuses a post as app_rw outside every route once the period is closed (test 9 — admin path)", async () => {
    // The API path is the documents route's. This is the path a DBA or a script takes: a real app_rw
    // session, no HTTP, no permission middleware. postDocument still refuses, and behind it
    // app.assert_period_open on ledger_entry is the control — asserted against a raw INSERT in
    // packages/db/test/posting/post.test.ts, which is where the posting-only-tables rule allows that DML.
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "admin-path" };
    const docId = await uuidv7(api.db.admin);
    await withTenant(api.db.rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${docId}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${docId}, 1, ${a.cash}, 5.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${docId}, 2, ${a.sales}, 5.0000)`;
    });
    await expect(
      withTenant(api.db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId: docId })),
    ).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
    const [entries] = await withTenant(
      api.db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where document_id = ${docId}`,
    );
    expect(entries!.n).toBe(0);
  });

  it("reopens only with a reason, and the reason lands in the audited row (spec:2179, ADR 0023)", async () => {
    const blank = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/reopen`,
      as: a.human,
      body: { reason: "   " },
    });
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");

    const ok = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/reopen`,
      as: a.human,
      body: { reason: "the auditor asked for one more adjustment" },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      status: "open",
      reopenReason: "the auditor asked for one more adjustment",
    });

    const [audit] = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "read" },
      (tx) => tx<{ reason: string | null; actor: string }[]>`
        select after ->> 'reopen_reason' as reason, actor_id::text as actor from app.audit_log
         where table_name = 'fiscal_period' and row_id = ${a.period} and action = 'update' order by seq desc limit 1`,
    );
    expect(audit).toMatchObject({
      reason: "the auditor asked for one more adjustment",
      actor: a.human,
    });
  });

  it("a second close by a different principal succeeds and closed_by keeps the first closer (reading 2)", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/close`,
      as: second,
      body: {},
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "closed", closedBy: a.human });
    const actors = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "read" },
      (tx) => tx<{ actor: string }[]>`
      select actor_id::text as actor from app.audit_log
       where table_name = 'fiscal_period' and row_id = ${a.period} and action = 'update' order by seq`,
    );
    // Every close is recorded with its own actor.
    expect(actors.at(-1)!.actor).toBe(second);
  });

  it("refuses to close a LOCKED period — close never downgrades a lock (spec:2427)", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/fiscal-periods/${a.lockedPeriod}/close`,
      as: a.human,
      body: {},
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_PERIOD_STATUS_ILLEGAL");
    const [row] = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "read" },
      (tx) => tx<{ status: string }[]>`
      select status::text as status from app.fiscal_period where id = ${a.lockedPeriod}`,
    );
    expect(row!.status).toBe("locked");
  });

  it("refuses a second close of a CLOSED period, so closed_at keeps the original close time", async () => {
    // a.period is closed at this point in the file (the second-close test above).
    const before = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "read" },
      (tx) => tx<{ closed_at: string }[]>`
      select closed_at::text as closed_at from app.fiscal_period where id = ${a.period}`,
    );
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/close`,
      as: a.human,
      body: {},
    });
    expect(res.status).toBe(409);
    const after = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "read" },
      (tx) => tx<{ closed_at: string }[]>`
      select closed_at::text as closed_at from app.fiscal_period where id = ${a.period}`,
    );
    expect(after[0]!.closed_at).toBe(before[0]!.closed_at);
  });

  it("refuses to reopen a period that is already open", async () => {
    // seedTenantV2 leaves no second open period, so reopen a.period first (legitimately), then again.
    const first = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/reopen`,
      as: a.human,
      body: { reason: "re-open for the guard test" },
    });
    expect(first.status).toBe(200);
    const again = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/reopen`,
      as: a.human,
      body: { reason: "should be refused" },
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as Problem).code).toBe("ERR_PERIOD_STATUS_ILLEGAL");
    // Put it back so the file's later assertions see the state they expect.
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/close`,
      as: a.human,
      body: {},
    });
  });

  it("close and reopen are separate authorities (spec:2179 R8)", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/reopen`,
      as: second,
      body: { reason: "not mine to give" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });
});
