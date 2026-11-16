import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { withTenant } from "@dulja/db";
import { seedDocumentType, seedParty, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/documents — contracts §4.2.7, spec:2287", () => {
  let api: StartedApi;
  let a: Seed;
  let drafter: string;
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
  const create = (as: string, lines: unknown[], over: Record<string, unknown> = {}) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as,
      body: {
        documentTypeCode: "JOURNAL",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: a.hq,
        lines,
        ...over,
      },
    });

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    drafter = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${drafter}, 'human', ${`drafter:${a.tenant}`}, 'Drafter')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${drafter})`;
    });
    await grant(
      a,
      a.human,
      "accounting.journal.create",
      "accounting.journal.post",
      "accounting.ledger.read",
    );
    // 2A: the create gate is now resolved from the policy, and JOURNAL_POLICY_V1 declares no approval.create,
    // so `approval.create ?? approval.post` is accounting.journal.post (contracts §4.5.4, §4.4.1's round-2
    // correction). The wording is 2B Task 7 Step 2's own, so that slice finds the edit already made.
    await grant(a, drafter, "accounting.journal.create", "accounting.journal.post");
  });
  afterAll(async () => {
    await api.stop();
  });

  it("drafts a journal with its lines and returns it with status draft and no number", async () => {
    const res = await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "100.0000", description: "Cash in" },
      { lineNo: 2, accountId: a.sales, credit: "100.0000" },
    ]);
    expect(res.status).toBe(201);
    const doc = (await res.json()) as {
      id: string;
      status: string;
      number: string | null;
      lines: unknown[];
    };
    expect(doc).toMatchObject({ status: "draft", number: null, series: "JV" });
    expect(doc.lines).toHaveLength(2);
  });

  it("posts through the transitions route and returns the ledger entry ids", async () => {
    const doc = (await (
      await create(a.human, [
        { lineNo: 1, accountId: a.cash, debit: "60.0000" },
        { lineNo: 2, accountId: a.sales, credit: "60.0000" },
      ])
    ).json()) as { id: string };
    const posted = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${doc.id}/transitions`,
      as: a.human,
      body: { to: "posted" },
    });
    expect(posted.status).toBe(200);
    const result = (await posted.json()) as {
      status: string;
      number: string;
      ledgerEntryIds: string[];
    };
    expect(result.status).toBe("posted");
    expect(result.ledgerEntryIds).toHaveLength(2);
    expect(BigInt(result.number)).toBeGreaterThan(0n);
  });

  // 2A: both gates on this route are resolved from the effective policy (contracts §4.5.4), and for a
  // JOURNAL every stage resolves to the single code accounting.journal.post (§4.4.1's round-2 correction).
  // The create and post authorities are therefore ONE code for this type, and spec:2158's "the clerk may not
  // post" cannot be demonstrated on JOURNAL at all. It is demonstrated instead on POLICY_TEST, whose policy
  // DOES declare approval.create — the "posting is gated by the policy's approval.post" case of the block
  // appended below, which is a strictly stronger statement of the same rule.
  it("a drafter holding the code JOURNAL's policy names may create AND post it (2A: §4.4.1's correction)", async () => {
    const doc = (await (
      await create(drafter, [
        { lineNo: 1, accountId: a.cash, debit: "3.0000" },
        { lineNo: 2, accountId: a.sales, credit: "3.0000" },
      ])
    ).json()) as { id: string };
    const posted = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${doc.id}/transitions`,
      as: drafter,
      body: { to: "posted" },
    });
    expect(posted.status).toBe(200);
    expect((await posted.json()) as { status: string }).toMatchObject({ status: "posted" });
  });

  it("surfaces ERR_LEDGER_UNBALANCED as a problem+json with the difference in the detail (SAH-003)", async () => {
    const doc = (await (
      await create(a.human, [
        { lineNo: 1, accountId: a.cash, debit: "100.0000" },
        { lineNo: 2, accountId: a.sales, credit: "90.0000" },
      ])
    ).json()) as { id: string };
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${doc.id}/transitions`,
      as: a.human,
      body: { to: "posted" },
    });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_LEDGER_UNBALANCED");
    expect(problem.detail).toContain(doc.id);
    expect(problem.type).toBe("urn:dulja:error:ERR_LEDGER_UNBALANCED");
  });

  it("replaces the lines of a draft, drops the surplus rows from the read, and refuses to touch a posted document", async () => {
    // Three lines in, two lines out. The replaced rows are DELETED (2B's migration 0023 grants it, guarded
    // by document_line_delete_draft_only) — never tombstoned — so nothing a later reader, the print model or
    // a reversal walks can meet a phantom row.
    const doc = (await (
      await create(a.human, [
        { lineNo: 1, accountId: a.cash, debit: "8.0000" },
        { lineNo: 2, accountId: a.sales, credit: "5.0000" },
        { lineNo: 3, accountId: a.sales, credit: "3.0000" },
      ])
    ).json()) as { id: string };
    const replaced = await api.request({
      method: "PUT",
      path: `/v1/companies/${a.company}/documents/${doc.id}/lines`,
      as: a.human,
      body: {
        lines: [
          { lineNo: 1, accountId: a.cash, debit: "9.0000" },
          { lineNo: 2, accountId: a.sales, credit: "9.0000" },
        ],
      },
    });
    expect(replaced.status).toBe(200);
    expect((await replaced.json()) as { lines: { lineNo: number }[] }).toMatchObject({
      lines: [
        { lineNo: 1, debit: "9.0000" },
        { lineNo: 2, credit: "9.0000" },
      ],
    });
    // Physically two rows, not two visible rows over a zeroed third: loadSnapshot and the print model read
    // the table with no filter, so a surviving tombstone would post, print and reverse as an empty line.
    const [rows] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document_line where document_id = ${doc.id}`;
    expect(rows!.n).toBe(2);
    const reread = (await (
      await api.request({
        method: "GET",
        path: `/v1/companies/${a.company}/documents/${doc.id}`,
        as: a.human,
      })
    ).json()) as { lines: unknown[] };
    expect(reread.lines).toHaveLength(2);
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${doc.id}/transitions`,
      as: a.human,
      body: { to: "posted" },
    });
    const after = await api.request({
      method: "PUT",
      path: `/v1/companies/${a.company}/documents/${doc.id}/lines`,
      as: a.human,
      body: { lines: [{ lineNo: 1, accountId: a.cash, debit: "1.0000" }] },
    });
    expect(after.status).toBe(409);
    expect(((await after.json()) as Problem).code).toBe("ERR_DOC_STATUS_ILLEGAL");
  });

  it("voids an issued document, and offers no reversal target (§4.5.4 gives 2B its own route)", async () => {
    const toVoid = (await (
      await create(a.human, [
        { lineNo: 1, accountId: a.cash, debit: "2.0000" },
        { lineNo: 2, accountId: a.sales, credit: "2.0000" },
      ])
    ).json()) as { id: string };
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${toVoid.id}/transitions`,
      as: a.human,
      body: { to: "issued" },
    });
    const voided = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${toVoid.id}/transitions`,
      as: a.human,
      body: { to: "void", reason: "wrong stationery" },
    });
    expect((await voided.json()) as { status: string }).toMatchObject({ status: "void" });

    // Reversal is NOT a transition target in Phase 1: contracts §4.5.4 puts it on
    // POST …/documents/{id}/reverse under `accounting.document.reverse`, which slice 2B owns. A caller who
    // asks for it here is refused by the Zod enum, not by a permission check — there is nothing to permit.
    const toReverse = (await (
      await create(a.human, [
        { lineNo: 1, accountId: a.cash, debit: "4.0000" },
        { lineNo: 2, accountId: a.sales, credit: "4.0000" },
      ])
    ).json()) as { id: string };
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${toReverse.id}/transitions`,
      as: a.human,
      body: { to: "posted" },
    });
    const reversed = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${toReverse.id}/transitions`,
      as: a.human,
      body: { to: "reversed", reason: "keyed twice", effectiveDate: "2026-01-20" },
    });
    expect(reversed.status).toBe(400);
    expect(((await reversed.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
    const stillPosted = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/documents/${toReverse.id}`,
      as: a.human,
    });
    expect(((await stillPosted.json()) as { status: string }).status).toBe("posted");
  });

  it("refuses a line whose account belongs to ANOTHER company of the same tenant (AGENTS.md: an entity id alone is not authority)", async () => {
    // The FK on document_line.account_id is (tenant_id, account_id), so the database alone would accept
    // this: company A's journal, company B's account, and A's trial balance showing B's account.
    const otherCompany = await uuidv7(api.db.admin);
    const otherAccount = await uuidv7(api.db.admin);
    const otherBranchType = await uuidv7(api.db.admin);
    const otherBranch = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.company (id, tenant_id, code, name, base_currency) values (${otherCompany}, ${a.tenant}, 'B', 'Company B', 'MYR')`;
      await tx`insert into app.account (id, tenant_id, company_id, code, name_en, type) values (${otherAccount}, ${a.tenant}, ${otherCompany}, '1000', 'B cash', 'asset')`;
      await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en) values (${otherBranchType}, ${a.tenant}, ${otherCompany}, 'BRANCH', 'Branch')`;
      await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en) values (${otherBranch}, ${a.tenant}, ${otherBranchType}, 'B-HQ', 'B head office')`;
    });
    const crossAccount = await create(a.human, [
      { lineNo: 1, accountId: otherAccount, debit: "5.0000" },
      { lineNo: 2, accountId: a.sales, credit: "5.0000" },
    ]);
    expect(crossAccount.status).toBe(404);
    expect(((await crossAccount.json()) as Problem).code).toBe("ERR_NOT_FOUND");

    const crossBranch = await create(
      a.human,
      [
        { lineNo: 1, accountId: a.cash, debit: "5.0000" },
        { lineNo: 2, accountId: a.sales, credit: "5.0000" },
      ],
      { branchId: otherBranch },
    );
    expect(crossBranch.status).toBe(404);
    expect(((await crossBranch.json()) as Problem).code).toBe("ERR_NOT_FOUND");

    const crossDimension = await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "5.0000", dimensions: { BRANCH: otherBranch } },
      { lineNo: 2, accountId: a.sales, credit: "5.0000" },
    ]);
    expect(crossDimension.status).toBe(400);
    expect(((await crossDimension.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");

    // No row of any kind was written for the refused drafts.
    const [count] = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "read" },
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_line where account_id = ${otherAccount}`,
    );
    expect(count!.n).toBe(0);
  });

  it("refuses a line on a GROUP account or an ARCHIVED account", async () => {
    const group = await uuidv7(api.db.admin);
    const archived = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.account (id, tenant_id, company_id, code, name_en, type, is_group) values (${group}, ${a.tenant}, ${a.company}, '1', 'Assets', 'asset', true)`;
      await tx`insert into app.account (id, tenant_id, company_id, code, name_en, type, archived_at) values (${archived}, ${a.tenant}, ${a.company}, '1990', 'Old', 'asset', now())`;
    });
    for (const accountId of [group, archived]) {
      const res = await create(a.human, [
        { lineNo: 1, accountId, debit: "5.0000" },
        { lineNo: 2, accountId: a.sales, credit: "5.0000" },
      ]);
      expect(res.status).toBe(400);
      expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("a document read needs journal.create, journal.post or ledger.read IN the company — membership alone is refused", async () => {
    const res = await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "3.0000" },
      { lineNo: 2, accountId: a.sales, credit: "3.0000" },
    ]);
    const doc = (await res.json()) as { id: string };
    const member = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${member}, 'human', ${`member:${a.tenant}`}, 'Member only')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${member})`;
    });
    const forbidden = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/documents/${doc.id}`,
      as: member,
    });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
    // The drafter holds journal.create only, and that is enough to read back a draft.
    const drafterRead = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/documents/${doc.id}`,
      as: drafter,
    });
    expect(drafterRead.status).toBe(200);
  });

  it("refuses a post into a closed period through the API (test 9 — API path)", async () => {
    // a.closedPeriod covers 2026-02-15 (seedTenantV2). The route is the only path this task adds; the
    // admin path — the same write attempted as app_rw, refused by app.assert_period_open — is asserted in
    // packages/db/test/posting/post.test.ts and again through a direct postDocument call.
    const doc = (await (
      await create(
        a.human,
        [
          { lineNo: 1, accountId: a.cash, debit: "5.0000" },
          { lineNo: 2, accountId: a.sales, credit: "5.0000" },
        ],
        { effectiveDate: "2026-02-15" },
      )
    ).json()) as { id: string };
    const posted = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${doc.id}/transitions`,
      as: a.human,
      body: { to: "posted" },
    });
    expect(posted.status).toBe(422);
    expect(((await posted.json()) as Problem).code).toBe("ERR_PERIOD_NOT_OPEN");
  });

  it("refuses a foreign-currency document with no rate (ERR_RATE_NOT_FOUND)", async () => {
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.currency (tenant_id, code, name_en) values (${a.tenant}, 'EUR', 'Euro')
               on conflict (tenant_id, code) do nothing`;
    });
    const res = await create(
      a.human,
      [
        { lineNo: 1, accountId: a.cash, debit: "1.0000" },
        { lineNo: 2, accountId: a.sales, credit: "1.0000" },
      ],
      { currency: "EUR" },
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as Problem).code).toBe("ERR_RATE_NOT_FOUND");
  });

  it("reads posted ledger entries under accounting.ledger.read, filtered by account and period", async () => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/ledger-entries?accountId=${a.cash}&fiscalPeriodId=${a.period}&limit=100`,
      as: a.human,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { accountId: string; baseDebit: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((entry) => entry.accountId === a.cash)).toBe(true);

    const forbidden = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/ledger-entries`,
      as: drafter,
    });
    expect(forbidden.status).toBe(403);
  });

  it("the idempotency header is required and a replay returns the stored response (§4.2.9)", async () => {
    const key = `idem-${Date.now()}`;
    const body = {
      documentTypeCode: "JOURNAL",
      effectiveDate: "2026-01-15",
      currency: "MYR",
      branchId: a.hq,
      lines: [
        { lineNo: 1, accountId: a.cash, debit: "11.0000" },
        { lineNo: 2, accountId: a.sales, credit: "11.0000" },
      ],
    };
    const missing = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: a.human,
      body,
      idempotencyKey: null,
    });
    expect(((await missing.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    const first = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: a.human,
      body,
      idempotencyKey: key,
    });
    const replay = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: a.human,
      body,
      idempotencyKey: key,
    });
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
  });

  // ─── 2B — the whole state machine through one route ──────────────────────────────────────────────────
  it("walks the full state machine through one route (contracts §4.5.4)", async () => {
    const created = await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "40.0000" },
      { lineNo: 2, accountId: a.sales, credit: "40.0000" },
    ]);
    const { id } = (await created.json()) as { id: string };
    const move = (to: string, body: Record<string, unknown> = {}, as = a.human) =>
      api.request({
        method: "POST",
        path: `/v1/companies/${a.company}/documents/${id}/transitions`,
        as,
        body: { to, ...body },
      });

    expect((await move("submitted", { reason: "for review" })).status).toBe(200);
    const back = await move("draft", { reason: "figures changed" });
    expect(back.status).toBe(200);
    expect((await back.json()) as { from: string; to: string }).toMatchObject({
      from: "submitted",
      to: "draft",
    });
    expect((await move("submitted", { reason: "again" })).status).toBe(200);

    const issued = await move("issued");
    expect(issued.status).toBe(200);
    // 1A's six members survive the widening and 2B's three are added beside them — this is the assertion
    // that keeps TransitionResultSchema a superset rather than a replacement.
    const issuedBody = (await issued.json()) as {
      from: string;
      to: string;
      eventId: string;
      status: string;
      number: string;
      series: string;
      fiscalPeriodId: string | null;
      ledgerEntryIds: string[];
    };
    expect(issuedBody).toMatchObject({
      from: "submitted",
      to: "issued",
      status: "issued",
      series: "JV",
      ledgerEntryIds: [],
    });
    expect(BigInt(issuedBody.number)).toBeGreaterThan(0n);
    expect(issuedBody.fiscalPeriodId).not.toBeNull();
    expect(issuedBody.eventId).toMatch(/^[0-9a-f-]{36}$/);

    const postedRes = await move("posted");
    expect(postedRes.status).toBe(200);
    expect((await postedRes.json()) as { from: string; ledgerEntryIds: string[] }).toMatchObject({
      from: "issued",
    });
    const [row] = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "walk" },
      (tx) =>
        tx<{ status: string }[]>`select status::text as status from app.document where id = ${id}`,
    );
    expect(row!.status).toBe("posted");
  });

  it("refuses `to: draft` and `to: void` without a reason with ERR_VALIDATION_FAILED naming the field", async () => {
    const created = await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "1.0000" },
      { lineNo: 2, accountId: a.sales, credit: "1.0000" },
    ]);
    const { id } = (await created.json()) as { id: string };
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: a.human,
      body: { to: "submitted" },
    });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: a.human,
      body: { to: "draft" },
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.[0]?.path).toBe("reason");
  });

  it("a void writes document_number_void and the event carries the reason (spec:1745)", async () => {
    const created = await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "2.0000" },
      { lineNo: 2, accountId: a.sales, credit: "2.0000" },
    ]);
    const { id } = (await created.json()) as { id: string };
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: a.human,
      body: { to: "issued" },
    });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: a.human,
      body: { to: "void", reason: "printer jam; reissued" },
    });
    expect(res.status).toBe(200);
    const [voided] = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "void" },
      (tx) => tx<{ reason: string; event_reason: string | null }[]>`
        select v.reason,
               (select e.reason from app.document_event e
                 where e.document_id = d.id and e.to_status = 'void' order by e.id desc limit 1) as event_reason
          from app.document_number_void v
          join app.document d on d.company_id = v.company_id and d.series = v.series
           and d.fiscal_period_id = v.fiscal_period_id and d.number = v.number
         where d.id = ${id}`,
    );
    expect(voided!.reason).toBe("printer jam; reissued");
    expect(voided!.event_reason).toBe("printer jam; reissued");
  });

  it("DOCUMENT_STAGE_CODES lists every code a seeded policy may name at any stage", async () => {
    const { DOCUMENT_STAGE_CODES } = await import("../../../src/routes/accounting/documents");
    // Grown by 3C Task 2, the first slice §4.5.4 says genuinely extends it: the PURCHASE_ORDER,
    // SHIPMENT, GOODS_RECEIPT and PURCHASE_RETURN policies name these four in their `approval` blocks,
    // and POLICY_RESOLVED_CODES — which this constant is initialised from — is the one source reference
    // the `permission-catalogue` lint can see for a code gated from data. Grown again by 3D Task 2, whose
    // six codes are the `approval` blocks of SALES_ORDER, DELIVERY_ORDER, TRANSFER, TRANSFER_RECEIPT,
    // STOCK_COUNT and EXPIRY_WRITE_OFF. Grown again by 4A Task 2 with the six `approval` codes of the six
    // AR/AP types; 4A's seventh code, the credit-limit override, is an override code no policy names, so
    // it is deliberately absent. Grown again by 8B Task 3 with the PAYROLL policy's create, approve and post,
    // and by 8C Task 4 with PAYROLL_PAYMENT's and EMPLOYEE_ADVANCE's create codes (their approve and post are 4A's).
    expect([...DOCUMENT_STAGE_CODES].toSorted()).toEqual([
      "accounting.journal.create",
      "accounting.journal.post",
      "accounting.payment.approve",
      "accounting.payment.create",
      "accounting.payment.post",
      "accounting.purchase.create",
      "accounting.purchase.post",
      "accounting.receipt.create",
      "accounting.receipt.post",
      "accounting.sales.create",
      "accounting.sales.post",
      "hr.advance.create",
      "hr.payroll.approve",
      "hr.payroll.pay",
      "hr.payroll.post",
      "hr.payroll.prepare",
      "inventory.adjustment.approve",
      "inventory.adjustment.create",
      "inventory.count.create",
      "inventory.receipt.create",
      "inventory.receipt.post",
      "inventory.transfer.create",
      "inventory.transfer.post",
      "pos.sync.push",
    ]);
  });
});

describe("the document gate comes from the policy, not from a literal — contracts §4.5.4, 1A T12", () => {
  let api: StartedApi;
  let a: Seed;
  let clerk: string;
  let poster: string;

  const POLICY_TEST = {
    version: 1,
    documentType: "POLICY_TEST",
    direction: "internal",
    requires: [],
    lines: [
      {
        for: "each_line",
        side: "debit",
        account: { from: "line.account" },
        amount: "line.debit",
        when: { "line.kind": "account" },
      },
      {
        for: "each_line",
        side: "credit",
        account: { from: "line.account" },
        amount: "line.credit",
        when: { "line.kind": "account" },
      },
    ],
    inventory: { effect: "none" },
    tax: { applies: false },
    numbering: { series: "PT", assignAt: "issue" },
    reversal: { allowed: true, producesType: "POLICY_TEST" },
    approval: {
      required: false,
      approve: null,
      post: "accounting.journal.post",
      create: "accounting.party.manage",
    },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  };

  /** 1A creates its one extra principal with an inline `app.principal` + `app.membership` pair inside its own
   *  `beforeAll` and grants with a `const grant` declared inside its own `describe` — so neither is in scope
   *  here. These two are that pair, as named local helpers of this block. They are test-file locals, not a
   *  second spelling of a §4.17 fixture (hazard 9 governs that register). */
  const seedPrincipal = async (s: Seed, displayName: string): Promise<string> => {
    const principalId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${principalId}, 'human', ${`${displayName.toLowerCase()}:${s.tenant}`}, ${displayName})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
    });
    return principalId;
  };

  const grantCodes = async (s: Seed, principalId: string, ...codes: string[]): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${roleId}, ${s.tenant}, ${`r-${roleId.slice(-12)}`}, 'grant')`;
      for (const code of codes) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await seedDocumentType(api.db, a, { code: "POLICY_TEST", policy: POLICY_TEST });
    clerk = await seedPrincipal(a, "Clerk");
    poster = await seedPrincipal(a, "Poster");
    // The clerk holds the code POLICY_TEST's `approval.create` names and NOT accounting.journal.post. It also
    // holds accounting.ledger.read so it can read its own draft back: the document read is gated by
    // journal.create | journal.post | ledger.read in the company (the Phase 1 review pass; 2C narrows it to
    // the type's module read code, of which ledger.read is the accounting row) — never by the write gate.
    await grantCodes(a, clerk, "accounting.party.manage", "accounting.ledger.read");
    await grantCodes(a, poster, "accounting.journal.post");
  });
  afterAll(async () => {
    await api.stop();
  });

  const create = (as: string, typeCode: string) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as,
      body: {
        documentTypeCode: typeCode,
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: a.hq,
        lines: [
          { lineNo: 1, kind: "account", accountId: a.cash, debit: "5.0000" },
          { lineNo: 2, kind: "account", accountId: a.sales, credit: "5.0000" },
        ],
      },
    });

  it("a document type the tenant configured is creatable without touching accounting.journal.create", async () => {
    const res = await create(clerk, "POLICY_TEST");
    expect(res.status).toBe(201);
  });

  it("the same principal cannot create a JOURNAL — the code comes from EACH type's own policy", async () => {
    const res = await create(clerk, "JOURNAL");
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("posting is gated by the policy's approval.post, whoever created the draft (spec:2158 — the clerk may not post)", async () => {
    const created = await create(clerk, "POLICY_TEST");
    const { id } = (await created.json()) as { id: string };
    const refused = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: clerk,
      body: { to: "posted" },
    });
    expect(refused.status).toBe(403);
    const posted = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: poster,
      body: { to: "posted" },
    });
    expect(posted.status).toBe(200);
  });

  it("`approval.create` falling back to `approval.post` when the policy omits it", async () => {
    await seedDocumentType(api.db, a, {
      code: "POLICY_TEST",
      policyVersion: 2,
      effectiveFrom: "2026-01-20",
      policy: {
        ...POLICY_TEST,
        approval: { required: false, approve: null, post: "accounting.journal.post" },
      },
    });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: clerk,
      body: {
        documentTypeCode: "POLICY_TEST",
        effectiveDate: "2026-01-22",
        currency: "MYR",
        branchId: a.hq,
        lines: [
          { lineNo: 1, kind: "account", accountId: a.cash, debit: "1.0000" },
          { lineNo: 2, kind: "account", accountId: a.sales, credit: "1.0000" },
        ],
      },
    });
    expect(res.status).toBe(403); // clerk holds party.manage, not journal.post
  });

  it("a documentTypeCode that names no type in the company is 404, never 403", async () => {
    const res = await create(clerk, "NOT_A_TYPE");
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("a type with no policy effective for the date is ERR_POLICY_NOT_FOUND, not a silent allow", async () => {
    // POLICY_TEST_2 is §4.14's second test-only code (amendment A1). Its only policy version is effective
    // from June, so a January document has no effective policy — and the body still carries two balanced
    // lines, because `CreateDocumentBody.lines` keeps 1A's `.min(1)` and an empty array would be refused by
    // Zod rather than by the policy resolution this case is about.
    await seedDocumentType(api.db, a, {
      code: "POLICY_TEST_2",
      policy: {
        ...POLICY_TEST,
        documentType: "POLICY_TEST_2",
        numbering: { series: "PT2", assignAt: "issue" },
        reversal: { allowed: true, producesType: "POLICY_TEST_2" },
      },
      effectiveFrom: "2026-06-01",
    });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: clerk,
      body: {
        documentTypeCode: "POLICY_TEST_2",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: a.hq,
        lines: [
          { lineNo: 1, kind: "account", accountId: a.cash, debit: "1.0000" },
          { lineNo: 2, kind: "account", accountId: a.sales, credit: "1.0000" },
        ],
      },
    });
    expect((await problemOf(res)).code).toBe("ERR_POLICY_NOT_FOUND");
  });

  it("persists an item line's quantity, price and totals and reads them back, and refuses an itemId that is no live item of this company (3A)", async () => {
    const ok = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: clerk,
      body: {
        documentTypeCode: "POLICY_TEST",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: a.hq,
        lines: [
          {
            lineNo: 1,
            kind: "item",
            quantity: "2.000000",
            unitPrice: "3.0000",
            amount: "6.0000",
          },
        ],
      },
    });
    expect(ok.status).toBe(201);

    // A 201 alone would pass even if every widened field were discarded, which is exactly the defect this
    // case exists to catch — so read the document back and assert the stored values. An item line has no
    // accountId and zero debit/credit and must still come back: readDocument filters nothing.
    const { id } = (await ok.json()) as { id: string };
    const read = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/documents/${id}`,
      as: clerk,
    });
    const doc = (await read.json()) as { lines: Record<string, unknown>[] };
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({
      lineNo: 1,
      kind: "item",
      accountId: null,
      quantity: "2.000000",
      unitPrice: "3.0000",
      discount: "0.0000",
      amount: "6.0000",
      taxAmount: "0.0000",
      totalInclTax: "6.0000",
      itemId: null,
      taxCodeId: null,
      cost: null,
    });

    const bad = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: clerk,
      body: {
        documentTypeCode: "POLICY_TEST",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: a.hq,
        lines: [{ lineNo: 1, kind: "item", itemId: a.cash, amount: "6.0000" }],
      },
    });
    // 2A refused `itemId` at the schema because the column had no key until 3A. Migration 0032 added it and
    // 3A's DocumentLineInput accepts the field, so the refusal is now `assertLinesBelong`'s: an account id
    // is no live item of this company, and an id the caller may not see is a 404 like a foreign branch.
    expect(bad.status).toBe(404);
    expect(await problemOf(bad)).toMatchObject({
      code: "ERR_NOT_FOUND",
      detail: expect.stringContaining(`no live item ${a.cash}`),
    });
  });

  it("a negative money field and a both-sided line are 400, not 500 — 1A's Amount and refine still bind", async () => {
    // `document_line.debit` carries `check (debit >= 0)` and `check (not (debit > 0 and credit > 0))`.
    // A body that reached either would raise SQLSTATE 23514, whose message does not start with `ERR_`, and
    // `fromDatabaseError` maps that to ERR_INTERNAL 500 (§4.2.4). Zod must refuse both first.
    const body = (lines: unknown[]) => ({
      documentTypeCode: "POLICY_TEST",
      effectiveDate: "2026-01-15",
      currency: "MYR",
      branchId: a.hq,
      lines,
    });
    const negative = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: clerk,
      body: body([{ lineNo: 1, kind: "account", accountId: a.cash, debit: "-5.0000" }]),
    });
    expect(negative.status).toBe(400);
    expect((await problemOf(negative)).code).toBe("ERR_VALIDATION_FAILED");

    const bothSides = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: clerk,
      body: body([
        { lineNo: 1, kind: "account", accountId: a.cash, debit: "5.0000", credit: "5.0000" },
      ]),
    });
    expect(bothSides.status).toBe(400);

    const accountLineWithNoAccount = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: clerk,
      body: body([{ lineNo: 1, kind: "account", debit: "5.0000" }]),
    });
    expect(accountLineWithNoAccount.status).toBe(400);
  });

  it("a partyId of another tenant is refused before the composite FK, as ERR_NOT_FOUND (Phase 2 review)", async () => {
    const b = await seedTenantV2(api.db, "Beta");
    const foreign = await seedParty(api.db, b, { code: "X-API" });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: clerk,
      body: {
        documentTypeCode: "POLICY_TEST",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: a.hq,
        partyId: foreign,
        lines: [
          { lineNo: 1, kind: "account", accountId: a.cash, debit: "1.0000" },
          { lineNo: 2, kind: "account", accountId: a.sales, credit: "1.0000" },
        ],
      },
    });
    // 2A wrote ERR_CONFLICT_REFERENCE, the answer of `document_party_fk`. The Phase 2 review added
    // `assertPartyBelongs` ahead of the insert, because that key is tenant-composite and would admit a
    // sibling COMPANY's party; another tenant's party is invisible under RLS and is refused there too, as
    // a 404 that confirms nothing about the id — the key never gets the chance.
    expect(res.status).toBe(404);
    expect(await problemOf(res)).toMatchObject({
      code: "ERR_NOT_FOUND",
      detail: expect.stringContaining(`no party ${foreign}`),
    });
  });
});
