import { describe, expect, it } from "vitest";
import { currency, Money, roundToIncrement } from "../src/index";

const MYR = currency("MYR");
const money = (value: string) => Money.of(value, MYR);
describe("cash increment rounding", () => {
  it("rounds signed halves symmetrically with the selected mode", () => {
    expect(roundToIncrement(money("1.0250"), "0.0500").toString()).toBe("1.0500");
    expect(roundToIncrement(money("-1.0250"), "0.0500").toString()).toBe("-1.0500");
    expect(roundToIncrement(money("1.0250"), "0.0500", "HALF_EVEN").toString()).toBe("1.0000");
    expect(roundToIncrement(money("-1.0250"), "0.0500", "HALF_EVEN").toString()).toBe("-1.0000");
  });
  it("keeps full quotient precision until the integer rounding decision", () => {
    // Money.divide would first make 1.49998333 into 1.5000 and wrongly round upward.
    expect(roundToIncrement(money("8.9999"), "6.0000").toString()).toBe("6.0000");
    expect(roundToIncrement(money("-8.9999"), "6.0000").toString()).toBe("-6.0000");
    expect(roundToIncrement(money("9.0001"), "6.0000").toString()).toBe("12.0000");
  });
  it("preserves currency and exact large values", () => {
    const rounded = roundToIncrement(money("999999999999999.9749"), "0.0500");
    expect(rounded.toJSON()).toEqual({ amount: "999999999999999.9500", currency: "MYR" });
    expect(roundToIncrement(money("0.0000"), "0.0500").toString()).toBe("0.0000");
  });
  it("refuses nonpositive, malformed or overprecision increments", () => {
    for (const increment of ["0", "0.0000", "-0.0500", "1e2", "NaN", "Infinity", "0.00001"]) {
      expect(() => roundToIncrement(money("1.0000"), increment)).toThrow();
    }
  });
});
