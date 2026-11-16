import type { Sql } from "postgres";
import { Money, type CurrencyCode } from "@dulja/domain";
import type { LegacyRow } from "../legacy/types";
import type { AccountTreatment } from "./account-map";
import { accountMap } from "./accounts";
import {
  draftAndPost,
  refuseForeignPostings,
  refusePriorOpening,
  type ImportedLine,
} from "./document";
import { baseCurrency, EMPTY_TARGET } from "./run";
import { moneyOf, requireText } from "./scalar";
import {
  LoadError,
  type LoadContext,
  type Loader,
  type RefResolver,
  type SourceColumn,
} from "./types";

/** One mapped `AccTotals` row: a `balance` account's stored totals, about to open on its Dulja account. */
export interface OpeningBalanceTarget {
  legacyCode: string;
  accountId: string;
  treatment: AccountTreatment;
  debit: Money<CurrencyCode>;
  credit: Money<CurrencyCode>;
}

/** Contracts §4.15's opening-balance suspense (9B plan N8): the one account the trial-balance opening's residue, the
 *  `OPENING_STOCK` credit leg (round 20 C11) and §5.1 #2's report all name. Fixed here so they cannot disagree. ⚠️ OD-25
 *  decides its TREATMENT; the code is not the owner's to move. */
export const SUSPENSE_CODE = "3900";

const COLUMNS: readonly SourceColumn[] = [
  {
    name: "ACTACC",
    required: true,
    confidence: "hypothesis",
    note: "the chart code this total belongs to (AccTotals, prefix ACT) — Accounts.AccCode, which the account loader keys on",
  },
  {
    name: "ACTDEBIT",
    required: true,
    confidence: "hypothesis",
    note: "the stored debit total — loaded as the opening, and compared, not trusted: 9A's aggregate_drift report quantifies its difference from VouItems (§5.1 #1)",
  },
  {
    name: "ACTCREDIT",
    required: true,
    confidence: "hypothesis",
    note: "the stored credit total — the same",
  },
];

/**
 * `ACCTOTALS` → ONE `OPENING_BALANCE` document carrying the whole trial balance, balanced against `3900` (§5.1 #1, #2;
 * contracts §4.14).
 *
 * Three account treatments are DELIBERATELY absent from its lines, and their absence is what stops the cut-over
 * double-counting:
 *   `ar_control`        — supplied per party by the open-item load (Task 7), which is also what 4B's ageing tie-out reads;
 *   `ap_control`        — the same, on the payables side;
 *   `inventory_control` — supplied by `OPENING_STOCK` at a RECOMPUTED cost (Task 6), because §5.1 #6 forbids importing
 *                         the legacy cost figures at all.
 * `exclude` accounts and codes the map does not name are reported and not loaded. Every other row is a `balance` line at
 * its NET, and whatever the exclusions and the legacy imbalance (SAH-003) leave over lands on `3900`, where it is visible
 * and where Task 10's reconciliation explains it — never dropped and never spread over a real account.
 *
 * Source key: the bare `ACTACC`, which is also how `map` resolves the account (`refs.byLegacyRef("account", ACTACC)` —
 * the account loader keys on `ACCCODE`). `targetTable` is `opening_balance`, not `document`: it is this loader's
 * identity in `import_batch` and the report, and Task 7's open items write `document` rows of the same type.
 */
