import {
  grantCodes,
  draftDocument,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  uuidv7,
} from "@dulja/db/test";
import { thinRegression } from "../support/regression";
import { postLines } from "../support/ledger";

thinRegression(
  "LEGACY-013",
  "Reversal reads *current* document-type flags instead of what was originally applied",
  "packages/db/test/documents.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-013" };
    const doc = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await withTenant(rw, ctx, (tx) =>
      postLines(tx, a, doc, [
        { account: a.cash, debit: "7" },
        { account: a.sales, credit: "7" },
      ]),
    );

    // The rule that produced the row is PINNED on the row, not looked up when a reversal is written.
    const [col] = await db.admin<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'ledger_entry' and column_name = 'posting_policy_id'`;
    expect(col!.is_nullable).toBe("NO");
    const rows = await withTenant(
      rw,
      ctx,
      (tx) =>
        tx<
          { posting_policy_id: string }[]
        >`select posting_policy_id from app.ledger_entry where document_id = ${doc}`,
    );
    expect(rows.map((r) => r.posting_policy_id)).toEqual([a.policy, a.policy]);
  },
);

// ─── 2A ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; a later slice appends and never edits the block above. The two
// cases go through `sliceRegression` rather than a bare `describe` because 0B's body destructures
// `withTenant` and `expect` — a module-scope import of either here would be shadowed by it (`no-shadow`).
import { postDocument, reverseDocument } from "@dulja/db";
import { sliceRegression } from "../support/regression";

const POLICY_2A = {
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
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
};

sliceRegression(
  "LEGACY-013",
  "Reversal reads *current* document-type flags instead of what was originally applied",
  "2A",
  "a policy version back-dated after the post does not change what the reversal produces",
  async ({ db, rw, withTenant, expect }) => {
    const s = await seedTenantV2(db, "LEGACY013-2A");
    await grantCodes(db, s);
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    const typeId = await seedDocumentType(db, s, {
      code: "POLICY_TEST",
      policy: POLICY_2A,
      effectiveFrom: "2026-01-01",
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "legacy013-2a" };

    const doc = await withTenant(rw, ctx, async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${id}, ${s.tenant}, ${s.company}, ${typeId}, 'PT', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, debit)
               values (${s.tenant}, ${s.company}, ${id}, 1, 'account', ${s.cash}, 13.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, credit)
               values (${s.tenant}, ${s.company}, ${id}, 2, 'account', ${s.sales}, 13.0000)`;
      await postDocument(tx, ctx, { documentId: id });
      return id;
    });

    // The legacy defect, reproduced exactly: the governing rule CHANGES after the document is filed. 2A's
    // POST .../document-types/{id}/policies makes this an ordinary administrative act, and `effective_from`
    // 2026-01-10 is on or before the document's own 2026-01-15, so resolvePolicy by date now answers v2 —
    // whose `reversal.allowed` is false. If reverseDocument read the current answer, this call would refuse.
    await seedDocumentType(db, s, {
      code: "POLICY_TEST",
      policyVersion: 2,
      effectiveFrom: "2026-01-10",
      policy: { ...POLICY_2A, reversal: { allowed: false, producesType: null } },
    });

    const { reversalDocumentId } = await withTenant(rw, ctx, (tx) =>
      reverseDocument(tx, ctx, {
        documentId: doc,
        effectiveDate: "2026-01-25",
        reason: "legacy-013",
      }),
    );
    expect(reversalDocumentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // And the original's ledger rows still name version 1 — nothing was re-interpreted (spec:1753).
    const rows = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ version: number }[]>`
        select distinct p.version from app.ledger_entry l
          join app.posting_policy p on p.id = l.posting_policy_id
         where l.document_id = ${doc}`,
    );
    expect(rows.map((r) => r.version)).toEqual([1]);
  },
);

