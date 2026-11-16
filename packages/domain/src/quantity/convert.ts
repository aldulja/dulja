// `D` is the cloned precision-40 Decimal of `money/decimal.ts`; `rounding.ts` exports `round`, the four
// `*_SCALE` constants and `RoundingMode` and NOT `D`. Two import lines, not one.
import { D } from "../money/decimal";
import { Quantity } from "../money/quantity";
import type { Rational } from "../money/rational";
import { QUANTITY_SCALE, round } from "../money/rounding";

/**
 * "The entered unit IS the base unit", named once so no caller types `{ numerator: 1n, denominator: 1n }`
 * a second time and no caller reaches for `rational(1n, 1n)` in a hot path.
 */
export const IDENTITY_CONVERSION: Rational = { numerator: 1n, denominator: 1n };

/**
 * Converts a quantity entered in some unit to the item's BASE unit, exactly (spec:2043 — "exact rationals
 * (numerator bigint, denominator bigint), never floats"; SAH-066).
 *
 * **This is NOT `Quantity.convert`, and the difference is the rounding mode — read this before "simplifying"
 * the body to a delegation.** §4.2.1 fixes `Quantity.convert(conversion)` as "exact; rounded HALF_EVEN to
 * 6 dp only at the end". Migration 0032's `app.document_line_base_quantity()` derives the same figure as
 * `round(new.unit_quantity * num::numeric / den::numeric, 6)`, and Postgres `numeric round()` is HALF AWAY
 * FROM ZERO. The two disagree at a tie: `1.000000 × 1/2000000` is `0.000000` under HALF_EVEN and `0.000001`
 * under the trigger. The trigger *raises* rather than overwrites when a supplied `quantity` disagrees with
 * the entered pair, so an API caller that computed `quantity` with HALF_EVEN and posted both values would
 * get ERR_VALIDATION_FAILED on a perfectly legitimate line — a defect indistinguishable from SAH-066 to the
 * user who hits it.
 *
 * **The body below is `Quantity.convert`'s body with one token changed — the mode — and it must stay that
 * way.** 0D's `convert` is `this.value.times(numerator).div(denominator)` at the cloned constructor's
 * precision 40, rounded ONCE at the end, with the docstring "Rounding per step is the SAH-066 defect". This
 * function repeats that exact order and rounds `HALF_AWAY_FROM_ZERO` instead. **It is deliberately NOT
 * `Quantity.multiply(conversion, "HALF_AWAY_FROM_ZERO")`**, which looks like the shorter route and is not:
 * `multiply` collapses a `Rational` to a `Decimal` FIRST (`new D(numerator).div(new D(denominator))`) and
 * multiplies afterwards, so it divides before it multiplies — the per-step rounding shape 0D wrote `convert`
 * to avoid. At precision 40 the two agree on every plausible package factor, but "agrees in practice" is not
 * the standard SAH-066 sets, and the trigger multiplies before it divides
 * (`new.unit_quantity * num::numeric / den::numeric`). Same order as the SQL, same mode as the SQL.
 *
 * What is named here is the **mode contract**: every conversion whose result has to agree with a
 * `document_line` row goes through `applyConversion`, so a reviewer greps one symbol and the mode is never a
 * caller's choice. `Quantity.convert` remains correct for display-side conversion, where nothing compares it
 * to a stored row.
 *
 * `rational()` has already refused a zero denominator (ERR_RATIONAL_ZERO_DENOMINATOR), so there is no divisor
 * guard here: SAH-063's defect was six unguarded divisions, and the guard belongs at construction, once.
 */
export function applyConversion(unitQuantity: Quantity, conversion: Rational): Quantity {
  const exact = new D(unitQuantity.toDecimal())
    .times(new D(conversion.numerator.toString()))
    .div(new D(conversion.denominator.toString()));
  return Quantity.of(round(exact, QUANTITY_SCALE, "HALF_AWAY_FROM_ZERO").toFixed(QUANTITY_SCALE));
}

/** Re-exported for callers that need the scale in an error message; never used to change it. */
export { QUANTITY_SCALE };
