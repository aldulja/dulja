# ADR 0039 — `stock_valuation` is an as-of snapshot; `cost_layer` is the checked projection

**Status:** PROPOSED — the plan's inline draft of this ADR reads `Accepted`, and that is not honest on this
branch. Two of the three decisions below narrow what the nightly alarm raises: the **value** half of
`stock_valuation` is never compared against `inventory_movement`, and a `(item, warehouse)` pair with an
**open authorised shortfall** is dropped from the quantity compare entirely. A rule about what an integrity
alarm will not report is a detection-coverage decision, and the shortfall carve-out is the direct
consequence of ADR 0038 note 7, which is itself a proposal implemented ahead of approval. So this ADR
carries the same status its parent does. It is implemented ahead of approval, as ADR 0020 was, as Phase 2's
0026, 0027 and 0029-0031 were, and as this slice's 0037 and 0038 are, and this line says so.
**Date:** 2026-09-20
**Deciders:** architect
**Slice:** 3B
**Supersedes:** nothing. **Related:** ADR 0038 (the bounded recost, and note 7's shortfall), ADR 0037 (AVCO
and the layer model), contracts §4.6.1 (`stock_valuation`), §4.7.2, §4.16.3 (`ProjectionCheck`), amendments
A10, A19 and A20, Part I LEGACY-009, LEGACY-079
**Spec:** §3.3 projections (spec:1204), §3.4 (spec:1210, 1228), §3.8 transactions (spec:1368, 1370), Part VI
test 2 (spec:2420)

## Context

spec:1204 names three **asynchronous** projections — `party_ageing`, `item_profitability` and the
`stock_valuation` history — and requires each of them "rebuilt from `ledger_entry`/`inventory_movement` into
scratch tables nightly and compared row for row; a mismatch is an incident". 1B built the
`projectionChecks` registry for exactly that comparison, 2B added `document_series` to it and 3A added
`stock_on_hand`. The obvious move is to add `stock_valuation` too. It is the wrong move, and the reason is
worth writing down once rather than being rediscovered by 4B when it reaches `party_ageing`.

## Decision

**1. `stock_valuation` does not join `projectionChecks`. `cost_layer` does.**

`projectionChecks` compares a **current-state** projection to a pure aggregate of the append-only tables:
its `ProjectionCheck.run(tx)` takes no date and no company, because there is exactly one right answer and
RLS has already reduced the table to one tenant. `stock_valuation` is a **history keyed by date**. "Rebuild
it" means "rebuild it for which dates?", and the only defensible answer is "the dates a job was asked to
snapshot" — which is an argument, not a pure function. Its rebuild-and-compare therefore belongs to
`inventory.projection.rebuild`, the job spec:1204 names for precisely this, and its result is a
`ProjectionMismatch` the handler records through 1B's `recordIntegrityIncident`. The mismatch shape, the
incident row and the audit chain are all shared with the registry; only the trigger differs.

`cost_layer` joins the registry instead, as `COST_LAYER_CHECK` (Task 12), because it **is** current state
and it **does** have a pure invariant: `qty_remaining = qty_in − Σ(valid consumptions)`.

**2. Only the quantity half is compared against `inventory_movement`.**

An issue's `inventory_movement.value` is the value it was **posted** with and is immutable (ADR 0038
decision 1). After a recost the consumptions carry a different figure and the difference is booked as a
`COST_ADJUSTMENT`. So `Σ movement.value` and the layer-derived value legitimately differ by exactly the
adjustments already posted, and asserting their equality would raise an incident every single time a
back-dated document was handled **correctly** — the failure mode LEGACY-079 is made of. The value's integrity
is the layer invariant above, checked by `COST_LAYER_CHECK`, and the quantity half stays an exact compare:
the layer-derived quantity must equal `sum(inventory_movement.quantity)` as at the date, and a difference
is a real incident.

**3. A pair with an open authorised shortfall is excluded from the quantity compare, by name.**

ADR 0038 note 7: an `inventory.negative_stock.override` issue the layers cannot cover is **valued** but
produces no `cost_consumption` row, because `cost_consumption.layer_id` is NOT NULL and there is no layer
to point at. For that `(item, warehouse)` the layers therefore exceed the movements by the open shortfall
until a **back-dated** receipt makes the replay recompute the issue against replenished layers — a later
receipt does not close it, because nothing re-consumes a historical shortfall in v1. Comparing such a pair
would raise the same incident every night over a correctly authorised excursion, so `rebuildStockValuation`
computes the current gap per pair and returns an excluded pair in `excluded`, which the handler logs by
name rather than silently dropping. The carve-out is bounded by a test, not by this paragraph:
`packages/db/test/costing/valuation.test.ts` opens a shortfall, asserts the pair lands in `excluded` and
**not** in `mismatches`, and asserts it returns to the compared set once the gap closes.

**4. A stored as-of row changing after a replay is designed behaviour, not an incident.**

Yesterday's snapshot said the stock was worth X; a back-dated purchase arriving today makes yesterday's
stock worth Y, and the row is **supposed** to be rewritten. It is a materialised answer to "what was this
worth as at D", never an archive. The archive is `cost_consumption`'s invalidated generations and the
`COST_ADJUSTMENT` document.

## Consequences

- `IntegrityReport.projections.checked` becomes
  `["account_balance", "cost_layer", "document_series", "stock_on_hand"]` (amendment A10) — alphabetical,
  because `projectionChecks()` sorts by name. `stock_valuation` never appears in it; the string appears
  only in the handler's own `projections.checked` for the incident it writes.
