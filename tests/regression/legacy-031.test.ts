import { Money, currency } from "@dulja/domain";
import {
  draftSettlement,
  importStatement,
  issueDocument,
  listStatementLines,
  match,
  postDocument,
  reverseDocument,
} from "@dulja/db";
import {
  draftDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedParty,
  seedTenantV2,
  uuidv7,
} from "@dulja/db/test";
import { repoFile, sliceRegression, thinRegression } from "../support/regression";
import { postLines } from "../support/ledger";
import { arApFixture, postFromPack } from "../invariants/support/ar-ap";

thinRegression(
  "LEGACY-031",
  "Period locks live on a sibling table, are per-privilege-tier, and do not reach the line items",
  "packages/db/test/ledger.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-031" };
    for (const [period, date] of [
      [a.closedPeriod, "2026-02-10"],
      [a.lockedPeriod, "2026-03-10"],
    ] as const) {
      const doc = await draftDocument(db, a, {
        periodId: period,
        effectiveDate: date,
        clientRef: await uuidv7(db.admin),
      });
      await expect(
        withTenant(rw, ctx, (tx) =>
          postLines(
            tx,
            a,
            doc,
            [
              { account: a.cash, debit: "1" },
              { account: a.sales, credit: "1" },
            ],
            period,
            date,
          ),
        ),
      ).rejects.toThrow(/ERR_PERIOD_NOT_OPEN/); // refused on the LINE, for every privilege tier
    }
  },
);

sliceRegression(
  "LEGACY-031",
  "Period locks per-tier, on a sibling table, not on the lines",
  "1A",
  "the lock is on ledger_entry itself: a locked period refuses the line, not merely the header",
  async ({ db, rw, withTenant, expect }) => {
    const seed = await seedTenantV2(db, "LEGACY031-1A");
    await grantCodes(db, seed);
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "legacy031" };
    const doc = await uuidv7(db.admin);
    await withTenant(
      rw,
      ctx,
      (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${doc}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-03-15', 'MYR', ${seed.hq})`,
    );
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`
        insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency,
                                      exchange_rate, base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id)
        values (${seed.tenant}, ${seed.company}, ${doc}, 1, ${seed.cash}, 1.0000, 0, 'MYR', 1, 1.0000, 0, '2026-03-15', ${seed.lockedPeriod}, ${seed.policy})`,
      ),
    ).rejects.toThrow(/ERR_PERIOD_NOT_OPEN/);
  },
);

// ─── 4A ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; 4A appends and never edits the blocks above. A RECEIPT or PAYMENT is
// one bank line posted against the party's control account (4A Task 10); what it posted is immutable in place
// exactly as a journal's is, and a correction is a reversal of the same type. Allocation rows are NOT claimed
// immutable here: `unallocate` is an UPDATE of the row by design (§4.8.1), and 4A T9 records that nothing but
// the service guards `amount` against a bare app_rw UPDATE.

/** The pack's own RECEIPT policy, read rather than re-typed (hazard 9); `repoFile` resolves from the root. */
const receiptPolicy = (): unknown =>
  (
    JSON.parse(repoFile("packages/db/seed/my/document-types/RECEIPT.json")) as {
      policy: unknown;
    }
  ).policy;