export const openingBalanceLoader: Loader<LegacyRow, OpeningBalanceTarget> = {
  sourceTable: "ACCTOTALS",
  targetTable: "opening_balance",
  // C13: ONE document and ONE residue over the whole trial balance — per 500-row page it would be several documents,
  // each with a suspense line of its own invention.
  wholeTable: true,
  dependsOn: ["account"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "ACTACC", "ACCTOTALS"),

  async map(row, refs: RefResolver) {
    const legacyCode = requireText(row, "ACTACC", "ACCTOTALS");
    const entry = accountMap().entries.find((e) => e.legacyCode === legacyCode);
    if (!entry)
      return {
        skip: `legacy account ${legacyCode} has a stored total but is not in the account map`,
      };
    if (entry.treatment === "exclude")
      return {
        skip: `legacy account ${legacyCode} is mapped exclude; its ${String(row["ACTDEBIT"])}/${String(row["ACTCREDIT"])} total is reported, not loaded`,
      };
    if (entry.treatment !== "balance")
      return {
        skip: `legacy account ${legacyCode} is the ${entry.treatment}; its opening is supplied by the sub-ledger load, not by the trial-balance opening`,
      };
    const site = `ACCTOTALS/${legacyCode}`;
    // The amounts before the reference: a NULL total is refused at the row that has it (SAH-007), whether or not the
    // account was linked, rather than hidden behind a "never linked" skip on a rehearsal.
    const debit = moneyOf(row, "ACTDEBIT", baseCurrency(), site);
    const credit = moneyOf(row, "ACTCREDIT", baseCurrency(), site);
    const accountId = await refs.byLegacyRef("account", legacyCode);
    if (!accountId)
      return {
        skip: `legacy account ${legacyCode} was never linked to a Dulja account; the account loader did not load it`,
      };
    return { legacyCode, accountId, treatment: entry.treatment, debit, credit };
  },

  /**
   * Called EXACTLY ONCE with every mapped row of `AccTotals` (C13), in one transaction: half an opening balance is not a
   * smaller opening balance. A trial balance is hundreds of rows, not millions, and one balanced document is what a
   * reader checks against the legacy TB report.
   */
  async load(tx: Sql, ctx: LoadContext, rows: OpeningBalanceTarget[]) {
    // One-shot (9B review, finding 3): `runLoad` hands `load` only the keys no earlier run recorded, so on a re-run
    // against a source that GREW — or whose map now names an account it skipped — this would post an opening of
    // those rows alone, with a suspense line of its own. Any earlier recorded row of this loader refuses, whether its
    // opening is posted, reversed or netted to nothing; a correction after it is a JOURNAL.
    await refusePriorOpening(tx, ctx, {
      sourceTable: "ACCTOTALS",
      targetTable: "opening_balance",
      what: "the trial-balance opening",
      newKeys: rows.map((r) => r.legacyCode),
      correction:
        "Correct a balance after cut-over with a JOURNAL (the accountant's, dated after the cut-over date)",
    });
    // An opening is the company's first posting (9B review, finding 4): one posted by anything but the load refuses.
    await refuseForeignPostings(tx, ctx, "the trial-balance opening is");
    // The company's own currency, read once when the run opened (N3): the Money `map` minted and the Money zeroed here
    // are one type by construction.
    const base = baseCurrency();
    const lines: ImportedLine[] = [];
    let residue = Money.zero(base);
    for (const row of rows) {
      const net = row.debit.subtract(row.credit);
      if (net.isZero()) continue; // an account that nets flat opens nothing
      lines.push({
        lineNo: lines.length + 1,
        kind: "account",
        accountId: row.accountId,
        description: `Opening balance, legacy account ${row.legacyCode}`,
        debit: net.isPositive() ? net : Money.zero(base),
        credit: net.isPositive() ? Money.zero(base) : net.negate(),
      });
      residue = residue.add(net);
    }
    // Every mapped account netted to zero: there is no opening to post. `batchIds` is still one entry per row — each
    // was read, hashed and recorded, and produced no target row, which is exactly `EMPTY_TARGET`'s committed meaning.
    if (lines.length === 0)
      return { inserted: 0, skipped: rows.length, batchIds: rows.map(() => EMPTY_TARGET) };

    if (!residue.isZero()) {
      const [suspense] = await tx<{ id: string }[]>`
        select id::text as id from app.account
         where company_id = ${ctx.companyId} and code = ${SUSPENSE_CODE}
           and archived_at is null and not is_group`;
      if (!suspense)
        throw new LoadError(
          "ERR_IMPORT_UNBALANCED_SOURCE",
          `the opening is out by ${residue.abs().toString()} and account ${SUSPENSE_CODE} is archived or absent; apply 9b-cut-over.json (\`bun run seed --tenant <id> --only chart-of-accounts\`) and agree the treatment with the customer (§5.1 #2, OD-25)`,
        );
      lines.push({
        lineNo: lines.length + 1,
        kind: "account",
        accountId: suspense.id,
        description:
          "Opening-balance suspense — the residue of the legacy trial balance the balance accounts leave (§5.1 #2, SAH-003)",
        debit: residue.isNegative() ? residue.negate() : Money.zero(base),
        credit: residue.isNegative() ? Money.zero(base) : residue,
      });
    }

    const posted = await draftAndPost(tx, ctx, {
      documentTypeCode: "OPENING_BALANCE",
      legacyRef: null,
      lines,
    });
    // One document from many source rows: every row's batch entry points at it.
    return { inserted: rows.length, skipped: 0, batchIds: rows.map(() => posted.documentId) };
  },
};
