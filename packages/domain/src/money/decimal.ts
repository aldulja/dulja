import Decimal from "decimal.js";

/**
 * Every internal computation in this package runs on this constructor, never on the global `Decimal`.
 * Cloning keeps our precision away from an application that also uses decimal.js (spec §0.2: no hidden global state).
 *
 * precision 40: the widest intermediate we produce is money (19,4) multiplied by a rate (19,8) — 19 + 8 significant
 * digits before rounding — plus headroom for `allocate` and `Quantity.convert`, both of which divide before rounding.
 * toExpNeg/toExpPos are pushed out so `toFixed()` never returns exponential notation for a value we would persist.
 */
export const D = Decimal.clone({
  precision: 40,
  toExpNeg: -40,
  toExpPos: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

export type { Decimal };