sliceRegression(
  "LEGACY-031",
  "A posted settlement is immutable in place, and correcting one is a reversal",
  "4A",
  "a posted RECEIPT's ledger rows cannot be updated or deleted by app_rw; its reversal nets them to zero",
  async ({ db, rw, withTenant, expect }) => {
    const seed = await seedTenantV2(db, "LEGACY031-4A");
    await grantCodes(db, seed);
    await seedAccount(db, seed, { code: "1100", nameEn: "Bank", type: "asset" });
    const rctType = await seedDocumentType(db, seed, {
      code: "RECEIPT",
      module: "accounting",
      policy: receiptPolicy(),
    });
    const partyId = await seedParty(db, seed, { kind: "customer", code: "LEGACY031-CUST" });
    await grantCodes(db, seed, {
      codes: ["accounting.receipt.create", "accounting.receipt.post"],
    });
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "legacy031-4a" };
    const [bank] = await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${seed.company} and code = '1100'`;
    const { documentId } = await withTenant(rw, ctx, async (tx) => {
      const d = await draftSettlement(tx, ctx, {
        companyId: seed.company,
        documentTypeId: rctType,
        series: "RCT",
        effectiveDate: "2026-01-15",
        partyId,
        bankAccountId: bank!.id,
        currency: "MYR",
        exchangeRate: "1.00000000",
        amount: "42.0000",
      });
      await issueDocument(tx, ctx, { documentId: d.documentId });
      await postDocument(tx, ctx, { documentId: d.documentId });
      return d;
    });

    // Belt: app_rw holds no UPDATE or DELETE on the ledger at all. Braces: the trigger refuses anyway.
    const [grants] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'ledger_entry'
         and privilege_type in ('UPDATE', 'DELETE')`;
    expect(grants!.n).toBe(0);
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`update app.ledger_entry set credit = 0 where document_id = ${documentId}`,
      ),
    ).rejects.toThrow(/permission denied|ERR_TABLE_IMMUTABLE/);
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`delete from app.ledger_entry where document_id = ${documentId}`,
      ),
    ).rejects.toThrow(/permission denied|ERR_TABLE_IMMUTABLE/);

    // The correction: a RECEIPT with negated magnitudes (reversal.producesType is the type's own code), after
    // which the bank and the control account are back where they were — and the original rows are untouched.
    const { reversalDocumentId } = await withTenant(rw, ctx, (tx) =>
      reverseDocument(tx, ctx, {
        documentId,
        effectiveDate: "2026-01-16",
        reason: "banked in error",
      }),
    );
    const rows = await db.admin<{ code: string; doc: string; net: string }[]>`
      select a.code, e.document_id as doc, sum(e.debit - e.credit)::numeric(19,4)::text as net
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id in (${documentId}, ${reversalDocumentId})
       group by a.code, e.document_id order by a.code, e.document_id = ${reversalDocumentId}`;
    expect(rows).toEqual([
      { code: "1100", doc: documentId, net: "42.0000" },
      { code: "1100", doc: reversalDocumentId, net: "-42.0000" },
      { code: "1200", doc: documentId, net: "-42.0000" },
      { code: "1200", doc: reversalDocumentId, net: "42.0000" },
    ]);
    const [reversal] = await db.admin<{ code: string; status: string }[]>`
      select t.code, (select status::text from app.document where id = ${documentId}) as status
        from app.document d join app.document_type t on t.id = d.document_type_id
       where d.id = ${reversalDocumentId}`;
    expect(reversal).toEqual({ code: "RECEIPT", status: "reversed" });
  },
);

sliceRegression(
  "LEGACY-031",
  "A posted settlement is immutable in place, and correcting one is a reversal",
  "4A",
  "both settlement types declare a reversal into their own type in the seeded policy",
  async ({ expect }) => {
    // Declared, and for a RECEIPT exercised above. A PAYMENT's is declared only: `reverseDocument` drafts the
    // reversal and posts it straight through `issued`, which 0022 refuses for an `approval.required` type
    // (ERR_DOC_STATUS_ILLEGAL), so a posted PAYMENT cannot be reversed through it today — recorded by 4A T10
    // as a 1A/2B gap for every approval-required type, not asserted here.
    for (const code of ["RECEIPT", "PAYMENT"]) {
      const envelope = JSON.parse(repoFile(`packages/db/seed/my/document-types/${code}.json`)) as {
        policy: { reversal: { allowed: boolean; producesType: string } };
      };
      expect(envelope.policy.reversal, code).toEqual({ allowed: true, producesType: code });
    }
  },
);

