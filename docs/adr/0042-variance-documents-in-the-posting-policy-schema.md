# ADR 0042 — Variance documents in the frozen posting-policy schema

- **Status:** Proposed — and, like ADR 0020, ADR 0026 and ADR 0041 before it, **implemented behind the
  proposal**: the five resolution rules are live in `packages/domain/src/posting/evaluate.ts` as of 3D Task 3.
  spec:95 sends a money-semantics and data-model decision to the owner, and the signed variance quantity, the
  effect flip and the two-quantity transfer are all money semantics, so this is asked before it is relied on
  rather than after. If it is rejected, the cost is this one file and its two test files — no migration, no
  schema file, no seeded policy.
- **Date:** 2026-09-05
- **Slice:** 3D
- **Spec:** spec:95 (an ADR proposal precedes a money-semantics change), spec:1052 (a stock count posts only
  the variance), spec:1053 (a two-step transfer, variance on receipt), spec:2289 (the Phase 3 definition of
  done); contracts §4.4.1 (`posting-policy.schema.json`), §4.4.2 (`PlannedLedgerLine`, `PlannedMovement`,
  amendments A5 and A9), §4.3.4 (`counted_quantity` / `expected_quantity`), §4.7.1 (`CostingEngine`),
  §4.7.3 (`inventory_movement`); Part I LEGACY-018

## Context

`STOCK_COUNT` must post only the variance (spec:1052) and `TRANSFER_RECEIPT` must post a variance on
receipt (spec:1053). `posting-policy.schema.json` has one `inventory.effect` and one `inventory.costing`
per policy, and §4.4.1 fixes any schema change as a new `version` const and a new `$id` — which would
invalidate every policy file in the repository. So neither document type may add an effect.

## Decision

Five resolution rules inside `evaluatePolicy`, over references the schema already admits:

1. On a `document_line` carrying `counted_quantity` and `expected_quantity`, `quantity` is the signed
   variance `counted − expected`. `when: { "line.quantity_sign": … }` — a key the frozen schema already
   has and that nothing else uses — resolves from it; zero and null match neither value.
2. `PlannedMovement.quantity` is a magnitude and `effect` carries the direction. A negative resolved
   quantity emits the opposite effect and swaps `costing`. `applyMovements` writes the sign onto the row.
3. A planned movement whose quantity is zero or null is dropped: `inventory_movement` carries
   `check (quantity <> 0)`. **A line that carries neither count column keeps 3A's refusal of a null
   quantity** (`ERR_POLICY_REQUIRES_MISSING`): on an ordinary line a missing quantity is a missing number,
   while on a counted line it is a sheet that matched, and the two must not be confused.
4. For `effect: "transfer"` the issue leg carries `expected_quantity` and the receipt leg
   `counted_quantity` when both are present. This is the only in-schema place a receipt variance can live.
   Each leg is oriented by rule 2 on its own, and each is dropped by rule 3 on its own.
5. `PlannedLedgerLine.fill` records whether a line resolved from `line.cost` or `line.variance_value`, so
   `applyMovements` can fill two amendment-A5 survivors on one source line with the right magnitude. It is
   **absent**, not `undefined`, on every other reference, so every existing whole-line `toEqual` assertion
   in 1A's, 2A's and 2B's suites stays green. `role: "cost"` (3B's amendment A4) says only that an amount is
   already in base currency; it cannot tell the two cost references apart, which is why `fill` exists.

## Consequences

- `$id`, `"version": 1` and every existing policy file are untouched; the change is additive. **No file
  under `packages/domain/posting-policy.schema.json` was edited by this task**, so `policy:types` regenerates
  `src/posting/policy.ts` byte for byte and every seeded policy still validates.
- A variance's direction is a _policy_ decision (`when` on the sign), never a sign test in code — which is
  what §4.4.2's warning about 3D demands. The one sign test that remains is `orientLeg`, and it decides a
  movement's `effect`, never a ledger `side`.
- The variance is never stored: `document_line.quantity` is the one number and every consumer derives from
  it. That is LEGACY-018's fix stated in the schema rather than in a trigger.
- 3B's `costingEngine` needs two pins to make rule 2 total: a receipt with no value is costed at
  `average(openLayers)`, and `allowNegative` suppresses the uncovered-quantity refusal. Both are Task 0.
- Rule 3's counted-line exemption is the one place this ADR touches a rule 3A wrote. It narrows nothing: an
  uncounted line behaves exactly as it did, and 3A's own test of that refusal is unchanged and still passes.