- The rebuild derives its rows **from `valuationAsOf`** rather than from a second query that computes the
  same thing. Two derivations of one figure is LEGACY-009, and one function is what makes a stored snapshot
  and a live report unable to diverge (spec:1228).
- 4B adds `party_ageing` and `item_profitability` to `accounting.projection.rebuild` and meets the same
  question; this ADR is the precedent — a dated history is rebuilt by its job, current state by the
  registry.
- A tenant that never runs the nightly job has no valuation history and a perfectly correct live
  valuation, because `valuationAsOf` reads the layers. The snapshot is an optimisation and a record, never
  the source (spec:1210).
- A pair whose quantity fell to zero is **zeroed, not deleted**: contracts §3.5.4 grants `app_rw` no DELETE
  on this table, and a zero row is a true statement about that date.
- **Nothing above has been observed to hold.** `packages/db/test/costing/valuation.test.ts` and the
  `stock_valuation` case in `tests/invariants/projection-rebuild.test.ts` are written against the real
  exports and typecheck, but both need a PostgreSQL Testcontainer and the machine this slice was built on
  has no Docker daemon (`AGENTS.md`, "Current phase"). Acceptance test 2's `stock_valuation` re-run is
  therefore **written, unrun**.

## Accepted amendment — conserve exact layer value (2026-10-01)

**Status: ACCEPTED by the owner on 2026-10-01 (“fix them please”), following the concrete proposal.** Approval covers this amendment alone. It does not
ratify the other outstanding decisions in ADRs 0037–0039 or close OD-06.

The remaining costing regressions were rerun on `66ec03c` against PostgreSQL 18. Acceptance test 7
still compares valuation `167.0589` to ledger `167.0570`. The fourth blocker in Plan 3B's execution
handoff explains the representation defect: a receipt of three units worth `10.0000` produces a
four-decimal unit cost of `3.3333`, so the current layer represents only `9.9999`. There is a second
rounding point: AVCO issues multiply a rounded average by quantity, whereas valuation sums rounded
remaining values per layer. Adding a value column alone does not reconcile those two formulas.

### Decision

1. Add `app.cost_layer.value numeric(19,4) not null check (value >= 0)`. It holds the receipt's exact
   derived value, supplied by the costing engine, rather than `qty_in × unit_cost`. The domain `Layer`
   carries the same value as `Money`; `unitCost` remains a four-decimal derived display figure.
2. For a layer of original quantity `Q`, original exact value `V`, and remaining quantity `q`, define
   its remaining value as `R(V, q, Q) = round_half_away_from_zero(V × q / Q, 4)`. Calculate with decimal
   arithmetic and round once. A full layer therefore retains `V`, and an empty layer has zero value.
3. Keep the existing AVCO proportional quantity allocation and FIFO chronological quantity allocation.
   Price the covered issue as the sum of `R` before allocation minus the sum of `R` after allocation.
   Under AVCO, allocate that exact covered-value budget across the nonzero consumption quantities with
   the existing deterministic monetary allocation. Under FIFO, each consumption takes its own layer's
   before-minus-after value. Consumption values must sum exactly to the covered issue value.
4. Posting, replay, as-of valuation, open-layer reads, and stored valuation rebuilds use that same
   value rule. As-of reads calculate `q` from consumptions dated on or before the requested day, as they
   already do. Receipt-side report reads use exact layer value wherever they currently reconstruct it
   from a rounded unit cost. The separate immutable-movement COGS rule of `item_profitability` remains
   unchanged.
5. The provisional value of an authorised uncovered shortfall stays under ADR 0038's existing rule:
   the four-decimal running average times the uncovered quantity, rounded half away from zero. This
   amendment does not introduce shortfall netting or change the override permission or quantity guards.
   Negative computed cost remains a hard error.
6. Receipt and issue movements and posted ledger entries remain immutable. A replay changes derived
   layers/consumptions and books the corrected difference through the existing restartable
   `cost_booking` / `COST_ADJUSTMENT` path. It does not hide the mismatch with a report-only rounding rule.

For three units worth `10.0000`, three successive one-unit issues cost `3.3333`, `3.3334`, and `3.3333`.
The original value is conserved exactly, despite a displayed unit cost of `3.3333`. This deliberate
fourth-decimal change is why approval is required; existing golden output cannot simply be re-pinned.

### Implementation and verification after approval

- Amend frozen contracts §§4.7.1–4.7.3 and dependent value-read sentences before changing their interfaces.
  Allocate a new tail migration in the register; do not amend applied migration 0034 or take a reserved
  slice number. This proposal itself allocates no migration or ADR number.
- Backfill exact receipt values from immutable movements, with replay-specific receipt valuation handled
  by the same engine rather than trusting the old rounded `unit_cost`. Rebuild/replay derived state to
  correct pre-existing drift; book financial differences through the established adjustment path.
- Test non-divisible receipts, repeated partial issues, complete depletion, AVCO and FIFO, fractional
  quantity allocations, transfers and landed cost, as-of dates, shortfalls, and crash-restarted replay.
- Require acceptance test 7, LEGACY-009, the costing/golden suites, ledger/valuation tie-outs, tenant isolation,
  and migration up → down → up to pass. Review any intentional golden figure change individually.
- Once both remaining failures are resolved, include the currently excluded `tests` workspace in CI and
  update its lint exclusion and the verification record. No test is quarantined or weakened.

Transfer receipt pricing uses its same-line computed issue value even on a reversal whose copied `line.cost` holds the prior issue value. Copied cost remains the one-leg receipt rule. This preserves the existing equal-quantity transfer conservation rule now that exact marginal issue values can differ from rounded unit-cost products.
