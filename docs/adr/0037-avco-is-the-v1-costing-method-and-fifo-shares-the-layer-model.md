# ADR 0037 — AVCO is the v1 costing method, and FIFO shares the same layer model

**Status:** PROPOSED — this is a money-semantics decision, so spec:95 requires it to be written as a proposal and asked before implementing, and owner decision OD-06 (contracts §2.12; spec:92, 1214, 2404) is the gate. It is implemented ahead of approval, as ADR 0020 was and as Phase 2's 0026, 0027 and 0029-0031 were, and this line says so.
**Date:** 2026-09-20
**Deciders:** owner (method, pending OD-06), architect (model)
**Slice:** 3B
**Supersedes:** nothing. **Related:** ADR 0034 (the sentinel lot), ADR 0035 (movement planning in the evaluator), ADR 0036 (unit conversion, FEFO), contracts §4.7.1, §4.7.3, Part I SAH-007, SAH-008, SAH-009, SAH-055
**Spec:** §3.4 (spec:1214, 1216-1218, 1222, 1225-1228), Part VI test 6 (spec:2424), §5.3 phase-3 confirmation row (spec:2404)

## Context

spec:1214 recommends weighted average (AVCO) as the v1 method, "matching the old system and the
business's expectations", and marks it ⚠️ _Owner to confirm_. spec:1214 also states that FIFO "is
supported by the same layer model … and can be enabled per company later without a schema change".

The old system had three weighted-average formulas — `procCalcCosts`, `procSumBillItems` and the
`OnBillItemsAIUD` trigger — which disagreed on transfer revaluation, on the zero-divisor fallback, on
reject-out revaluation and on whether a negative prior balance was clamped. Over the same data the trigger
answered 1.667 and `procCalcCosts` answered 10.00 (SAH-009). No amount of recosting could make the stock
valuation report and the profit report tie, because the formulas differed.

## Decision

1. **One implementation**, `costingEngine` in `packages/domain/src/costing/engine.ts`, pure, imported by
   posting, valuation and every report. spec:1228 states this as a requirement; this ADR records that the
   requirement is met by a single exported const and not by a convention.
2. **Both methods share one layer model.** A receipt writes a `cost_layer`; an issue writes
   `cost_consumption` rows. AVCO issues at the running average and consumes a proportional slice of every
   open layer; FIFO issues at each layer's own cost and consumes the oldest first. The tables, the
   chronological key and the replay are identical. Switching a company's method is one column write and no
   migration, exactly as spec:1214 promises.
3. **`company.costing_method` defaults to `'avco'`** and its CHECK admits `'avco'` and `'fifo'` only.
4. **The costing scope is `(company, item, warehouse)`,** not the lot. AVCO has no per-lot average and FIFO
   takes the oldest layer whatever lot it belongs to. Per-lot _availability_ is a separate control (3A's
   `assert_stock_available`) and per-lot _picking_ is a separate function (3A's `pick_lots_fefo`).
5. **Three guards are structural, not advisory:** `unit_cost >= 0` and `qty_remaining >= 0` are CHECKs on
   `cost_layer` (and `quantity > 0`, `unit_cost >= 0`, `value >= 0` on `cost_consumption`, amendment A23);
   a divisor below `MIN_MEANINGFUL_QTY = 0.000001` is **refused, not clamped** (amendment A22 — clamping
   0.0000005 to 0.000001 still returns the exploded unit cost test 6 forbids storing), and at
   `QUANTITY_SCALE = 6` such a divisor is unrepresentable anyway, so the refusal guards a future scale change
   rather than a runtime input; and a movement with no value and no way to compute one, or a movement of zero
   quantity, raises `ERR_COST_VALUE_MISSING`. These close SAH-007 and all three arms of SAH-008.

## Consequences

- A method change on a live company would need a full recost of that company from its first movement. The
  replay of ADR 0038 can do it, but nothing in v1 exposes it as an operation, and the switch is therefore a
  configuration decision taken once per company at setup.
- FIFO ships tested but not defaulted. If the owner answers OD-06 with FIFO, one literal in migration 0035
  changes and `tests/regression/sah-055.test.ts` becomes the ageing report's proof rather than a switch test.
- Reports may never recompute a cost. 7B's `inventory.stock_ageing` and `inventory.profit_by_item` read
  `cost_layer` and `cost_consumption`; a report that re-derived a figure would be SAH-009's fourth formula.
