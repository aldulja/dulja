# ADR 0036 — Exact unit conversion at line write, and FEFO over the synchronous projection

- Status: Accepted
- Date: 2026-09-07
- Slice: 3A
- Supersedes: none. Related: ADR 0034 (the sentinel lot), ADR 0035 (movement planning in the evaluator)

## Context

Two decisions in one record, because they share a root cause: the legacy system computed an answer at each
call site instead of once, and the answer therefore depended on which call site ran.

**SAH-066** — `MatUnits.Exchange` held a conversion factor per (material, unit) and no code multiplied by it.
Quantities were entered in cartons and stored as if they were pieces. The factor existed as data and as
documentation and as nothing else.

**SAH-067** — stock on hand was computed by replaying the entire movement history under a hinted
index-navigation plan. Two consequences: it was slow in proportion to history rather than to stock, and the
row order — and so the answer to "which batch do I pick?" — was a property of the chosen plan rather than of
the data.

## Decision

**1. The base quantity is derived in SQL, by a trigger on `app.document_line`.**
`app.document_line_base_quantity()` (migration 0032) fires BEFORE INSERT OR UPDATE. When a line carries the
entered pair `(unit_id, unit_quantity)` it sets `quantity := round(unit_quantity × numerator / denominator, 6)`
from `app.unit_conversion`, resolving the item's own base unit to 1/1 and raising `ERR_VALIDATION_FAILED` for
an unconfigured unit. When the caller also supplied `quantity`, the two must agree.

`packages/domain`'s `applyConversion(unitQuantity, conversion)` is the read-side twin, used for previews and
for plan inputs. It is `Quantity.convert`'s arithmetic — `times(numerator).div(denominator)` at precision 40,
rounded once at `QUANTITY_SCALE` — with **`HALF_AWAY_FROM_ZERO` in place of `convert`'s HALF_EVEN**, which
§4.2.1 fixes. What this ADR decides is the **mode**, and only the mode. The trigger's `round(…, 6)` is
Postgres `numeric round()`, which is half away from zero, so a twin rounding HALF_EVEN would answer
`0.000000` where the database answers `0.000001` for `1 × 1/2000000`, and the trigger's agreement branch
would then refuse a legitimate line. Same scale by `QUANTITY_SCALE`, same mode by this decision — and the
same _order_: numerator first, denominator second, one rounding at the end, matching
`unit_quantity * num::numeric / den::numeric`. `Quantity.multiply(rational, mode)` is not used, because 0D
implements it by collapsing the rational to a decimal before multiplying, and rounding before multiplying is
the SAH-066 shape.

**2. FEFO reads `app.stock_on_hand`, and its ordering is total.**
`app.pick_lots_fefo(item_id, warehouse_id, quantity)` (migration 0031) walks the synchronous projection
ordered by `expires_on asc nulls last, code asc, lot_id asc` and returns `(lot_id, quantity)` pairs until the
requested quantity is met, or fewer if the warehouse cannot meet it.

## Consequences

- A carton quantity cannot be counted as pieces by any write path, including a hand-typed `app_rw` insert, the
  Phase 9 importer and Phase 6 sync apply. That is the whole content of "applied nowhere" being fixed.
- A caller that supplies a `quantity` inconsistent with its own entered pair gets a named refusal rather than
  a silently corrected row. `reverseDocument` negates `unit_quantity` alongside `quantity`, and the agreement
  branch passes because Postgres `round()` on `numeric` is symmetric across sign — and because
  `applyConversion`'s HALF_AWAY_FROM_ZERO is symmetric across sign too, which HALF_EVEN is not.
- **A conversion result that will be compared to a stored `document_line` row must be computed with
  `applyConversion`, never with `Quantity.convert`.** The two agree everywhere except at a tie at the sixth
  decimal place, and at a tie the trigger wins and the caller is refused. The agreement is asserted on both
  sides: `packages/domain/test/quantity/convert.test.ts` pins the pure value, and
  `packages/db/test/inventory/unit-conversion.test.ts` inserts a line at the tie and asserts the trigger's
  derived `quantity` equals `convertToBase`'s. §4.2.1 needs one sentence recording that its `Quantity` class
  now has two documented conversion modes for two different jobs.
- The trigger costs one indexed lookup per line carrying a unit pair, and none for a line without one.
- FEFO's cost is proportional to the number of open lots of one item in one warehouse, not to history.
- FEFO's answer is stable: the ordering is a total order on the candidate rows, so no planner choice can change
  it. The old behaviour is unreachable, not merely discouraged.
- The projection is synchronous (D14, MERGEd in the posting transaction), so outside a posting transaction the
  picker is current to the last commit. **Inside** one it is not, which is why `app.assert_stock_available`
  sums `inventory_movement` and never reads the projection (§4.7.3).
- Picking is a drafting-time concern: a user or a screen asks for lots before the document is posted. Nothing
  in the posting path calls `pick_lots_fefo`.
- A lot with no expiry — every item's `NONE` sentinel — sorts last, so a dated batch is always consumed first.
  For an item that genuinely has no batches, all stock is on the sentinel and the ordering is a no-op.
