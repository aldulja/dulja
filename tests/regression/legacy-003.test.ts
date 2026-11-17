import { grantCodes } from "@dulja/db/test";
import { draftDocument, seedTenantV2, uuidv7 } from "@dulja/db/test";
import { sliceRegression, thinRegression } from "../support/regression";
import { postLines } from "../support/ledger";
import { payrollFixture, postPayrollRun } from "../invariants/support/payroll";
import { assertExplained, cutOverFixture, loadFromCorpus } from "../invariants/support/cut-over";

thinRegression(
  "LEGACY-003",
  "Nothing enforces that debits equal credits",
  "packages/db/test/ledger.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-003" };
    const doc = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await expect(
      withTenant(rw, ctx, (tx) =>
        postLines(tx, a, doc, [
          { account: a.cash, debit: "100" },
          { account: a.sales, credit: "90" },
        ]),
      ),
    ).rejects.toThrow(/ERR_LEDGER_UNBALANCED/);
    const [c] = await withTenant(
      rw,
      ctx,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.ledger_entry where document_id = ${doc}`,
    );
    expect(c!.n).toBe(0); // deferred to COMMIT: nothing from it survives
  },
);

sliceRegression(
  "LEGACY-003",
  "Nothing enforces that debits equal credits",
  "1A",
  "the deferred constraint trigger refuses an unbalanced document at COMMIT, whatever the caller does",
  async ({ db, rw, withTenant, expect }) => {
    const seed = await seedTenantV2(db, "LEGACY003-1A");
    await grantCodes(db, seed);
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "legacy003" };
    const doc = await uuidv7(db.admin);
    await expect(
      withTenant(rw, ctx, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${doc}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-01-15', 'MYR', ${seed.hq})`;
        await tx`insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id, debit, credit,
                                               currency, exchange_rate, base_debit, base_credit, effective_date,
                                               fiscal_period_id, posting_policy_id)
                 values (${seed.tenant}, ${seed.company}, ${doc}, 1, ${seed.cash}, 100.0000, 0, 'MYR', 1, 100.0000, 0,
                         '2026-01-15', ${seed.period}, ${seed.policy})`;
      }),
    ).rejects.toThrow(/ERR_LEDGER_UNBALANCED/);
  },
);

// 8B Task 13 — the payroll analogue. This block mints its OWN tenant on the shared container: `payrollFixture` is not
// idempotent (8B Execution handoff, T10/T13/T14 row).
sliceRegression(
  "LEGACY-003",
  "Nothing enforces that debits equal credits",
  "8B",
  "a posted PAYROLL run balances in base currency, and the deferred constraint is what says so",
  async ({ db, expect }) => {
    const s = await seedTenantV2(db, "LEGACY-003");
    const f = await payrollFixture(db, s);
    await grantCodes(db, s, { codes: ["hr.payroll.prepare"] });
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      payDate: "2026-02-05",
      effectiveDate: "2026-01-31",
    });
    const [sums] = await db.admin<{ d: string; c: string; n: number }[]>`
      select coalesce(sum(base_debit), 0)::text as d, coalesce(sum(base_credit), 0)::text as c,
             count(*)::int as n
        from app.ledger_entry where document_id = ${documentId}`;
    expect(sums!.n).toBeGreaterThan(0);
    expect(sums!.d).toBe(sums!.c);
    // The DEFERRED constraint is the control, not this assertion: an unbalanced document dies at COMMIT with
    // ERR_LEDGER_UNBALANCED, which the 1A block above pins for every document type alike.
  },
);

// 9B Task 5 — the cut-over analogue. A legacy trial balance that does not balance (LEGACY-003's own legacy shape) reaches
// Dulja as ONE OPENING_BALANCE whose residue sits on 3900, never as an unbalanced ledger. Its own tenant on 0B's
// memoised API (contracts §4.17.1): the load goes INTO the fixture, because the query below reads it.
sliceRegression(
  "LEGACY-003",
  "Nothing enforces that debits equal credits",
  "9B",
  "an unbalanced legacy trial balance reaches account 3900 and never an unbalanced ledger",
  async ({ withTenant, expect }) => {
    const f = await cutOverFixture("legacy-003-9b");
    await loadFromCorpus(f, "cut-over");
    const rows = await withTenant(
      f.api.db.rw,
      f.ctx,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, l.base_debit::text as debit, l.base_credit::text as credit
          from app.ledger_entry l join app.account a on a.id = l.account_id
          join app.document d on d.id = l.document_id
          join app.document_type t on t.id = d.document_type_id
         where d.company_id = ${f.ctx.companyId} and t.code = 'OPENING_BALANCE' and d.legacy_ref is null
         order by a.code`,
    );
    // The trial-balance opening (no legacy_ref; Task 7's open items are OPENING_BALANCE documents that carry one). The
    // balance accounts net to 5000 Dr; the controls are the sub-ledger loads'; the residue is 3900's, visibly.
    expect(rows).toEqual([
      { code: "1000", debit: "5000.0000", credit: "0.0000" },
      { code: "3900", debit: "0.0000", credit: "5000.0000" },
    ]);
    // The ledger nets to zero to the cent and every 3900 row is a cut-over line that says why it is there.
    await assertExplained(f);
  },
);
