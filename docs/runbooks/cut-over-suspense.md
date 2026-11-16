# Runbook — the opening-balance suspense account (`3900`)

Read after `docs/runbooks/cut-over.md` step 5, with the customer's accountant. Plan 9B Task 11; the owner gate is
⚠️ **OD-25** (`docs/owner/od-25-suspense-and-cut-over-date.md`), and it is **not answered**.

## What is on it

`3900` (Opening-balance suspense, equity, seeded by `chart-of-accounts/9b-cut-over.json`) is the one account every
cut-over document balances against. After a clean load, ADR 0086 decomposes it exactly, and
`bun run legacy reconcile-cut-over` prints the decomposition as its `suspense` section:

> `3900` (debit-positive) = Σ the trial-balance differences − the legacy trial balance's own imbalance

with every part named:

- **the legacy trial balance's own imbalance** (SAH-003 — nothing prevented unbalanced vouchers): Σ `ACCTOTALS` debit −
  credit, matched exactly by 9A's `unbalanced_vouchers` and `aggregate_drift` totals (SAH-001), or the run exits 4;
- **the recost** on the inventory control: the legacy stored control less the valuation 3B's engine recomputed from the
  movement history (§5.1 #6) — `OPENING_STOCK` credits `3900` with the recomputed figure, never `MatCosts`;
- **the AR and AP controls' own drift** from their open items: each open item opens against `3900` (ADR 0085), so the
  control's stored balance beyond the sum of its items stands here, named;
- **every `exclude` account** of the owner's map, whose stored balance is reported and never loaded.

On the committed corpus: `3900` = −6080.0000 (a credit) = 2220.0000 (the recost on `1300`) − 8300.0000 (the imbalance,
matched by `unbalanced_vouchers`). The figure the customer is being asked about is that line, part by part.

## The three treatments, and what each costs

| Treatment | What is done | When it is right | What it costs |
|---|---|---|---|
| **Leave standing** | Nothing. `3900` carries the balance and appears on the balance sheet under equity. | The customer wants to investigate before deciding, or the figure is immaterial. **This is what the import does with no instruction.** | An equity line every reader of the balance sheet asks about until it is cleared; nothing else. |
| **Write off** | One `JOURNAL` after cut-over: Dr/Cr `3900` against one expense or income account the accountant names. | The figure is small, the cause is understood, and the customer accepts it as a prior-period adjustment. | One entry; the causes stay in the reconciliation artefact, not in the ledger. |
| **Reclassify** | One `JOURNAL` per identified cause, each moving that part of `3900` to the account it belongs on. | The 9A reports and the `suspense` section identified specific accounts, and the customer wants the opening balance sheet right rather than annotated. | One entry per cause, each needing the accountant's account and the part's figure from the `suspense` section. |

## How each is executed

**None of them is executed by the importer.** All three are ordinary `JOURNAL` documents posted after cut-over, by the
accountant, through the normal API, under `accounting.journal.post` — audited, reversible and visible, like every other
entry. The importer never clears its own suspense: a migration that tidies away its residue is a migration whose
difference was never explained. `packages/importer/test/load/opening-balance.test.ts` pins that default ("OD-25
default: the residue STANDS on 3900 and the import writes no clearing JOURNAL").

- [ ] Record the chosen treatment and the `3900` figure (the summary line's `3900 = …`) on the cut-over sign-off sheet.
- [ ] If the treatment is *write off* or *reclassify*, post the JOURNAL(s) **after** the sign-off, dated **the day
      after the cut-over date**, so the cut-over trial balance the customer initialled stays exactly what they saw.
- [ ] Re-run `bun run legacy reconcile-cut-over` with the same date, map and frozen source. It must still exit 0: the
      reconciliation reads the ledger at `effective_date <= cut-over date`, so a clearing entry dated the day after
      moves the balance forward without changing what the differences were.

## What changes if the owner decides otherwise

Nothing in the code. The account code, its type, its seeding slice and the loaders that credit it are §4.15's and
Task 4's, and none of them depends on the treatment. If the owner instead wants a **different account** for the
suspense, that is an amendment to contracts §4.15 — a new registered code with a seeding slice — and the loaders and
the reconciliation each change one literal, which is why the literal appears once, as `SUSPENSE_CODE`
(`packages/importer/src/load/opening-balance.ts`). A treatment that moves `3900`'s balance into another account **on
or before** the cut-over date must move ADR 0086's decomposition with it (`reconcileCutOver`'s `suspense` section),
or the reconciliation reports the moved part as unexplained.
