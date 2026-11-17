import type Decimal from "decimal.js";
import { D } from "./decimal";
import { round, type RoundingMode } from "./rounding";

/** Exact rational for unit conversions (spec §3.9 Quantities; LEGACY-066). `denominator` is always > 0. */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export class RationalZeroDenominatorError extends Error {
  readonly code = "ERR_RATIONAL_ZERO_DENOMINATOR" as const;

  constructor() {
    super("ERR_RATIONAL_ZERO_DENOMINATOR: a unit conversion cannot have a zero denominator");
    this.name = "RationalZeroDenominatorError";
  }
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

/** Normalises the sign onto the numerator and reduces, so two equal ratios are structurally equal. */
export function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new RationalZeroDenominatorError();
  const sign = denominator < 0n ? -1n : 1n;
  const n = numerator * sign;
  const d = denominator * sign;
  const g = gcd(n, d);
  return { numerator: n / g, denominator: d / g };
}

/** Exact division at precision 40, rounded once, at the end, with an explicit mode (spec §4.6). */
export function rationalToDecimal(r: Rational, scale: number, mode: RoundingMode): Decimal {
  return round(new D(r.numerator.toString()).div(new D(r.denominator.toString())), scale, mode);
}
