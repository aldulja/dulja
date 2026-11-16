// packages/db/src/posting/tax.ts
import type { Sql } from "postgres";
import { toBase, type DocumentSnapshot, type PostingPlan } from "@dulja/domain";
import { resolveRegimeFor } from "../tax/codes";
import { PostingError } from "./errors";

/**
 * §4.3.2 step 11: "Insert `app.tax_transaction` rows (5A+)".
 *
 * **This function is the ONE writer of `app.tax_transaction`** — the table is on the `posting-only-tables`
 * list 1A shipped (§3.7.5) and is immutable to `app_rw` besides, so a second writer would fail the lint and
 * then the database.
 *
 * `plan.taxLines` carries **signed** amounts: `PlannedTaxLine.amount` is A9's one registered exception to
 * sign normalisation, because a credit note's tax is genuinely negative tax and the return needs the sign.
 * Nothing here reads a sign to choose a direction — there is no side to choose.
 *
 * The base twins are `toBase(value, snapshot.header.exchangeRate)`, which is `round(value x rate, 4)`
 * HALF_AWAY_FROM_ZERO — the same arithmetic `ledger_entry`'s CHECK applies (spec:1816, hazard 23), so a
 * return filed in base currency and the ledger's tax leg agree by construction rather than by luck.
 *
 * **`regime_id` comes from `resolveRegimeFor`, NOT from `snapshot.refs.taxCodes`.** The map is typed
 * `Record<string, TaxCodeRef>` (§4.4.2), and `TaxCodeRef` has no `regimeId` member — 5A's `TaxCodeDef` is a
 * SUPERSET of it, so the objects go *in* unconverted, but a value read back *out* is statically a
 * `TaxCodeRef` and `code.regimeId` is `TS2339`. Widening `TaxCodeRef` is not the answer either: it is a
 * frozen §4.4.2 shape and 2A's own evaluator tests build literal `refs.taxCodes` entries (phase-2a:1380)
 * that a new required member would break. `resolveRegimeFor` is already this slice's function, already
 * returns the document's one regime, and re-asserts the single-regime invariant at POST time as well as at
 * compute time — which is worth having, because `computeDocumentTax` ran when the lines were saved and a
 * post can be minutes later.
 */
export async function insertTaxTransactions(
  tx: Sql,
  input: {
    plan: PostingPlan;
    snapshot: DocumentSnapshot;
    postingSeq: bigint;
    fiscalPeriodId: string;
  },
): Promise<string[]> {
  const { plan, snapshot, postingSeq, fiscalPeriodId } = input;
  if (plan.taxLines.length === 0) return [];

  // Non-null by construction: a planned tax line exists only because a document line carried a code, which
  // is exactly the condition under which resolveRegimeFor returns a regime rather than null. The guard is
  // the loud form of that argument rather than a `!`.
  const regime = await resolveRegimeFor(tx, snapshot.header.id);
  if (!regime) {
    throw new PostingError(
      "ERR_TAX_REGIME_MISMATCH",
      `document ${snapshot.header.id} planned ${plan.taxLines.length} tax line(s) but no line carries a tax code`,
    );
  }

  // **A FILED return's period takes no new tax facts** (PR 11 review, round 3). A return reads every
  // tax_transaction whose effective_date its inclusive range covers, once, when it is generated; a row
  // dated inside a filed range afterwards is in no return — the filed one is never regenerated and the next
  // one's period filter excludes it. So a taxed document, a credit note or a reversal dated there is
  // refused: a filed return is corrected by a later period's return, not by a document dated inside it.
  //
  // `for share`, as step 5 takes the fiscal period: `fileTaxReturn` locks the return FOR UPDATE, so a
  // filing that committed first is seen here as `filed`, and a filing that arrives while this post is in
  // flight waits for it to commit and then finds its payload stale. A post into a range only `generated`
  // proceeds and makes that return stale, which `fileTaxReturn` refuses until it is regenerated. The two
  // sides take their locks in ONE order, so they queue rather than deadlock: this post has held the
  // tenant's audit-chain lock since its first audited write (the issue, or step 8's UPDATE of the document)
  // and takes the return row only here, and `generateTaxReturn` and `fileTaxReturn` take that same lock
  // (`lockTenantAuditSerial`) before they lock the row.
  const covering = await tx<
    { id: string; period_start: string; period_end: string; status: string }[]
  >`
    select id, period_start::text, period_end::text, status from app.tax_return
     where company_id = ${snapshot.company.id} and regime_id = ${regime.id}
       and period_start <= ${snapshot.header.effectiveDate}
       and period_end   >= ${snapshot.header.effectiveDate}
     order by period_start, id
       for share`;
  const filed = covering.find((r) => r.status === "filed");
  if (filed) {
    throw new PostingError(
      "ERR_PERIOD_NOT_OPEN",
      `the tax period ${filed.period_start}..${filed.period_end} is filed (tax return ${filed.id}); ` +
        `document ${snapshot.header.id} is dated ${snapshot.header.effectiveDate} — date it in an open tax period`,
    );
  }

  const ids: string[] = [];
  for (const t of plan.taxLines) {
    if (!snapshot.refs.taxCodes[t.taxCodeId]) {
      throw new PostingError(
        "ERR_TAX_REGIME_MISMATCH",
        `planned tax line ${t.lineNo} names tax code ${t.taxCodeId}, which loadSnapshot did not resolve`,
      );
    }
    const [row] = await tx<{ id: string }[]>`
      insert into app.tax_transaction (tenant_id, company_id, document_id, line_no, tax_code_id, regime_id,
                                       base, tax, base_base, tax_base,
                                       effective_date, fiscal_period_id, posting_seq)
      values (app.current_tenant(), ${snapshot.company.id}, ${snapshot.header.id}, ${t.lineNo},
              ${t.taxCodeId}, ${regime.id},
              ${t.base.toString()}, ${t.amount.toString()},
              ${toBase(t.base, snapshot.header.exchangeRate).toString()},
              ${toBase(t.amount, snapshot.header.exchangeRate).toString()},
              ${snapshot.header.effectiveDate}, ${fiscalPeriodId}, ${postingSeq.toString()})
      returning id`;
    ids.push(row!.id);
  }
  return ids;
}
