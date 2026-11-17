# 0086 — What "the difference on every recomputed figure is explained" means, operationally

- Status: **Proposed** — the plan wrote _Accepted_. This ADR decides when a customer's opening books count as
  reconciled to their legacy books: which differences may stand on `3900` and which stop a cut-over (spec:95's
  money-semantics class). Implemented in 9B Task 10 as the plan's default, sharpened where the tree required it, ahead
  of approval, under the owner's direction to implement Phase 9 entirely (2026-11-13;
  `docs/review/2026-11-13-phase-9-decisions.md`).
- Date: 2026-11-13 (the plan's text is dated 2026-09-08)
- Slice: 9B · Task 10
- Contracts: reads §4.13.1 (`reconcile`, `ReconciliationReport`), §4.13.2 (9B's loader surface), §4.15 (`3900`) and
  §4.17.1 (`reconcileFor`); round 20's N9 names `Comparison`, `CutOverReconciliation`, `reconcileCutOver`, `explain`
  and CLI exit 4. Supersedes: none.

## Context

Phase 9's definition of done (spec:2295) is: "Trial balance **and** stock valuation match the source on the cut-over
date, and the difference on every recomputed figure is explained (§5.1); each employee's imported YTD reconciles to
their last legacy payslip." Two of those three clauses are arithmetic. The middle one — "explained" — is the clause a
team can talk itself past, and §5.1 #1 says why it matters: "where the recomputed figure differs from the stored one,
report the difference to the customer rather than silently picking one."

After 9B's loaders run, every residue the cut-over could not place stands on `3900` (Tasks 5–7): the trial-balance
opening posts each `balance` account at its stored net and balances against `3900`; `OPENING_STOCK` credits `3900` with
the RECOMPUTED valuation (§5.1 #6), never the legacy inventory control; each open item posts against `3900`; an
`exclude` account is not loaded. On the committed corpus `3900` ends as a credit of 6080.0000: the legacy trial
balance is out by 8300.0000 (5000 + 1800 + 2400 − 900), the receivable and payable controls equal their open items,
and the inventory control (2400.0000) stands 2220.0000 from the recomputed valuation (180.0000).

The plan's reconciliation compared each `balance` account (always equal: the opening posts it), gave the controls a
fixed sentence, compared the stock valuation with itself (`source: v.value, dulja: v.value`) and printed every
employee's gross salary. None of it said what `3900` is made of.

## Decision

1. **A row is explained when its difference is zero, or when its rule names a cause and that cause's figure,
   computed from the source, equals the difference exactly.** There is no tolerance parameter, no rounding into
   agreement and no third state. `CutOverReconciliation.ok` is "no row unexplained"; the CLI's `reconcile-cut-over`
   exits **4** otherwise (0 success, 1 a load with skips, 2 configuration or refusal and 3 an unreadable source are
   taken), and the runbook stops.

2. **The trial balance is compared per Dulja account**, every figure debit-positive: the source is the sum of the
   stored `ACCTOTALS` nets of the legacy codes the owner's map puts on that account; Dulja is the ledger itself at the
   cut-over date (`effective_date <= cutOverDate`), read directly — an independent witness, on 7B's tie-out rule,
   because the tree's `trialBalance` reads one fiscal period's projection and the cut-over date is a date. Per
   treatment:
   - `balance` — explained only by a zero difference. The opening posts the stored net exactly, so a difference means
     it did not post, or something else did; no 9A report names either.
   - `exclude` — explained while Dulja holds nothing on it: the owner's exclusion is the cause, and the legacy net
     stands on `3900`.
   - `ar_control` / `ap_control` — explained when Dulja equals the legacy open items of that side (`BILLS`, read with
     Task 7's own rules). What separates the legacy control from its own items is named and quantified as the legacy
     control's drift (LEGACY-001's kind), standing on `3900`. An item the load did not open (an orphan, a refusal) leaves
     Dulja short of the items, and the row is not explained.
   - `inventory_control` — explained when Dulja (every inventory-control code together) equals the RECOMPUTED
     valuation: `BILLITEMS` parsed by the opening-stock loader's own `map` and replayed by `replayLegacyMovements` at the
     company's costing method, exactly as the load did. The legacy control's difference from it is the recost (§5.1
     #6), named and quantified.
   - A legacy account with a stored balance the map does not name, and a Dulja account the map does not name holding a
     balance at the cut-over date (`3900` aside), are never explained.

3. **The legacy trial balance's own imbalance is explained by 9A's reports, or not at all.** `explain(difference,
   reports)` searches the subsets (at most sixty-four) of the reports that carry a trial-balance figure and returns the
   matched reports' sentences when their **signed** effects sum to the difference exactly, else `null`. Two of the six
   kinds carry one: `unbalanced_vouchers` (its net imbalance, debit − credit; LEGACY-003) and `aggregate_drift` (`ACCTOTALS`' stored
   totals less their `VOUITEMS` recomputation: Σ of `ACCTOTALS.DEBIT`'s signed `stored − recomputed` less the same for
   `ACCTOTALS.CREDIT`, a missing stored row counting as a stored zero; LEGACY-001). `orphans`, `null_poison`,
   `duplicate_aggregates` and `employee_mapping` count rows, not money, and are never named. Signed rather than the
   plan's absolute values: a report that moves the trial balance by +100 does not explain −100, and two reports of
   +100 and −100 together explain only a zero.

4. **`3900` decomposes exactly.** Every legacy account is in exactly one trial-balance row and every Dulja account
   but `3900` in at most one, and the ledger balances, so `3900` (debit-positive) = Σ trial-balance differences − the
   legacy imbalance. The reconciliation carries it as `suspense`: the imbalance row (decision 3) and the `3900` row,
   which checks the identity against the ledger to the cent and lists the parts. `3900` is therefore explained exactly
   when the imbalance and every trial-balance difference are — every part of it is traceable to a named cause. On the
   corpus: −6080.0000 = 2220.0000 (the recost on `1300`) − 8300.0000 (the imbalance, matched by `unbalanced_vouchers`).

5. **The stock valuation's source is the recomputation, never `MatCosts`.** Per Dulja item and warehouse, the
   recomputed positions against `valuationAsOf`; only a zero difference is explained. A recomputed position whose
   item or warehouse did not import, and a Dulja valuation no legacy position accounts for, are rows of their own and
   are not explained _(narrowed by decision 9: a position the load read and reported is explained by the skip
   register)_. A pool the legacy history drives negative opens nothing and has no value on either side
   (acceptance test 18): it is listed with a zero difference and explained by the skip register, which names it.

6. **Each employee's YTD is the opening Dulja holds against the sum of their own `PAYITEMS`** for the cut-over date's
   calendar year (round 18 B7), gross AND net, to the cent — whatever wrote the opening (the load, or a person's
   `manual:` opening after a withheld one). A missing opening is not explained: an employee withheld by Task 8 is in
   the skip register under `YTD:<EMPID>` and in this report under the same key. **No pay figure is written**: the
   rows say how many payslips there were and which figure disagrees (`gross`, `net`, `gross and net`, `no opening`),
   never by how much (9B T8's rule).

7. **The reconciliation reads only** — the frozen source through 9A's reader and Dulja through the ledger,
   `valuationAsOf` and `listEmployeeYtdOpening` — as the tenant's system principal, with the account map the load ran
   with. The CLI writes `cut-over-reconciliation.json` and `.csv` into a run directory of its own,
   `artefacts/legacy/<runId>/`, with their sha256 in that directory's `index.json`.

## Consequences

- The sign-off artefact is `cut-over-reconciliation.json` plus its sha256 in `index.json`. The customer initials the
  printed summary; the hash makes the printed copy and the file provably the same.
- A cut-over cannot be declared done while any row is unexplained, by anybody, including by agreement. Agreement is
  what OD-25 records about the _treatment_ of `3900`; it is not a way past the arithmetic.
- The source must be the frozen one the load read. Reconciling against a source that moved shows the movement as
  unexplained rows — which is what it is.
- The reconciliation refuses, rather than reading as zero, a source without the `BILLS` or `BILLITEMS` the map's
  controls need, an account map that puts a legacy account on `3900` (whose balance could then not be decomposed), and
  a duplicated source key with different values (the load's LEGACY-049 rule).
- 9A's reports read `ACCTOTALS` and `VOUITEMS` in their own (unprefixed) spelling while 9B's loaders read the
  dossier-prefixed one (9B T4's recorded split); the committed `cut-over` corpus therefore carries `VOUITEMS` in 9A's
  spelling. OD-17's live catalogue corrects whichever spelling is wrong, in one place each. _(Amended by decision 8:
  the reports now read `ACCTOTALS` in either spelling.)_

## Owner questions

1. Should a control's own legacy drift from its open items (decision 2) count as explained, or must the legacy
   control equal its items before cut-over?
2. Should a pool the legacy history drives negative (decision 5) block sign-off rather than stand in the skip register?
3. May the owner accept a legacy imbalance no 9A report accounts for (decision 3) — for example one caused by a
   routing the reports cannot read — or must it always be matched?
4. Should a recost difference (decision 2) above some size need its own written acceptance beside the sign-off?

## Amendment — 9B review, findings 3 and 8 (2026-11-14), Proposed

The independent review of Phase 9. Implementation authorization under the owner's direction of 2026-11-13, not
acceptance (`docs/review/2026-11-13-phase-9-decisions.md`; contracts round 20 C23–C24).

8. **`aggregate_drift` reads `ACCTOTALS` in the spelling the source has** (finding 8). Decision 3's drift figure was
   `source_absent` against every source the trial-balance load accepts: the rules read `ACCTOTALS(ACCOUNT, DEBIT,
   CREDIT)` and the load reads `ACCTOTALS(ACTACC, ACTDEBIT, ACTCREDIT)`, so `explain()` could never name the part of
   `3900` that is the stored totals' own drift. Each rule may now list further complete spellings of its stored side
   (`AggregateRule.storedSpellings`), and the report reads the first the source has — never one column of each, so a
   key of one spelling is never joined to a figure of another; a row read under a further spelling says so in its
   `derivation`. The same applies where a 9A rule and a 9B loader read the same column under the two names:
   `null_poison` (`ACTDEBIT`, `ACTCREDIT`, `BTMQNT`), `duplicate_aggregates` (`ACTACC`) and `orphans`
   (`BILLITEMS.BTMMAT` → `MATERIALS.MATID`, `BTMWAR` → `WAREHOUSES.WARID`). Only names a 9A or 9B plan writes are used.
   **Not respelt**, each because the 9B column is not the same figure or names a different table: `MATOBJECTS`/
   `MATQUANTITY` drift (9B's `BTMQNT` is a magnitude beside the `BTMIN` direction flag, not the signed quantity the
   rule sums), `MATTOTALS` (9B names no `BILLITEMS` debit or credit), `BILLITEMS.BATCH` → `BATCHES` (9B's batches are
   `MATBATCHES`), `VOUITEMS.ACCOUNT` → `ACCOUNTS.ID` (9B makes an account reference a chart code, R29, while the rule
   joins to the id — a key-domain question, not a spelling) and `employee_mapping` (9B names no `SITE`, `ACCOUNT` or
   `ISEMPLOYEE`). The committed `cut-over` corpus's `VOUITEMS.ACCOUNT` now carries the chart code `ACTACC` carries,
   since the drift rule keys both tables on one value; which domain the live `VouItems.Account` holds is OD-17's.
   On a source whose stored total of `1101` drifts 50 above its lines, the imbalance (8350.0000) is now explained by
   `aggregate_drift` (50.0000) and `unbalanced_vouchers` (8300.0000) together, and `3900` still decomposes to the cent.
9. **A stock position the load read and reported is explained by the skip register** (finding 3) — decision 5's "a
   recomputed position whose item or warehouse did not import … is not explained" is narrowed. Opening stock is
   one-shot (ADR 0084 decisions 26–27), so a position it reported (a service, a parent that did not import, another
   item's batch, a batch-less receipt of a batch-tracked item) is never opened by a re-run; it is corrected after
   cut-over by a STOCK_COUNT. The reconciliation now tells such a position from one the load never read: a position
   is **read** when every one of its `BILLITEMS` rows is recorded under `opening_stock`, and **opened** when one of
   the load's own `OPENING_STOCK` documents carries a line for its item, warehouse and lot. A stock row whose
   difference is EXACTLY the value of the read-and-not-opened positions under it is explained, naming them by their
   skip-register keys; the inventory-control row is explained when the recomputation less Dulja's control is exactly
   the sum of those rows, and says so. A position the source gained after the load (its rows unrecorded) is still not
   explained — reconciling against a source that moved shows the movement. No tolerance: a position partly opened
   by a later count is unexplained until the count matches.


## Amendment — 2026-11-15 full review, HRP-04 (2026-11-16), Proposed

10. **A position read before its parent was loaded is not explained** (HRP-04) — decision 9 is narrowed. A position
    the opening-stock load read and reported because its item, warehouse or lot "did not import" is explained by the
    skip register only when that is a property of the frozen source. When the parent's `import_batch` row was
    recorded AFTER the position's `BILLITEMS` rows — the opening ran ahead of its parents (an `only` run decision 28
    now refuses, a parent loaded in part, or a source corrected after the opening) — the skip is a load-order
    mistake: the row's difference is not explained, its label names the positions and says why, and the
    inventory-control row is not explained by it either. Before this, `reconcileCutOver` answered `ok: true` for a
    company whose whole opening stock was empty, every position "explained". The correction is the same as for any
    unexplained stock row: a STOCK_COUNT after cut-over, or — before cut-over — a fresh company loaded in order.
