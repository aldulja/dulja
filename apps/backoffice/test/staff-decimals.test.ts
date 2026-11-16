import { describe, expect, it } from "vitest";
import { amountToWire, fractionToPercent, percentToFraction } from "../src/lib/staff-decimals";

describe("staff policy entry", () => {
  it("translates displayed percentages into exact fractional limits", () => {
    expect(percentToFraction("15")).toBe("0.150000");
    expect(percentToFraction("0.0001")).toBe("0.000001");
    expect(percentToFraction("100")).toBe("1.000000");
    expect(fractionToPercent("0.150000")).toBe("15.0000");
  });
  it("preserves large amounts without floating-point conversion", () => {
    expect(amountToWire("999999999999999.9999")).toBe("999999999999999.9999");
    expect(amountToWire("0.05")).toBe("0.0500");
    expect(amountToWire("1")).toBe("1.0000");
  });
  it("refuses imprecise or out-of-range entry instead of silently rounding", () => {
    for (const input of ["100.0001", "-1", "1e2", "NaN", "0.00001", ""]) {
      expect(() => percentToFraction(input)).toThrow();
    }
    for (const input of ["-1", "1e4", "0.00001", ""]) {
      expect(() => amountToWire(input)).toThrow();
    }
  });
});
