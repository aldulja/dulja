import { describe, expect, it } from "vitest";
import { applyConversion, IDENTITY_CONVERSION, Quantity, rational } from "../../src";

describe("applyConversion — exact rational unit conversion (spec:2043, LEGACY-066)", () => {
  it("1 carton of 12 pieces is 12 base units", () => {
    expect(applyConversion(Quantity.of("1.000000"), rational(12n, 1n)).toString()).toBe(
      "12.000000",
    );
    expect(applyConversion(Quantity.of("3.500000"), rational(12n, 1n)).toString()).toBe(
      "42.000000",
    );
  });

  it("a fractional conversion is exact, not a float — 1 piece = 1/12 carton", () => {
    // 1/3 of a base unit at 6 dp; a double would give 0.33333333333333331 and drift over a thousand lines.
    expect(applyConversion(Quantity.of("1.000000"), rational(1n, 3n)).toString()).toBe("0.333333");
    // Three of them sum to 0.999999, and the plan says so rather than pretending it is 1: the residue is a
    // reporting fact, and clamping it here would be the invented precision spec:2043 forbids.
    const third = applyConversion(Quantity.of("1.000000"), rational(1n, 3n));
    expect(third.add(third).add(third).toString()).toBe("0.999999");
  });

  it("rounds HALF_AWAY_FROM_ZERO at a tie, matching Postgres round() and NOT Quantity.convert", () => {
    // 1 × 1/2000000 = 0.0000005 — exactly a tie at QUANTITY_SCALE. The 0032 trigger computes
    // round(1.000000 * 1 / 2000000, 6), and Postgres numeric round() is half away from zero, so the
    // database says 0.000001. §4.2.1 fixes Quantity.convert at HALF_EVEN, which would say 0.000000 and
    // would then be REFUSED by the trigger's agreement branch on a legitimate line. applyConversion is
    // the trigger's twin because of this mode, not despite it.
    const tie = rational(1n, 2000000n);
    expect(applyConversion(Quantity.of("1.000000"), tie).toString()).toBe("0.000001");
    expect(applyConversion(Quantity.of("1.000000"), tie).toString()).not.toBe(
      Quantity.of("1.000000").convert(tie).toString(),
    ); // the two modes are observably different
    // Away from zero on the negative side too, which is what keeps a reversal's negated pair in agreement.
    expect(applyConversion(Quantity.of("-1.000000"), tie).toString()).toBe("-0.000001");
    // 3 × 1/2000000 = 0.0000015, another tie. This case pins the ORDER as well as the mode: multiply by the
    // numerator, THEN divide by the denominator, then round once — the order 0D's `convert` uses and the
    // order the SQL trigger uses (`unit_quantity * num / den`). Collapsing the rational to a Decimal first,
    // which is what `Quantity.multiply(rational, mode)` does, is the per-step rounding shape LEGACY-066 is.
    expect(applyConversion(Quantity.of("3.000000"), tie).toString()).toBe("0.000002");
  });

  it("the identity conversion is the base unit and changes nothing", () => {
    expect(IDENTITY_CONVERSION).toEqual({ numerator: 1n, denominator: 1n });
    expect(applyConversion(Quantity.of("7.250000"), IDENTITY_CONVERSION).toString()).toBe(
      "7.250000",
    );
  });

  it("is symmetric across sign, which is what makes a reversal agree with its original", () => {
    const positive = applyConversion(Quantity.of("2.500000"), rational(7n, 3n));
    const negative = applyConversion(Quantity.of("-2.500000"), rational(7n, 3n));
    expect(negative.toString()).toBe(positive.negate().toString());
  });

  it("a zero denominator is refused by rational() before it reaches here (LEGACY-063)", () => {
    expect(() => rational(12n, 0n)).toThrow(/ERR_RATIONAL_ZERO_DENOMINATOR/);
  });
});
