# ADR 0035 — Movement planning belongs to the evaluator, and the provisional value rule

**Status:** ACCEPTED — a structural choice inside the posting service with no money, security or data-model consequence; §3.9 admits it as recorded-and-executed.
**Date:** 2026-09-20
**Deciders:** architect
**Slice:** 3A
**Related:** ADR 0026 (the posting-policy schema), ADR 0034 (the sentinel lot), ADR 0036 (unit conversion, FEFO)
**Spec:** §3.4 movement rules (spec:1212, 1225–1226), §4.4.2 PlannedMovement, contracts §4.7.2

## Context

Two sentences in the frozen contracts disagreed about where `inventory.effect` is read.

2A's `evaluatePolicy` returns `movements: []` with the note that the field "is read by 3A's `applyMovements`
(contracts §4.7.2), which is the slice that has `app.item` and `app.warehouse` to plan against".

But contracts §4.4.2's doc comment on `PlannedMovement` says "**the evaluator assigns `movementNo` in
emission order**", and §4.7.2 says `applyMovements` "assign[s] `movement_no` from
`plan.movements[i].movementNo`" — it *reads* the number. Something upstream has to have produced it.

## Decision

**`planMovements(policy, snapshot)` lives in `packages/domain/src/posting/evaluate.ts` and `evaluatePolicy`
returns its result.** `applyMovements` consumes the array and interprets no policy.

Both readings of 2A's sentence end in the same slice — 3A writes the code either way — and this one is
correct on three counts:

1. **It is pure.** Every input is already on the snapshot after 3A's migration 0032 and its `loadSnapshot`
   edit: `policy.inventory`, each line's `itemId` / `quantity` / `warehouseId` / `toWarehouseId` / `lotId`,
   the header's two warehouses, and `refs.items`. No I/O is needed to plan, so planning belongs on the pure
   side of the line and 3B's golden fixtures (`tests/golden/costing/`) can call it with no database.
2. **It is the only place that can number movements.** `movementNo` is 1-based per document and a `transfer`
   line emits two, so the number is a property of the whole emission sequence — which only the evaluator sees
   in one pass.
3. **It keeps `applyMovements` replaceable.** 3B rewrites that body from "value = unit price × quantity" to
   "value from `costingEngine.cost()` plus layers and consumptions". If policy interpretation lived there,
   3B's rewrite would carry it, and the two versions could disagree about which warehouse a line ships from.

**The provisional value rule stays in `applyMovements` and is 3B's to delete.** §4.7.2 fixes it as
`round(unit_price × quantity, 4)` in base currency for both directions, with `line.amount` as the fallback
when `unitPrice` is null (so a free-of-charge line values at zero — spec:1055). `PlannedMovement.value` is
therefore `null` on every movement this function returns.

## Consequences

- `PlannedMovement.quantity` is a magnitude and `effect` is the sole carrier of direction — the same rule
  amendment A9 fixed for `PlannedLedgerLine.side`. A reversal's negated line quantity flips the effect; a
  transfer swaps its legs and keeps their order. **`quantity.isNegative()` is always false**, and 3B, 3D, 6A
  and 9B must read `effect`.
- Nine planning rules are now contract rather than implementation detail; they are listed in 3A's Task 7 and
  proved by `packages/domain/test/posting/plan-movements.test.ts`.
- **`PlannedMovement.costing` is derived from the emitted `effect`, not copied from `policy.inventory.costing`
  — with `"zero"` as the one exception.** §4.7.1's engine branches on the movement's direction to produce a
  layer or consumptions, so a receipt carrying `consume_layers` (which is what a reversal of an `issue` policy
  would carry if the declared label were copied) is a plan nothing can price. `"zero"` is not a direction but
  the free-of-charge instruction §4.7.1 reads (spec:1055), so it passes through both branches unchanged. The
  rule lives in one helper, `costingFor`, used by all three emission sites.
- `policy.inventory.allowNegative` is read by nothing. Test 18 wants the refusal regardless of user
  attributes, and a policy flag is one; the field stays in the schema unread until this document is amended.
- A stock-moving effect declared with `costing: "none"` is `ERR_POLICY_INVALID` at post. `validatePolicy` at
  seed time cannot catch it — the JSON Schema admits the combination — so the seeder of such a type learns
  from its first post, and 3B's engine never receives an unpriceable movement.
- `line.to_warehouse` resolves through the header at 3A, because no `document_line.to_warehouse_id` column
  exists. If 3D adds one, only `resolveToWarehouse`'s first branch changes.