// ─── 4B ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; 4B appends and never edits the blocks above. ADR 0048: a match is a
// row in app.bank_match and nothing else. The old system's failure was a direct UPDATE on a signed, locked,
// closed-period voucher that silently rewrote AccTotals; here matching writes no ledger row, so a period lock
// has nothing to refuse — a match against a document in a LOCKED period succeeds, and that is the correct
// answer, not a loophole: the locked period's ledger rows are byte-identical afterwards.
sliceRegression(
  "LEGACY-031",
  "Period locks reach the lines, and reconciliation does not touch them",
  "4B",
  "a match against a document in a LOCKED period succeeds and that period's ledger rows are byte-identical",
  async ({ db, rw, withTenant, expect }) => {
    // The tenant is this block's OWN, not the shared `a`/`b` seeds: `arApFixture` calls 3B's
    // `ensureOpenPeriods`, which REOPENS 2026-01..03, and doing that to a shared seed would break every other
    // regression file that reads `a.lockedPeriod` as locked.
    const s = await seedTenantV2(db, "LEGACY031-4B");
    await grantCodes(db, s);
    const f = await arApFixture(db, s);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };

    // Post the receipt into 2026-03 while it is open…
    const { documentId: receiptId } = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-03-10",
      partyId: f.partyIds.customer,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount: "400.0000" }],
    });
    // …then LOCK it: the old system's exact scenario — a posted voucher in a locked period. `db.migrator` as
    // `s.system` is 3B's own form for a fixture period change (ensureOpenPeriods), because app_rw's grants on
    // app.fiscal_period are not this block's to assume.
    const [locked] = await withTenant(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ id: string }[]>`
        update app.fiscal_period set status = 'locked'
         where company_id = ${s.company} and starts_on = '2026-03-01'::date
        returning id`,
    );
    expect(locked).toBeDefined();

    const fingerprint = async () => {
      const [row] = await withTenant(
        rw,
        ctx,
        (tx) => tx<{ h: string | null; n: number }[]>`
          select md5(string_agg(concat_ws(':', id::text, account_id::text, debit::text, credit::text,
                                          base_debit::text, base_credit::text, effective_date::text),
                                '|' order by id)) as h,
                 count(*)::int as n
            from app.ledger_entry where fiscal_period_id = ${locked!.id}`,
      );
      return row!;
    };
    const before = await fingerprint();
    expect(before.n).toBe(2); // the receipt really is IN the locked period, both legs of it

    const { statementId } = await withTenant(rw, ctx, (tx) =>
      importStatement(tx, ctx, {
        companyId: s.company,
        bankAccountId: f.accountIds["1100"]!,
        csv: "2026-03-10,RECEIPT CUST-1,RCT,400.00",
        mapping: {
          statement: {
            statementDate: "2026-03-31",
            openingBalance: "0.0000",
            closingBalance: "400.0000",
          },
          columns: { valueDate: 0, description: 1, reference: 2, amount: 3 },
          dateFormat: "YYYY-MM-DD",
          hasHeader: false,
        },
      }),
    );
    const lines = await withTenant(rw, ctx, (tx) =>
      listStatementLines(tx, { companyId: s.company, statementId, limit: 10 }),
    );
    const { matchId } = await withTenant(rw, ctx, (tx) =>
      match(tx, ctx, {
        companyId: s.company,
        statementLineId: lines[0]!.id,
        reconcilable: { kind: "receipt", documentId: receiptId },
        amount: Money.of("400.0000", currency("MYR")),
      }),
    );

    // The match row exists and is live — the lock did not refuse it, because no lock reaches bank_match…
    const [row] = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ unmatched_at: string | null }[]>`
        select unmatched_at from app.bank_match where id = ${matchId}`,
    );
    expect(row!.unmatched_at).toBeNull();
    // …the period is still locked, and not one byte of its ledger moved.
    const [period] = await db.admin<{ status: string }[]>`
      select status::text as status from app.fiscal_period where id = ${locked!.id}`;
    expect(period!.status).toBe("locked");
    expect(await fingerprint()).toEqual(before);
  },
);

