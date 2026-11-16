import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reverseDocument, withTenant } from "@dulja/db";
import { seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

/**
 * Phase 2 definition of done, first clause (spec:2288): "A new document type is added with zero code."
 *
 * The type and its policy version are created through the two configuration endpoints of Task 10 and nothing
 * else: no seedDocumentType, no INSERT, no seed file, no TypeScript. Everything afterwards runs against that
 * configuration. 2C owns test 15 and adds the print and report clauses on this same fixture (contracts §6.1).
 *
 * CONSIGNMENT_RETURN is §4.14's registered row — accounting / inbound / inventory none /
 * accounting.journal.post / series CR — because hazard 32 forbids inventing a code and because F-21 refuses a
 * policy naming a permission code no slice has shipped.
 */
describe("zero code: a document type created through the API numbers, posts and reverses — spec:2288, spec:2433", () => {
  let api: StartedApi;
  let a: Seed;
  let documentTypeId: string;

  const types = () => `/v1/companies/${a.company}/document-types`;
  const docs = () => `/v1/companies/${a.company}/documents`;

  /** §4.14's CONSIGNMENT_RETURN, as JSON in a request body. Not a fixture constant in packages/db — the
   *  point of the test is that this object never enters the repository as code. */
  const POLICY = {
    version: 1,
    documentType: "CONSIGNMENT_RETURN",
    direction: "inbound",
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
    numbering: { series: "CR", assignAt: "issue" },
    reversal: { allowed: true, producesType: "CONSIGNMENT_RETURN" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  };

  /** `grantAdmin` grants the five admin codes and nothing else; the document routes gate on the code the
   *  policy names (`accounting.journal.post`) and `/ledger-entries` on `accounting.ledger.read`. */
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

  const draft = async (over: Record<string, unknown> = {}): Promise<string> => {
    const res = await api.request({
      method: "POST",
      path: docs(),
      as: a.human,
      body: {
        documentTypeCode: "CONSIGNMENT_RETURN",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: a.hq,
        lines: [
          { lineNo: 1, kind: "account", accountId: a.cash, debit: "42.0000" },
          { lineNo: 2, kind: "account", accountId: a.sales, credit: "42.0000" },
        ],
        ...over,
      },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  const transition = (id: string, to: string) =>
    api.request({
      method: "POST",
      path: `${docs()}/${id}/transitions`,
      as: a.human,
      body: { to },
    });

  const read = async (id: string) =>
    (await (await api.request({ method: "GET", path: `${docs()}/${id}`, as: a.human })).json()) as {
      id: string;
      documentTypeCode: string;
      status: string;
      series: string;
      number: string | null;
      reversesDocumentId: string | null;
      lines: { lineNo: number; debit: string; credit: string; accountId: string | null }[];
    };

  const ctxOf = (requestId: string) => ({ tenantId: a.tenant, actorId: a.human, requestId });

  /** 1A's `DocumentSchema` deliberately does not expose `postingPolicyId` — it is an internal pin, not a
   *  client concern — so the two assertions that need it read the column, as `app_rw`, through the production
   *  three-argument `withTenant`. Adding the field to the wire schema would be a §4.2.8 amendment this slice
   *  has no reason to make. */
  const pinnedPolicyOf = async (id: string): Promise<string | null> => {
    const rows = await withTenant(
      api.db.rw,
      ctxOf("zc-pin"),
      (tx) => tx<{ posting_policy_id: string | null }[]>`
        select posting_policy_id::text as posting_policy_id from app.document where id = ${id}`,
    );
    return rows[0]!.posting_policy_id;
  };

  /** The id of a document this file posted BEFORE version 2's effective_from — used only to compare pinned
   *  policy ids. The bound is 2026-01-20 because that is where version 2 begins; every draft above the
   *  version-2 case uses 2026-01-15. */
  const firstEarlyJanuaryPosted = async (): Promise<string> => {
    const rows = await withTenant(
      api.db.rw,
      ctxOf("zc-jan"),
      (tx) => tx<{ id: string }[]>`
        select d.id from app.document d
          join app.document_type t on t.id = d.document_type_id
         where t.code = 'CONSIGNMENT_RETURN' and d.status in ('posted', 'reversed')
           and d.effective_date < '2026-01-20' order by d.effective_date, d.id limit 1`,
    );
    return rows[0]!.id;
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "ZeroCode");
    await grantAdmin(api, a);
    await grantCodes(a, a.human, "accounting.journal.post", "accounting.ledger.read");

    // ─── The whole of "adding a document type": two HTTP calls. ───────────────
    const created = await api.request({
      method: "POST",
      path: types(),
      as: a.human,
      body: {
        code: "CONSIGNMENT_RETURN",
        nameEn: "Consignment return",
        nameAr: "مرتجع أمانة",
        module: "accounting",
      },
    });
    expect(created.status).toBe(201);
    documentTypeId = ((await created.json()) as { id: string }).id;

    const versioned = await api.request({
      method: "POST",
      path: `${types()}/${documentTypeId}/policies`,
      as: a.human,
      body: { version: 1, effectiveFrom: "2026-01-01", definition: POLICY },
    });
    expect(versioned.status).toBe(201);
  });

  afterAll(async () => {
    await api.stop();
  });

  it("the type and its policy exist, and no seed file or fixture put them there", async () => {
    // The seed pack has no CONSIGNMENT_RETURN file (§4.14: "not seeded"), and this test called no fixture.
    const rows = await withTenant(
      api.db.rw,
      ctxOf("zero-code"),
      (tx) => tx<{ code: string; module: string; versions: number }[]>`
        select t.code, t.module, count(p.id)::int as versions
          from app.document_type t left join app.posting_policy p on p.document_type_id = t.id
         where t.company_id = ${a.company} and t.code = 'CONSIGNMENT_RETURN'
         group by t.code, t.module`,
    );
    expect(rows).toEqual([{ code: "CONSIGNMENT_RETURN", module: "accounting", versions: 1 }]);
  });

  it("NUMBERS: the first issued document of the new type is CR 1 and the second is CR 2", async () => {
    const first = await draft();
    expect((await read(first)).number).toBeNull(); // assignAt: "issue" — a draft has no number
    expect((await transition(first, "issued")).status).toBe(200);
    const firstIssued = await read(first);
    expect(firstIssued.series).toBe("CR");
    expect(firstIssued.number).toBe("1");
    expect(firstIssued.status).toBe("issued");

    const second = await draft();
    await transition(second, "issued");
    expect((await read(second)).number).toBe("2");
  });

  it("POSTS: the issued document posts through the same posting service and pins the policy it used", async () => {
    const id = await draft();
    await transition(id, "issued");
    expect((await transition(id, "posted")).status).toBe(200);

    const posted = await read(id);
    expect(posted.status).toBe("posted");
    expect(await pinnedPolicyOf(id)).not.toBeNull(); // LEGACY-013: the rule is pinned on the row

    // 1A's `LedgerEntryQuery` is flat — `documentId`, `accountId`, `fiscalPeriodId`, `from`, `to` — not the
    // `filter[x][eq]` form this slice's own two configuration routes use. Consume it as 1A shipped it.
    const entries = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/ledger-entries?documentId=${id}`,
      as: a.human,
    });
    const { items } = (await entries.json()) as {
      items: {
        accountId: string;
        debit: string;
        credit: string;
        baseDebit: string;
        baseCredit: string;
      }[];
    };
    expect(items).toHaveLength(2);
    expect(items.filter((e) => e.accountId === a.cash).map((e) => e.debit)).toEqual(["42.0000"]);
    expect(items.filter((e) => e.accountId === a.sales).map((e) => e.credit)).toEqual(["42.0000"]);
    // Base amounts are value × rate at scale 4 even at rate 1 (spec:1816) — the same path a JOURNAL takes.
    expect(items.map((e) => e.baseDebit)).toEqual(expect.arrayContaining(["42.0000", "0.0000"]));
  });

  it("POSTS: BRANCH lands on every ledger line of the new type without the policy mentioning it (spec:1066)", async () => {
    const id = await draft();
    await transition(id, "issued");
    await transition(id, "posted");
    const rows = await withTenant(
      api.db.rw,
      ctxOf("zero-code-branch"),
      (tx) => tx<{ code: string; dimension_value_id: string }[]>`
        select dt.code, d.dimension_value_id
          from app.ledger_entry_dimension d
          join app.ledger_entry l on l.id = d.entry_id
          join app.dimension_value dv on dv.id = d.dimension_value_id
          join app.dimension_type dt on dt.id = dv.dimension_type_id
         where l.document_id = ${id}`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.code === "BRANCH" && r.dimension_value_id === a.hq)).toBe(true);
  });

  it("REVERSES: reverseDocument produces a CONSIGNMENT_RETURN with the sides swapped and the original becomes reversed", async () => {
    const id = await draft();
    await transition(id, "issued");
    await transition(id, "posted");

    // Amendment A7: no HTTP reversal route ships at 2A. The service call is what 2B's handler will wrap.
    const ctx = ctxOf(await uuidv7(api.db.admin));
    const { reversalDocumentId, number } = await withTenant(api.db.rw, ctx, (tx) =>
      reverseDocument(tx, ctx, {
        documentId: id,
        effectiveDate: "2026-01-20",
        reason: "goods returned to consignor",
      }),
    );
    expect(number).toBeGreaterThan(0n);

    const original = await read(id);
    expect(original.status).toBe("reversed");

    const reversal = await read(reversalDocumentId);
    expect(reversal.documentTypeCode).toBe("CONSIGNMENT_RETURN"); // policy.reversal.producesType, from the body
    expect(reversal.status).toBe("posted");
    expect(reversal.reversesDocumentId).toBe(id);
    expect(reversal.series).toBe("CR");

    // The mirror: line 1 was a 42.0000 debit and is now a 42.0000 credit, on the same account.
    const byLine = new Map(reversal.lines.map((l) => [l.lineNo, l]));
    expect(byLine.get(1)).toMatchObject({ accountId: a.cash, debit: "0.0000", credit: "42.0000" });
    expect(byLine.get(2)).toMatchObject({ accountId: a.sales, debit: "42.0000", credit: "0.0000" });
  });

  it("REVERSES: after the reversal every account nets to zero across the two documents, and no row was removed", async () => {
    const id = await draft();
    await transition(id, "issued");
    await transition(id, "posted");
    const before = await withTenant(
      api.db.rw,
      ctxOf("zc-count-1"),
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.ledger_entry where company_id = ${a.company}`,
    );

    const ctx = ctxOf(await uuidv7(api.db.admin));
    const { reversalDocumentId } = await withTenant(api.db.rw, ctx, (tx) =>
      reverseDocument(tx, ctx, {
        documentId: id,
        effectiveDate: "2026-01-20",
        reason: "net to zero",
      }),
    );

    const nets = await withTenant(
      api.db.rw,
      ctxOf("zc-net"),
      (tx) => tx<{ account_id: string; net: string }[]>`
        select account_id, (sum(debit) - sum(credit))::text as net
          from app.ledger_entry
         where document_id in (${id}, ${reversalDocumentId})
         group by account_id order by account_id`,
    );
    expect(nets).toHaveLength(2);
    expect(nets.every((r) => Number(r.net) === 0)).toBe(true);

    // A reversal ADDS rows; it never subtracts (contracts §4.3.3 — account_balance stays a pure sum).
    const after = await withTenant(
      api.db.rw,
      ctxOf("zc-count-2"),
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.ledger_entry where company_id = ${a.company}`,
    );
    expect(after[0]!.n).toBe(before[0]!.n + 2);
  });

  it("a policy version added later takes effect from its own effective_from and never re-interprets history", async () => {
    // The zero-code claim includes CHANGING a type without code. Version 2 sends both legs to `1000` from
    // 2026-01-20; the 2026-01-15 documents above keep the rows version 1 produced, because the effective
    // policy is chosen by the document's effective_date and pinned at post (spec:1075, LEGACY-013).
    //
    // Both dates sit inside 2026-01, which is the ONLY open period `seedTenant` creates — §4.1 pins the three
    // as "2026-01 open, 2026-02 closed, 2026-03 locked". A February document would be refused at §4.3.2
    // step 5 with ERR_PERIOD_NOT_OPEN and this case would prove nothing about version 2.
    const v2 = await api.request({
      method: "POST",
      path: `${types()}/${documentTypeId}/policies`,
      as: a.human,
      body: {
        version: 2,
        effectiveFrom: "2026-01-20",
        definition: {
          ...POLICY,
          lines: [
            {
              for: "each_line",
              side: "debit",
              account: { code: "1000" },
              amount: "line.debit",
              when: { "line.kind": "account" },
            },
            {
              for: "each_line",
              side: "credit",
              account: { code: "1000" },
              amount: "line.credit",
              when: { "line.kind": "account" },
            },
          ],
        },
      },
    });
    expect(v2.status).toBe(201);

    const late = await draft({ effectiveDate: "2026-01-25" });
    // Both transitions are asserted. Without this, a refusal leaves `lateRows` empty and `[].every(…)` is
    // `true` — the case would go green while posting nothing, which is exactly how a period or policy error
    // hides here.
    expect((await transition(late, "issued")).status).toBe(200);
    expect((await transition(late, "posted")).status).toBe(200);

    const lateRows = await withTenant(
      api.db.rw,
      ctxOf("zc-v2"),
      (tx) => tx<{ account_id: string }[]>`
        select account_id from app.ledger_entry where document_id = ${late}`,
    );
    expect(lateRows).toHaveLength(2); // non-empty before the `every` below
    expect(lateRows.every((r) => r.account_id === a.cash)).toBe(true); // `1000` is seedTenant's cash account

    const latePin = await pinnedPolicyOf(late);
    const earlyPin = await pinnedPolicyOf(await firstEarlyJanuaryPosted());
    expect(latePin).not.toBeNull();
    expect(earlyPin).not.toBeNull();
    expect(latePin).not.toBe(earlyPin);
  });

  it("a second tenant's own admin lists their own types and CONSIGNMENT_RETURN is not among them (test 12)", async () => {
    // The point is RLS, not RBAC. B's admin is fully authorised **in B**, so `requirePermission` passes and the
    // query actually runs — and the row created in A is still invisible, because `tenant_isolation` is a
    // FORCED policy on `app.document_type` (spec:106). A test that asserted 403 on a foreign path would only
    // re-prove membership, which is exactly what the two `PROBES` entries of T10 and T11 already do
    // (§3.7.2) — and it would pass whether or not RLS worked at all.
    const b = await seedTenantV2(api.db, "ZeroCodeBeta");
    await grantAdmin(api, b);

    const own = await api.request({
      method: "GET",
      path: `/v1/companies/${b.company}/document-types`,
      as: b.human,
    });
    expect(own.status).toBe(200);
    const codes = ((await own.json()) as { items: { code: string }[] }).items.map((i) => i.code);
    expect(codes).toContain("JOURNAL"); // seedTenantV2 gives every tenant one
    expect(codes).not.toContain("CONSIGNMENT_RETURN"); // A's type, invisible to B

    // And B's admin cannot reach it by naming A's company: membership is checked before RLS is consulted, so
    // the refusal is ERR_RBAC_FORBIDDEN rather than an empty list — an invisible company never 404s into a
    // "does this exist?" oracle.
    const cross = await api.request({
      method: "GET",
      path: `${types()}?filter[code][eq]=CONSIGNMENT_RETURN`,
      as: b.human,
    });
    expect((await problemOf(cross)).code).toBe("ERR_RBAC_FORBIDDEN");
  });
});
