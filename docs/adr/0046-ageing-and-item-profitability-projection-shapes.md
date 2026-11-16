# ADR 0046 — Ageing and item-profitability projection shapes

- **Status:** Proposed (spec:95 — this touches money semantics, so it is asked before it is implemented).
  **Implemented ahead of approval**, as ADR 0020 was, as 3B's 0037–0039 were and as this slice's 0048 is:
  4B Task 3 ships the `party_ageing` half on this branch and Task 4 the `item_profitability` half. If the
  owner rejects a decision below, the functions in migration 0048 and the two rebuilds are what change.
- **Date:** 2026-09-28
- **Slice:** 4B (Task 1 — migration 0048's two SQL functions; Task 3 — `party_ageing`; Task 4 —
  `item_profitability`)

## Context

spec:1204 names three asynchronous projections — `party_ageing`, `item_profitability` and
`stock_valuation` history — and requires all of them to be "rebuilt from
`ledger_entry`/`inventory_movement` into scratch tables nightly and compared row for row; a mismatch
is an incident". §4.8.2 additionally requires the ageing to tie to the `1200`/`2100` control accounts
"to the cent", and that clause is half of the Phase 4 definition of done (spec:2290).

Three questions had no registered answer.

1. **Where does the arithmetic live?** A report, a projection rebuild and an integrity comparison that
   each carry their own copy of "what is open" will disagree, and the disagreement will look like a
   mismatch incident rather than like a bug.
2. **Does the tie-out hold per currency?** §4.8.2 says "Σ buckets per party to the AR/AP control-account
   balance" without saying in which currency.
3. **Do these two projections join 1B's `projectionChecks` registry?** 3B's ADR 0039 excluded
   `stock_valuation` from it and put its compare inside its own job.

## Decision

**One arithmetic, in SQL.** `app.party_ageing_rows(company, as_of)` and
`app.item_profitability_rows(company, sale_types[])` (migration 0048) are the only definitions. The
rebuild `MERGE`s from them, the two reports select from them, and the compare full-outer-joins the
stored table against them. Both are plain `stable` SQL and never `SECURITY DEFINER`, so RLS applies as
the caller. This is the shape `app.rate_for` and `app.series_gaps` already established.

What `app.party_ageing_rows` counts as open, as 4B Task 1 wrote it against 4A's landed tables:

- a posted party document's ledger rows on the party's control account (vendor-side sign-flipped, so an
  open bill is positive), `amount` in the document's own currency only and `base_amount` over all of them;
