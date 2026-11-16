# ADR 0038 — A recost is bounded, restartable and visible

**Status:** PROPOSED — the six decisions below settle what a cost correction does to posted money (an issue's
movement value, a line's `cost`, and a ledger entry in a period the operator may have closed), so spec:95
makes this a money-semantics decision written as a proposal and asked before implementing. It is implemented
ahead of approval, as ADR 0020 was, as Phase 2's 0026, 0027 and 0029-0031 were, and as this slice's ADR 0037
is, and this line says so. **Note 7 below carries a second, separate proposal** — netting an authorised
shortfall into the next receipt's layer — which is **not** implemented and is the architect's to accept or
reject before 3C extends a receipt's value.
**Date:** 2026-09-20
**Deciders:** architect (the six decisions), owner (note 7's proposal, with OD-06)
**Slice:** 3B
**Supersedes:** nothing. **Related:** ADR 0037 (AVCO and the layer model), ADR 0034 (the sentinel lot),
contracts §4.7.2, §4.7.3, §4.14's `COST_ADJUSTMENT` row, amendments A12 and A16, Part I SAH-004, SAH-005,
SAH-009, SAH-010, SAH-054
**Spec:** §3.4 (spec:1220-1224, 1227), §3.8 transactions (spec:1368), Part VI test 5 (spec:2423), Part I
SAH-004, 005, 010, 054

## Context

The old system's recost was one all-or-nothing transaction over every material, entered from two code
paths that ordered their work differently — one by document id, one by date (SAH-005) — and aborted on
the first historical below-cost sale, rolling back every material already processed (SAH-054). Its
incremental mode visited only materials whose dirty flag was set, and the flag was set from three of the
four code paths that could dirty one, so `vForce=0` was a silent-wrong-answer mode.

## Decision

Six things, and each one is a direct answer to one of those failures.

1. **An issue's `inventory_movement.value` is never rewritten.** The movement table is immutable
   (`forbid_change`); the recost rewrites `cost_consumption` and books the difference as a
   `COST_ADJUSTMENT`. spec:1224's "never silently rewriting posted history", read literally.
2. **`document_line.cost` IS rewritten.** It is the current answer, read by reversals, by 3D's
   `line.variance_value` and by every margin report; two answers to one question is SAH-009.
3. **A layer is UPDATEd, never re-inserted** — `unique (movement_id)` makes that structural.
4. **The restore pass is a formula** (`qty_remaining = qty_in − Σ valid consumptions`), so a crash-restart
   re-runs it harmlessly and the resume point is derived from committed state, never from a flag.
5. **"Before" is the latest invalidated generation per movement**, selected by `max(invalidated_at)`, so a
   movement recosted twice is not double-counted.
6. **A closed affected period carries the adjustment forward** to the earliest open period on or after it,
   with `document.notes` naming the source period. With no open period, the job records an integrity
   incident and returns rather than retrying until pg-boss dead-letters it.
7. **An authorised shortfall is valued but not consumed, and the layers therefore lag the movements until
   the next receipt. That lag is recognised, not netted, in v1.** When `inventory.negative_stock.override`
   authorises an issue the open layers cannot cover (F-6, test 18), the uncovered quantity is _valued_ at
   the running average and produces **no** `cost_consumption` row — `cost_consumption.layer_id` is NOT NULL
   and there is no layer to point at. So for that `(item, warehouse)`, `Σ layer qty_remaining` exceeds
   `Σ movement.quantity` by the open shortfall — until a **back-dated** receipt makes the replay recompute
   that issue against replenished layers; a later receipt does not close it, because nothing re-consumes a
   historical shortfall — and `document_line.cost` exceeds `Σ cost_consumption.value` by the shortfall's
   value. **Consequences, both stated rather than papered over:** Task 11's nightly quantity compare
   **excludes `(item, warehouse)` pairs with an open shortfall**, naming them in the log rather than raising
   an incident; and `sah-009`'s tie-out asserts
   `Σ document_line.cost = Σ cost_consumption.value + shortfall value`, which is the true identity.
   **The exclusion is bounded by a test, not by this paragraph:** `packages/db/test/costing/valuation.test.ts`
   opens a shortfall through `postOverriddenIssue`, asserts the pair appears in `excluded` and **not** in
   `mismatches`, and asserts it moves back into the compared set — with `excluded` empty — as soon as a
   receipt replenishes it. A carve-out that no test pins is a carve-out that quietly widens. That file is
   **Task 11's**, and it does not exist yet: until it does, the carve-out is pinned by this paragraph alone,
   which is exactly the state this sentence warns about.

   **PROPOSAL, for the architect to accept or reject before 3C extends a receipt's value (spec:95 — this
   touches money semantics).** Net the shortfall into the next receipt's layer: `qty_remaining = qty_in −
   open shortfall` on that layer, with `(new unit cost − the shortfall's provisional cost) × shortfall`
   booked into the same `COST_ADJUSTMENT` the replay already posts. It makes both nightly compares
   unconditional and removes the exclusion above, and it is almost certainly the right long-term rule.
   It is **not** taken in this slice because it adds a member to a frozen interface — `CostingOutput`
   (§4.7.1) would gain `shortfall: { quantity: Quantity; value: Money } | null`, which `applyMovements`
   would persist and `replay` would consume — and hazard 7 makes a needed deviation a proposal rather than a
   plan task. Recorded here rather than as its own ADR because §3.9 allocates 3B exactly 0037-0039 and all
   three are used; hazard 14 forbids taking a number outside the range. It is also this plan's **second spec
   question**, so the orchestrator surfaces it rather than a reader having to find it in an ADR's note 7.

Batches are `MOVEMENTS_PER_BATCH = 500` per `withTenant` transaction (spec:1368), and the replay never
disables `assert_stock_available` or `forbid_change` — it writes no movement, so neither ever fires.

## Consequences

- Runtime is proportional to the movements at or after the invalidation point, not to total history —
  the clause acceptance test 5 asserts, and it is asserted on **rows** (months 1-2 keep their ids and
  `created_at`), never on a wall clock.
- A recost is visible in the ledger as a document a reader can open, reverse and explain.
- Two adjustments for one back-dated document are possible when its items span branches or periods; that
  is deliberate — `sum(base_debit) = sum(base_credit)` holds per document and BRANCH stays meaningful.
- A company whose chart lacks `1300` or `5000` fails at the top of the job with the seed command in the
  message (Task 8), not at an insert halfway through a batch.
- **Rejected:** a per-item watermark column. It is the shape SAH-005's `CstChanged` had, and the whole
  lesson of that defect is that invalidation must be structural — a row's own `invalidated_at` — rather
  than a scalar somebody has to remember to move.
- **Nothing above has been observed to hold.** `packages/db/test/costing/replay.test.ts` and
  `apps/worker/test/handlers/cost-replay.test.ts` are written against the real exports and typecheck, but
  both need a PostgreSQL Testcontainer and the machine this slice was built on has no Docker daemon
  (`AGENTS.md`, "Current phase"). Acceptance test 5 is therefore **written, unrun**, and every figure in
  those suites — 21 movements, ten adjustments, the 1000.0000 March leg, the 166.6700 April delta, the six
  incidents — is arithmetic derived from the fixture, not an observation.

## Amendment — the code review (2026-09-29)

Decision 5's "before" and "after" are no longer the bare Σ of a generation's consumption values. An
authorised shortfall is valued at the running average and writes no `cost_consumption` row (note 7), so a
generation that covered less than its movement is valued as Σ its consumptions **plus** the uncovered
quantity at the average of the layers it consumed (AVCO: the rows' `unit_cost`; FIFO: Σ value ÷ Σ quantity),
rounded half away from zero to 4 dp — the engine's own rule. Taking the rows alone over-stated the adjustment
by the shortfall's value and left `1300` that far from the layers. A fully covered generation values exactly
as before, so no golden figure moved. Tests: `packages/db/test/costing/code-review-c.test.ts`.

Two gaps the review found and did not fix: a replay that dies after some step-3 batches committed does not
post those movements' deltas on the rerun (the rerun's scope starts past them), so the restartability decision
1 claims does not hold across a crash between steps 3 and 4; and a movement a previous replay left wholly
uncovered has no consumption rows, so its generation is invisible and "before" falls back to an older one.

## Second amendment — the code review's second pass (2026-09-29)

A proposal, like the ADR and its first amendment. It closes both gaps the first amendment recorded and a
concurrency defect the pass found, and changes no figure decisions 1–6 define.

- **Decision 4, restated: the restart state is `app.cost_booking`** (migration 0115) — one row per issue
  movement holding `booked_value` (what the ledger carries for its cost: `abs(movement.value)` until a replay
  books a difference, then that replay's "after") and `pending` (`recost`, `booking` or null). The rows are
  written by the same statements, in the same transactions, that invalidate or recompute the movement's
  consumptions, so they are per-movement committed state and not the per-item watermark this ADR rejects.
  `invalidateFrom` marks every issue at or after its key `recost` (the posting document's own included); each
  step-3 batch moves what it recomputes to `booking`; step 4 books each (period, branch) group in its own
  transaction and clears the rows. A run that recomputed and could not book — no open period, or a crash
  between steps 3 and 4 — is booked by the next run, and a crash between batches resumes on the full
  four-column key.
- **Decision 5, restated: "before" is `booked_value`**, not the latest invalidated generation. A generation with
  no consumption row is remembered at the figure it was booked at, so a later replay no longer books the same
  reversal again (the previous rule re-posted it on every replay).
- **Decision 6, amended:** with no open period the group's rows stay `booking` and the first run after a reopen
  posts exactly that adjustment; each run meanwhile records a further incident.
- **Concurrency.** A document posted after step 2 was costed twice (a second valid consumption set beside the
  post-time one) and a receipt posted in that window entered the open set twice. Each step-3 batch now re-reads
  under its stock locks, re-invalidates from its own cursor for the (item, warehouse) pairs it holds, restores
  every layer an invalidated consumption at or after the cursor had reduced, and keeps layers at or after the
  cursor out of its open set instead of invalidating them, so stock received while a replay runs stays
  available to posters. Every replay transaction takes the tenant audit serialisation (0010's `tenant-serial:`
  key) before any cost row, as a back-dated poster does, so the two cannot deadlock. **Step 2 holds that lock
  for its whole window**: step 2 is one transaction over the affected items' tail, so while it runs every
  audited write of the tenant waits — the price of the one lock order, and a reason to keep tails short.
- **Owner question, behaviour unchanged.** An ordinary issue of an item whose back-dated tail awaits the replay
  is costed only against the layers dated before the back-dated key: it is refused `ERR_STOCK_INSUFFICIENT`
  with stock on hand when those cannot cover it (indefinitely if the replay fails), and under an override it
  posts at their average, possibly 0.0000, which the replay then corrects. What an issue posted during a
  pending recost should cost in the interim is not settled by the spec.
- **Residuals.** Any `app_rw` session can still rewrite `document_line.cost` on a posted line, because the
  replay runs as `app_rw`, and `reverseDocument` values a mirror at that cost; closing it needs a SECURITY
  DEFINER cost writer, an ADR of its own. Rows invalidated before 0115 (test databases only) have no booking
  row and start at `abs(movement.value)`. Each step-3 batch's re-invalidation is O(tail) for its pairs.

## Accepted amendment — reverse an untouched purchase at its original cost (2026-10-01)

**Status: ACCEPTED by the owner on 2026-10-01 (“fix them please”), following the concrete proposal.** Approval covers this rule together with ADR 0039's
exact-value amendment; it does not ratify the other unresolved decisions in this ADR.

SAH-004 was rerun on `66ec03c` against PostgreSQL 18 and still fails: buy 100 units at `10.0000`, buy
another 100 at `20.0000`, and reverse the second purchase. The remaining 100 units are valued at
`15.0000` each instead of `10.0000`. The cause is concrete: `applyMovements` sends the reversal's outgoing
leg through ordinary AVCO costing, which consumes a proportional share of both receipt layers at the
average. The reversal is therefore priced as a new issue rather than undoing its identified purchase.

### Decision

1. A full reversal of a purchase receipt, identified by its existing `reverses_document_id` relationship,
   cancels that receipt's own layer at its exact original quantity and base-currency value. It does not
   consume other purchases' layers at the current average. Both AVCO and FIFO use this rule for an
   identified purchase reversal. An ordinary supplier return retains its existing costing policy.
2. The immediate scope is a receipt whose source layer is still wholly unconsumed, live, and at the
   original booked value. Check the source document, line and movement identity, company/tenant,
   warehouse, lot, quantity, and exact value under the posting transaction's existing stock locks.
   Client-supplied cost or source-layer identifiers are not authoritative.
3. If a source layer has been consumed, is awaiting replay, or no longer matches the original booked
   value, refuse the full purchase reversal atomically with a state-conflict error. Stock in another
   layer and a negative-stock override do not make a consumed purchase safe to cancel. The operator can
   use the existing return/correction path; this amendment does not silently reprice intervening sales
   or choose an automatic cancellation-recost rule for them.
4. Append the inverse movement and ordinary reversing ledger entries through the posting service.
   Retain the source movement and layer; the reversal records its consumption and the layer's remaining
   quantity becomes zero. Never delete the original or filter it globally out of historical valuation.
   Before the reversal's effective date, an as-of read still includes the original receipt; on and after
   that date, its cancelled layer contributes zero.
5. Ordinary issue reversals, transfers, stock counts, financial-only reversals, existing partial-return
   guards, and the reversal-chain parity rule retain their existing behavior. A reversal of the purchase
   reversal recreates a receipt at the exact cancelled value; cancelling it again uses the same identity
   and eligibility checks. A later recost must preserve this source-specific consumption, not rerun it
   as an ordinary AVCO issue.

After the example's reversal, quantity is `100.000000`, inventory value is `1000.0000`, and displayed unit
cost is `10.0000`. The new refusal for an already-consumed purchase is a deliberate behavior change and
is part of the approval requested, not an incidental implementation choice.

### Implementation and verification after approval

- Amend the frozen receipt/issue rules and any required domain input contract before implementation.
  Resolve source identity internally from existing relationships; add no new public request field.
- Keep SAH-004's expected quantity and unit cost unchanged. Add assertions that inventory movements,
  layers, consumption values, and the inventory ledger agree, rather than checking the displayed cost
  alone.
- Test as-of reads before and after the reversal; AVCO and FIFO; reversal-of-reversal chains; subsequent
  posting and back-dated replay; refusal of consumed or invalidated layers; concurrent issue/reversal;
  rollback of every write on refusal; tenant isolation; and unrelated reversal paths.
- Review the existing stock reversal suites for behavior affected by the new consumed-purchase refusal.
  Do not silently change expected figures or widen the rule to bypass those cases.

A new back-dated issue crossing an already posted purchase cancellation is refused atomically with `ERR_DOC_STATUS_ILLEGAL` when the cancelled receipt already existed at that issue’s key. Replaying such an issue would consume the source before its cancellation and violate the approved untouched-source precondition. The operator must use the ordinary correction/return path.

The cancellation date must be on or after its source receipt date; the receipt must precede it in the chronological movement order. The existing reversal-date validation refuses a cancellation before its own receipt with `ERR_VALIDATION_FAILED`; the pure engine additionally refuses a future source with `ERR_DOC_STATUS_ILLEGAL`, because the replay cannot consume a future layer.

## Proposed amendment — a reversal's receipt follows its issue through a replay (2026-11-15, INV-02)

**Status: PROPOSED.** A money-semantics change from the 2026-11-15 full review (finding INV-02,
`docs/review/2026-11-15-full-review.md`), implemented ahead of approval as this ADR's other proposals are.
It does not touch the accepted purchase-cancellation amendment above, nor the known defect that every
`COST_ADJUSTMENT` posts between `5000` and `1300`.

### Context

The reversal of a stock issue emits a receipt priced from the issue's cost: `reverseDocument` copies
`document_line.cost` and §4.7.2 branch 1 opens the returned goods' layer at it. The replay's receipt branch
restored every layer from its movement's immutable value, that mirror's included, while it recomputed the
original issue and booked the issue's difference. So a back-dated receipt that moved the issue's cost left
the returned goods at the stale cost and the difference in COGS for a sale that was fully reversed. Under
AVCO — receive 1 @ 10 on 01-10, sell it on 01-15, reverse the sale on 01-16, then a receipt of 1 @ 20
back-dated to 01-05 and a replay — the two units were valued 25.00 instead of 30.00 and `5000` carried 5.00
(FIFO: 20.00 and 10.00). The layers and the ledger still agreed with each other, so no tie-out caught it.

### Decision

1. In the forward pass, a receipt that a reversal of an issue emitted — its document's `reverses_document_id`
   names a document with an issue movement on the same line, item, warehouse and lot, its own line carries a
   copied `cost`, it has no issue leg of its own and no count columns: exactly the receipts branch 1 prices —
   is priced from that issue's **current** cost: the value this batch just computed when the issue is in it,
   otherwise the issue's `document_line.cost` (note 2's current answer). A reversal can never be dated before
   its original (`reverseDocument`), so the issue always sorts first. Equal quantities take the issue's value
   whole; an unequal pair, which `reverseDocument`'s full mirror never produces, is priced at the issue's
   unit cost, as amendment A7 prices a transfer leg.
2. The mirror's `document_line.cost` is rewritten to the same figure, as an issue's is.
3. The layer's change is booked by step 4 beside the issues': the receipt gets an `app.cost_booking` row
   (`booked_value` = what the ledger carries for it, first its immutable movement value), marked `'booking'`
   in the batch that re-prices it, valued at its layer's value, and its difference enters the
   (period, branch) group's sum **negated** — a dearer returned unit is a smaller COGS. When the issue and its
   reversal fall in one period and branch, the two differences cancel and no `COST_ADJUSTMENT` posts; across
   periods each period gets its own half.
4. Transfers, transfer receipts and their reversals (branch 2), stock-count surpluses (branch 2b) and purchase
   receipts are unchanged. A purchase cancellation's reinstatement is such a mirror too; its issue is valued
   at the cancelled receipt's exact value by the accepted amendment, so its figure does not move.

### Consequences

- After a replay the issue and its reversal carry one cost, the returned goods are valued at it, and the
  pair's net COGS is zero (`packages/db/test/costing/value-and-cancellation.test.ts`, the INV-02 cases, AVCO
  and FIFO, a multi-unit pair, and a reversal of the reversal recosted again).
- Reversals are whole-document, so there is no partial issue reversal to price; a partial credit note moves
  no stock. If a partial stock return ever gets a path, it must say how its receipt is priced.
- `cost_booking` now holds rows for receipts as well as issues; nothing else reads it.
- Owner question: approve decisions 1–4, in particular that the correction posts as the replay's ordinary
  `COST_ADJUSTMENT` (and so inherits its `5000`/`1300` accounts) rather than as a separate entry per pair.