sliceRegression(
  "LEGACY-013",
  "Reversal reads *current* document-type flags instead of what was originally applied",
  "2A",
  "the reversal mirrors every generalised line column, so it reflects what was applied and not a subset",
  async ({ db, rw, withTenant, expect }) => {
    const s = await seedTenantV2(db, "LEGACY013-2Ab");
    await grantCodes(db, s);
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    const itemPolicy = {
      ...POLICY_2A,
      lines: [
        {
          for: "each_line",
          side: "debit",
          account: { code: "1000" },
          amount: "line.amount",
          when: { "line.kind": "item" },
        },
        {
          for: "each_line",
          side: "credit",
          account: { code: "4000" },
          amount: "line.amount",
          when: { "line.kind": "item" },
        },
      ],
    };
    const typeId = await seedDocumentType(db, s, { code: "POLICY_TEST", policy: itemPolicy });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "legacy013-2ab" };
    // A real item: 3A's `document_line_item_fk` makes `item_id` reference `app.item`, so the random UUIDv7
    // 2A wrote here (before the table existed) is now a 23503. The policy's `inventory.effect` is "none", so
    // the item moves no stock and the case still exercises only the line mirror.
    const { itemId } = await seedItem(db, s, { code: "LEGACY013-ITEM" });

    const doc = await withTenant(rw, ctx, async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${id}, ${s.tenant}, ${s.company}, ${typeId}, 'PT', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, item_id,
                                              quantity, unit_price, discount, amount, tax_amount, total_incl_tax)
               values (${s.tenant}, ${s.company}, ${id}, 1, 'item', ${itemId},
                       4.000000, 25.0000, 0.0000, 100.0000, 6.0000, 106.0000)`;
      await postDocument(tx, ctx, { documentId: id });
      return id;
    });

    const { reversalDocumentId } = await withTenant(rw, ctx, (tx) =>
      reverseDocument(tx, ctx, {
        documentId: doc,
        effectiveDate: "2026-01-25",
        reason: "legacy-013 mirror",
      }),
    );

    const [line] = await withTenant(
      rw,
      ctx,
      (tx) => tx<Record<string, string | null>[]>`
        select kind, item_id, quantity::text as quantity, unit_price::text as unit_price,
               amount::text as amount, tax_amount::text as tax_amount, total_incl_tax::text as total_incl_tax,
               cost::text as cost
          from app.document_line where document_id = ${reversalDocumentId}`,
    );
    // The legacy reversal copied a handful of columns and re-read the rest from the current type. This one
    // carries kind and item_id unchanged and NEGATES the signed magnitudes; `cost` is the costing engine's
    // answer for the reversal's own date (3B), never a copy.
    expect(line).toEqual({
      kind: "item",
      item_id: itemId,
      quantity: "-4.000000",
      unit_price: "25.0000",
      amount: "-100.0000",
      tax_amount: "-6.0000",
      total_incl_tax: "-106.0000",
      cost: null,
    });
  },
);

// ─── 4A (Phase 4 review, A8) ─────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: appended. A document PINS its payment term so the ageing cuts on what was agreed
// (§4.3.4); editing the term's days in place re-aged every document pinned to it — the same defect as a
// reversal re-reading current flags, reached through master data. 0045's payment_term_days_pinned refuses it.
import { issueDocument } from "@dulja/db";
import { seedPaymentTerm } from "@dulja/db/test";

sliceRegression(
  "LEGACY-013",
  "Reversal reads *current* document-type flags instead of what was originally applied",
  "4A",
  "a payment term's days cannot change under a document that is no longer a draft",
  async ({ db, rw, withTenant, expect }) => {
    const s = await seedTenantV2(db, "LEGACY013-4A");
    await grantCodes(db, s);
    const term = await seedPaymentTerm(db, s, { code: "N30-013", dueDays: 30 });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "legacy013-4a" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date,
                                         currency, branch_id, payment_term_id)
               values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq},
                       ${term})`;
    });
    // A draft does not fix the term: the days are still the term's own.
    await withTenant(
      rw,
      ctx,
      (tx) => tx`update app.payment_term set due_days = 45 where id = ${term}`,
    );
    await withTenant(rw, ctx, (tx) => issueDocument(tx, ctx, { documentId: doc }));
    await expect(
      withTenant(rw, ctx, (tx) => tx`update app.payment_term set due_days = 60 where id = ${term}`),
    ).rejects.toThrow(/ERR_CONFLICT_REFERENCE: payment term N30-013 is pinned on a document/);
    const [row] = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ d: number }[]>`select due_days as d from app.payment_term where id = ${term}`,
    );
    expect(row!.d).toBe(45);
  },
);