sliceRegression(
  "LEGACY-031",
  "Period locks reach the lines, and reconciliation does not touch them",
  "4B",
  "the reconciliation module writes only its own three tables — no ledger, projection or document row",
  async ({ expect }) => {
    const source = repoFile("packages/db/src/ar-ap/reconciliation.ts");
    for (const forbidden of [
      "insert into app.ledger_entry",
      "update app.ledger_entry",
      "update app.account_balance",
      "update app.document ",
      "delete from app.",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // Stronger than the list above: EVERY DML target the file names is one of reconciliation's own tables.
    const targets = new Set(
      [
        ...source.matchAll(
          /\b(?:insert\s+into|update|delete\s+from|merge\s+into)\s+(app\.[a-z_]+)/gi,
        ),
      ].map((m) => m[1]!.toLowerCase()),
    );
    expect([...targets].toSorted()).toEqual([
      "app.bank_match",
      "app.bank_statement",
      "app.bank_statement_line",
    ]);
  },
);

// ─── code review 3 (R10, migration 0117) ─────────────────────────────────────────────────────────────────
// contracts §3.7.3: appended; it edits none of the blocks above. spec:501 and 2223: "immutability is enforced
// on the whole document aggregate (header + lines + projections)". The ledger was immutable (1A) and the lines
// since 0113; the header was the gap — a posted document could be re-dated or re-rated under a ledger that no
// longer agreed with it. An ISSUED document is part of the aggregate too.
sliceRegression(
  "LEGACY-031",
  "Immutability reaches the whole document aggregate, header and lines",
  "code review 3",
  "neither a posted nor an issued document's header or lines can be changed, and the posted ledger stands",
  async ({ db, rw, withTenant, expect }) => {
    const seed = await seedTenantV2(db, "LEGACY031-CR3");
    await grantCodes(db, seed);
    await grantCodes(db, seed, { codes: ["accounting.journal.post"] });
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: await uuidv7(db.admin) };
    const journal = async (): Promise<string> => {
      const doc = await uuidv7(db.admin);
      await withTenant(rw, ctx, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${doc}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-01-15', 'MYR', ${seed.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${seed.tenant}, ${seed.company}, ${doc}, 1, ${seed.cash}, 9.0000)`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${seed.tenant}, ${seed.company}, ${doc}, 2, ${seed.sales}, 9.0000)`;
      });
      return doc;
    };
    const aggregate = async (doc: string) => {
      const [row] = await db.admin<{ h: unknown; l: unknown; e: unknown }[]>`
        select (select to_jsonb(d) from app.document d where d.id = ${doc}) as h,
               (select jsonb_agg(to_jsonb(l) order by l.line_no) from app.document_line l
                 where l.document_id = ${doc}) as l,
               (select jsonb_agg(to_jsonb(e) order by e.line_no) from app.ledger_entry e
                 where e.document_id = ${doc}) as e`;
      return row!;
    };

    const posted = await journal();
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: posted }));
    const issued = await journal();
    await withTenant(rw, ctx, (tx) => issueDocument(tx, ctx, { documentId: issued }));

    for (const [doc, status] of [
      [posted, "posted"],
      [issued, "issued"],
    ] as const) {
      const before = await aggregate(doc);
      await expect(
        withTenant(
          rw,
          ctx,
          (tx) => tx`update app.document set exchange_rate = 3.5 where id = ${doc}`,
        ),
        `${status} header`,
      ).rejects.toThrow(
        new RegExp(
          `ERR_DOC_NOT_DRAFT: document .* is ${status}; its header cannot be changed \\(exchange_rate\\)`,
        ),
      );
      await expect(
        withTenant(
          rw,
          ctx,
          (tx) =>
            tx`update app.document_line set debit = 90.0000 where document_id = ${doc} and line_no = 1`,
        ),
        `${status} line`,
      ).rejects.toThrow(new RegExp(`ERR_DOC_NOT_DRAFT: document .* is ${status}; its line`));
      expect(await aggregate(doc)).toEqual(before);
    }
    const [count] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where document_id = ${posted}`;
    expect(count!.n).toBe(2);
  },
);

import { beforeAll, describe, it, expect as expect6d } from "vitest";
import type { Sql } from "postgres";
import { applyBatch, withTenant as withTenant6d } from "@dulja/db";
import { sharedApi } from "../support/api";
import { buildTicket } from "../invariants/support/pos";
import { staffFixture, type StaffFixture } from "../invariants/support/staff";
describe("LEGACY-031 Direct table writes bypass every control — 6D", () => {
  let f: StaffFixture;
  let ctx: { tenantId: string; actorId: string; requestId: string };
  let shiftId: string; // closed, with a posted TILL_OVER_SHORT
  let openShiftId: string; // still open, for the atomicity case
  let eventId: string; // a till_event of the closed shift

  beforeAll(async () => {
    const { api } = await sharedApi();
    f = await staffFixture(api, "legacy031-6d");
    ctx = { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, requestId: "legacy031-6d" };
    await grantCodes(api.db, f.seed, {
      codes: ["pos.shift.own"],
      principalId: f.cashierA,
      roleCode: "s031-own",
      branchIds: [f.branchA],
    });

    const batch = (body: Record<string, unknown>) =>
      withTenant6d(api.db.rw, ctx, (tx) =>
        applyBatch(
          tx,
          ctx,
          {
            terminalId: f.terminalA.terminalId,
            companyId: f.seed.company,
            branchId: f.branchA,
            principalId: f.terminalA.principalId,
          },
          {
            terminalId: f.terminalA.terminalId,
            batchId: crypto.randomUUID(),
            tickets: [],
            shifts: [],
            tillEvents: [],
            ...body,
          },
        ),
      );

    shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await batch({
      tickets: [
        buildTicket(f.pos, { sku: "SKU-A", shiftId, unitPrice: "40.0000", tender: "cash" }),
      ],
    });
    const ev = await batch({
      tillEvents: [
        {
          clientRef: crypto.randomUUID(),
          shiftId,
          kind: "no_sale",
          ticketClientRef: null,
          cashierPrincipalId: f.cashierA,
          supervisorPrincipalId: null,
          occurredAt: new Date().toISOString(),
        },
      ],
    });
    expect6d(ev.tillEventResults[0]!.status).toBe("accepted");
    const [row] = await api.db.admin<{ id: string }[]>`
      select id::text from app.till_event where client_ref = ${ev.tillEventResults[0]!.ref}::uuid`;
    eventId = row!.id;
    // 100 float + 40 sold = 140 expected; counted 137 → 3.00 short, so a TILL_OVER_SHORT is posted and
    // the "a correction is a document" claim below has a document to be about.
    const closed = await batch({
      shifts: [
        {
          shiftId,
          kind: "close",
          terminalId: f.terminalA.terminalId,
          cashierPrincipalId: f.cashierA,
          at: new Date().toISOString(),
          currency: "MYR",
          openingFloat: null,
          countedCash: { amount: "137.0000", currency: "MYR" },
        },
      ],
    });
    // Asserted here, not assumed: a refused first close would leave no figure and no document, and the
    // re-sent close below would then compare two empty drawers and prove nothing.
    expect6d(closed.shiftResults[0]).toMatchObject({ status: "accepted", error: null });
    openShiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "5.0000" });

    // The two direct-write actors, and the two `withTenant`s they need. `asMigrator` holds the privilege
    // the trigger and the CHECK must override; `asRw` is the application role.
    asMigrator = (fn) =>
      withTenant6d(
        api.db.migrator,
        { tenantId: f.seed.tenant, actorId: f.seed.system, requestId: "legacy031-6d" },
        fn,
      );
    asRw = (fn) => withTenant6d(api.db.rw, ctx, fn);
    db = api.db;
    closeShiftFor = (shift, counted) =>
      batch({
        shifts: [
          {
            shiftId: shift,
            kind: "close",
            terminalId: f.terminalA.terminalId,
            cashierPrincipalId: f.cashierA,
            at: new Date().toISOString(),
            currency: "MYR",
            openingFloat: null,
            countedCash: { amount: counted, currency: "MYR" },
          },
        ],
      });
  }, 600_000);

  // Assigned in `beforeAll` because they close over the fixture. Typed here so the cases read cleanly.
  let db: Awaited<ReturnType<typeof sharedApi>>["api"]["db"];
  let asMigrator: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
  let asRw: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
  let closeShiftFor: (
    shift: string,
    counted: string,
  ) => Promise<Awaited<ReturnType<typeof applyBatch>>>;

  /** The four close columns, the over/short document id, and that document's own ledger totals —
   *  Task 8's `snapshot` narrowed to one drawer. Anything a direct write could move is in here. */
  const drawerFingerprint = async (shift: string) => {
    const [row] = await db.admin<
      {
        counted: string | null;
        expected: string | null;
        over_short: string | null;
        closed_at: string | null;
        doc: string | null;
        entries: number;
        debit: string;
        credit: string;
      }[]
    >`
      select s.counted_cash::text as counted, s.expected_cash::text as expected,
             s.over_short::text as over_short, s.closed_at::text as closed_at,
             s.over_short_document_id::text as doc,
             (select count(*)::int from app.ledger_entry le
               where le.document_id = s.over_short_document_id)                       as entries,
             (select coalesce(sum(le.debit), 0)::text from app.ledger_entry le
               where le.document_id = s.over_short_document_id)                       as debit,
             (select coalesce(sum(le.credit), 0)::text from app.ledger_entry le
               where le.document_id = s.over_short_document_id)                       as credit
        from app.shift s where s.id = ${shift}`;
    return row!;
  };

  it("a re-sent close writes nothing: the counted figure and its document are both frozen", async () => {
    // The new-system sentence is "a correction is a document, never an update". A till that re-sends its
    // close — which it will, after any timeout — must not rewrite a figure a Z-report was built on.
    const before = await drawerFingerprint(shiftId);
    // The drawer under test is really closed: 140 expected, 137 counted, 3.00 short, and the over/short
    // posted as one two-entry TILL_OVER_SHORT. Without these an unclosed shift would pass the comparison.
    expect6d(before).toMatchObject({
      counted: "137.0000",
      expected: "140.0000",
      over_short: "-3.0000",
      entries: 2,
      debit: "3.0000",
      credit: "3.0000",
    });
    expect6d(before.closed_at).not.toBeNull();
    expect6d(before.doc).not.toBeNull();
    const resent = await closeShiftFor(shiftId, "9999.0000");
    // Acknowledged as the close it already is, so the till clears its outbox row — and nothing moved.
    expect6d(resent.shiftResults[0]).toMatchObject({ status: "duplicate", error: null });
    expect6d(await drawerFingerprint(shiftId)).toEqual(before);
  });

  it("no code outside packages/db/src/posting writes a ledger row for a till document", () => {
    // The mechanical half. `posting-only-tables` (§3.7.5) is the build gate; this asserts the ALLOW-LIST
    // itself was not widened to get this slice's code through, which is the failure mode a lint rule
    // cannot catch about itself.
    const rule = repoFile("scripts/lint/rules/posting-only-tables.ts");
    expect6d(rule).not.toContain("packages/db/src/sync");
    expect6d(rule).not.toContain("packages/db/src/reports");
    expect6d(rule).not.toContain("packages/db/src/ar-ap");
  });

  it("a till_event cannot be updated or deleted, even by app_migrator", async () => {
    await expect6d(
      asMigrator((tx) => tx`update app.till_event set kind = 'void' where id = ${eventId}`),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect6d(
      asMigrator((tx) => tx`delete from app.till_event where id = ${eventId}`),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
  });

  it("the shift's close columns are all-or-nothing: no half-closed row can be written", async () => {
    // `shift_close_is_atomic` (0070). A direct UPDATE setting counted_cash without closed_at is the
    // shape LEGACY-031 describes, and the constraint refuses it at the row.
    await expect6d(
      asRw((tx) => tx`update app.shift set counted_cash = 1 where id = ${openShiftId}`),
    ).rejects.toThrow(/shift_close_is_atomic/);
  });
});

// 8B Task 14 — the lock reaches app.payroll_line, where every payslip figure lives. Its own tenant: payrollFixture
// is not idempotent.
import { payrollFixture, postPayrollRun } from "../invariants/support/payroll";

sliceRegression(
  "LEGACY-031",
  "Period locks … do not reach the line items",
  "8B",
  "a posted run's payroll lines refuse an edit, under an open period and a locked one alike",
  async ({ db, withTenant, expect }) => {
    const s = await seedTenantV2(db, "LEGACY-031");
    const f = await payrollFixture(db, s);
    await grantCodes(db, s, { codes: ["hr.payroll.prepare"] });
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      payDate: "2026-02-05",
      effectiveDate: "2026-01-31",
    });
    const [line] = await db.admin<{ id: string; period: string }[]>`
      select pl.document_line_id as id, d.fiscal_period_id as period from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
        join app.document d on d.id = dl.document_id
       where dl.document_id = ${documentId} limit 1`;
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "legacy-031-8b" };
    const edit = () =>
      withTenant(
        db.rw,
        ctx,
        (tx) =>
          tx`update app.payroll_line set amount = '1.0000' where document_line_id = ${line!.id}`,
      );
    await expect(edit()).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    await withTenant(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: "legacy-031-8b" },
      (tx) => tx`update app.fiscal_period set status = 'locked' where id = ${line!.period}`,
    );
    await expect(edit()).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  },
);