- due on `document.effective_date + payment_term.due_days` for the term **pinned on the document**
  (round 7's 4.8.2 row) — never the party's current term, which would re-age history (SAH-013);
- relieved by a live allocation only once **both** of its documents are dated on or before `as_of`, the
  settled side by `allocation.base_amount` and the settlement side by `base_amount + fx_difference` (the
  settlement's own base), each relief shrinking the document's `|open|` on whichever side of the control
  account it sits;
- a full reversal and the document it reversed are not open items once the reversal is effective — pairs
  taken along a reversal chain by depth parity, so every excluded pair nets to zero in the ledger — while
  a partial credit note is an open item, negative, until it is allocated.

**The tie-out is base-only, and the per-currency equality is not claimed.** In a cross-currency
settlement it is false: a EUR invoice part-paid by a USD receipt leaves the control account with a EUR
debit row and a USD credit row in `account_balance`, while the ageing shows the invoice's residual EUR
and nothing in USD — because `allocation.amount` is denominated in the **settled** document's currency
and no column denominates it in the settlement's. The registered equality is therefore

    Σ party_ageing.base_amount  ==  ledger base of the control account − outstanding unrealised revaluation

with the ledger's sign brought into the ageing's orientation by the account's type (an asset control is
debit-positive, a liability control credit-positive — the same flip the function applies to a vendor), and
it holds **only once the realised FX difference has posted** (ADR 0047): the residue between "settlement
base" and "settled base" is income, not a receivable, and until it is posted to the control account the
ledger carries it and the ageing does not. That is why the ageing counts a settlement's consumption as
`base_amount + fx_difference`, and why, until 4B Task 5 posts it, the equality reads
`ageing == ledger + Σ fx_difference` (4B Task 1's test asserts exactly that form). A same-currency month
satisfies the per-currency equality too, and 4B Task 3's test asserts that case separately.

`account_balance`'s per-currency rows on a party control account are consequently **not an open-item
view**, and no report reads them as one. The open-item view is `party_ageing`. `ageingTieOut`
(`packages/db/src/ar-ap/ageing.ts`) is the one function that computes the difference, one row per control
account any party of the company points at; the definition of done is `difference = 0.0000` on `1200` and
`2100`.

**`item_profitability` joins `projectionChecks`; `party_ageing` does not.** `item_profitability` is
current state keyed on `(company, item, fiscal_period)` — exactly the shape `account_balance` and
`stock_on_hand` have, and 1B's nightly `accounting.ledger.integrity_check` is where current-state
projections are compared. `party_ageing` is an as-of snapshot keyed by date, so a comparison is only
meaningful for a date somebody asked for; its rebuild-and-compare belongs to
`accounting.projection.rebuild`, which is the identical call 3B's ADR 0039 made for `stock_valuation`.

**Neither rebuild deletes.** §3.5.4's `app_rw` DELETE list is pinned to five tables and 2B is its only
extender, so both rebuilds `MERGE` and then zero the stale keys of their own scope. A zeroed row and an
absent row are the same thing to every reader, and the compare treats a missing side as zero.

## Consequences

- A change to the ageing definition is a migration, reviewed as SQL, not a diff in three TypeScript files.
- `IntegrityReport.projections.checked` becomes `["account_balance", "cost_layer", "document_series",
  "item_profitability", "stock_on_hand"]`; the pinned assertions that read it moved in the same PR
  (4B Task 4) — **done**, at six sites rather than the plan's three: `tests/invariants/projection-rebuild`,
  `tests/invariants/audit-chain`, `apps/worker/test/handlers/integrity-check`, and also
  `packages/db/test/costing/layers.test.ts` (twice) and `packages/db/test/inventory/stock-on-hand.test.ts`.
- **Open, for the owner: `item_profitability` is compared by a job that does not rebuild it** — narrowed,
  not closed, by the round-8 remediation (contracts §4.2.6, ADR 0007's amendment). It is an asynchronous
  projection, so between a post and the next rebuild the stored rows lag the fresh function, and 1B's
  `accounting.ledger.integrity_check` (02:00) reports that lag as a mismatch. Step 14's enqueue
  (`singletonKey = companyId`, `startAfterSeconds = 60`) is what keeps the lag short, and it now keeps it to
  one job: `accounting.projection.rebuild`'s queue is `stately`, so a post while the company's rebuild is
  queued rides on it (locked until the post commits) and a post while it runs queues the next one. The
  daily case this item was filed for is gone — 0D's client used to pair every `singletonKey` with
  `singletonSeconds = 86400`, whose slot a completed job kept holding, so a company got one intraday
  rebuild per UTC day and every later sale post waited for the 03:00 run, *after* the 02:00 compare. **What
  remains:** a post in the minute (plus queue latency) before 02:00, or any post while the worker is down or
  backlogged, is still unrebuilt when the compare runs, and raises an item_profitability incident for rows
  the next rebuild will make agree. The fixes for that remainder are still not this ADR's to choose: the compare
  moved after the rebuild, or restricted to keys whose documents all predate the last rebuild.
- The DoD test cannot be written across currencies without the FX work, so Task 3's tie-out case is
  same-currency and Task 5 re-asserts it across a cross-currency month. That ordering is deliberate.
- An ageing snapshot exists only for the dates the job ran, so the **report always computes fresh** through
  `agedBalance` and never tells a user "no snapshot for that date"; the stored table exists for the
  comparison and for 7C's re-expression, not to answer the query.
- The job rebuilds and then compares inside one transaction per company, so the compare is a check of the
  rebuild's own write (a key the `MERGE` missed, a stale key the zeroing missed) rather than of history: a
  back-dated post legitimately changes a past as-of figure, and comparing a stored snapshot from an earlier
  night against a fresh one would raise that as an incident.

## Amendment — the code review (2026-09-29)

- Each rebuild is one statement: a `materialized` CTE of the fresh rows feeds the MERGE and the zeroing
  UPDATE (disjoint keys; still no DELETE), so the set-returning function is evaluated once, and the
  `accounting.projection.rebuild` job's compare reuses the rows the rebuild returned rather than evaluating
  `party_ageing_rows` a third time. `app.document_netted_from_rows(company)` computes every document's netting
  date in one recursive walk instead of one recursive query per document.
- The incident's `projections.checked` names the projections the run actually checked.
- `item_profitability` and `inventory.sales_by_item` read item revenue from one function,
  `app.item_revenue_rows`, directed by the pinned policy's `item.revenue_account` rules — no type list.
- Step 14 enqueues the rebuild with no `asOf`, so every collapsed request rebuilds as of the run date.

## Amendment — the full review (2026-11-15): a cost-leg document's exposure (MON-01)

Still a proposal; the owner approves or rejects it with the rest of this ADR. Migration 0129, branch
`claude/fix-fx-cost-leg-returns`.

- **The defect.** Rule 1 summed a document's own-currency figure only over its control rows in its own currency.
  A foreign-currency PURCHASE_RETURN relieves 2100 through a base-currency cost leg (`line.cost`, §4.7.3
  amendment A4), so it aged as `EUR 0.0000` with base −cost. ADR 0047's revaluation then restated that base to
  zero at an unchanged rate — an unrealised loss of the whole return, every period — and, once the return was
  allocated, the vendor's EUR ageing showed the invoice unreduced (1,000 where 880 was owed).
- **The rule.** `app.document_control_exposure(document)` (0129) is the one derivation of a document's
  exposure on its party's control account, read by `app.party_ageing_rows`, `allocateSettlement`/`openBalance`
  (`docFacts`) and `partyBalance`. A document whose control rows are all in its own currency is unchanged. A
  document with a control row in another currency (a base cost leg) is exposed **in its own currency at its keyed
  total** (Σ `total_incl_tax`, on the side the ledger moved), carried at its own rate,
  `round(amount × rate, 4)`; what the cost leg put on the control account beyond that — the price-versus-cost
  difference — is a second, **base-currency** open row. The base tie-out to 1200/2100 is unchanged and exact
  (acceptance test 8, `packages/db/test/ar-ap/ageing.test.ts`); the residue is never revalued (base rows are
  not) and never relieved by an allocation (rule 3 now relieves only a document's own-currency row).
- **Owner question 1 (MON-01).** The residue is real — the ledger holds it on 2100 — but it is purchase-price
  variance, not a payable. Clearing it needs PURCHASE_RETURN's policy to relieve the payable at the keyed price
  and post the difference from cost to a variance account (or to inventory), as SALES_CREDIT_NOTE already
  separates revenue from cost. A base-currency return has the mirror gap: its capacity is the cost (code review
  A3), not the keyed price. Which account takes the difference is the owner's decision; until then the residue
  stands as a base-currency open row on the vendor.
- Tests: `packages/db/test/ar-ap/fx-cost-leg-return.test.ts`, each failing on `6a8d239`.
