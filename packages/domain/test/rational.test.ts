import { describe, expect, it } from "vitest";
import { rational, rationalToDecimal, RationalZeroDenominatorError } from "../src/index";

describe("Rational — exact unit conversions, never floats (spec §3.9; LEGACY-066)", () => {
  it("keeps numerator and denominator as bigints, normalised to a positive denominator", () => {
    expect(rational(12n, 5n)).toEqual({ numerator: 12n, denominator: 5n });
    expect(rational(12n, -5n)).toEqual({ numerator: -12n, denominator: 5n });
    expect(rational(-12n, -5n)).toEqual({ numerator: 12n, denominator: 5n });
  });

  it("reduces by the greatest common divisor so equal ratios are structurally equal", () => {
    expect(rational(1000n, 250n)).toEqual(rational(4n, 1n));
    expect(rational(0n, 7n)).toEqual({ numerator: 0n, denominator: 1n });
  });

  it("a zero denominator raises ERR_RATIONAL_ZERO_DENOMINATOR", () => {
    expect(() => rational(1n, 0n)).toThrow(RationalZeroDenominatorError);
    try {
      rational(1n, 0n);
    } catch (e) {
      expect((e as RationalZeroDenominatorError).code).toBe("ERR_RATIONAL_ZERO_DENOMINATOR");
    }
  });

  it("converts to a Decimal at an explicit scale and mode — a third never becomes 0.333333333…", () => {
    expect(rationalToDecimal(rational(1n, 3n), 6, "HALF_AWAY_FROM_ZERO").toFixed(6)).toBe(
      "0.333333",
    );
    expect(rationalToDecimal(rational(2n, 3n), 6, "HALF_AWAY_FROM_ZERO").toFixed(6)).toBe(
      "0.666667",
    );
    expect(rationalToDecimal(rational(-2n, 3n), 6, "HALF_AWAY_FROM_ZERO").toFixed(6)).toBe(
      "-0.666667",
    );
  });

  it("survives values far beyond IEEE-754 exactness (the LEGACY-066 class)", () => {
    const r = rational(9007199254740993n, 3n);
    expect(rationalToDecimal(r, 6, "TOWARD_ZERO").toFixed(6)).toBe("3002399751580331.000000");
  });
});