// 8B Task 14 — a payroll line keeps the rate-table version it USED. Its own tenant: payrollFixture is not idempotent.
import { seedRateTable } from "@dulja/db/test";
import { repoFile } from "../support/regression";
import { payrollFixture, postPayrollRun, SYNTH_TABLE } from "../invariants/support/payroll";

sliceRegression(
  "LEGACY-013",
  "Reversal reads current document-type flags instead of what was originally applied",
  "8B",
  "a posted payroll line keeps the rate-table version it used, and PAYROLL refuses reversal (ADR 0076)",
  async ({ db, withTenant, expect }) => {
    const s = await seedTenantV2(db, "LEGACY-013");
    const f = await payrollFixture(db, s);
    await grantCodes(db, s, { codes: ["hr.payroll.prepare"] });
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      payDate: "2026-02-05",
      effectiveDate: "2026-01-31",
    });
    const versions = () => db.admin<{ v: number }[]>`
      select distinct pl.rate_table_version as v from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${documentId} and pl.scheme_id is not null`;
    expect((await versions()).map((p) => p.v)).toEqual([1]);

    // A later verified version, from February. The posted lines are history and do not re-read it.
    await withTenant(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: "legacy-013-8b" },
      (tx) =>
        tx`update app.statutory_rate_table set effective_to = '2026-01-31' where id = ${f.rateTableId}`,
    );
    await seedRateTable(db, s, {
      schemeId: f.schemeId,
      version: 2,
      verified: true,
      definition: { ...SYNTH_TABLE, version: 2, effective_from: "2026-02-01" },
    });
    expect((await versions()).map((p) => p.v)).toEqual([1]);

    // There is no reversal path that could re-read a current rule: PAYROLL refuses reversal outright.
    const envelope = JSON.parse(repoFile("packages/db/seed/my/document-types/PAYROLL.json")) as {
      policy: { reversal: { allowed: boolean } };
    };
    expect(envelope.policy.reversal.allowed).toBe(false);
  },
);

// Full review 2026-11-15, DBS-03 (migration 0126) — the pin itself is history. `payroll_run.pinned_tables` and each
// line's `rate_table_version` record what was ORIGINALLY applied; once the run has left draft neither can be
// rewritten, even by the preparer who can see the run (ADR 0074 and 0076 amendments).
sliceRegression(
  "LEGACY-013",
  "Reversal reads current document-type flags instead of what was originally applied",
  "review 2026-11-15",
  "a posted run's pinned_tables and its lines' rate_table_version cannot be rewritten (DBS-03)",
  async ({ db, withTenant, expect }) => {
    const s = await seedTenantV2(db, "LEGACY-013-0126");
    const f = await payrollFixture(db, s);
    await grantCodes(db, s, { codes: ["hr.payroll.prepare"] });
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      payDate: "2026-02-05",
      effectiveDate: "2026-01-31",
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "legacy-013-0126" };
    await expect(
      withTenant(
        db.rw,
        ctx,
        (tx) =>
          tx`update app.payroll_run set pinned_tables = '[]'::jsonb where document_id = ${documentId}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    await expect(
      withTenant(
        db.rw,
        ctx,
        (tx) => tx`
          update app.payroll_line pl set rate_table_version = 2
            from app.document_line dl
           where dl.id = pl.document_line_id and dl.document_id = ${documentId} and pl.scheme_id is not null`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    const [run] = await db.admin<{ pinned: { version: number }[] }[]>`
      select pinned_tables as pinned from app.payroll_run where document_id = ${documentId}`;
    expect(run!.pinned.map((p) => p.version)).toEqual([1]);
  },
);
