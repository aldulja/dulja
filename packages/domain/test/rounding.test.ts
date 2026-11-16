import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { MONEY_SCALE, QUANTITY_SCALE, RATE_SCALE, round } from "../src/index";

const d = (s: string) => new Decimal(s);

describe("round() — spec §3.9 'one rounding function, explicit mode, symmetric across sign' (LEGACY-019)", () => {
  it("the three scales are the SQL column scales", () => {
    expect([MONEY_SCALE, RATE_SCALE, QUANTITY_SCALE]).toEqual([4, 8, 6]);
  });

  it("HALF_AWAY_FROM_ZERO is symmetric across sign — the mode the ledger CHECK requires (spec:1816)", () => {
    expect(round(d("2.50005"), 4, "HALF_AWAY_FROM_ZERO").toFixed(4)).toBe("2.5001");
    expect(round(d("-2.50005"), 4, "HALF_AWAY_FROM_ZERO").toFixed(4)).toBe("-2.5001");
    expect(round(d("2.50004"), 4, "HALF_AWAY_FROM_ZERO").toFixed(4)).toBe("2.5000");
    expect(round(d("-2.50004"), 4, "HALF_AWAY_FROM_ZERO").toFixed(4)).toBe("-2.5000");
  });

  it("HALF_EVEN goes to the even neighbour in both directions", () => {
    expect(round(d("2.50005"), 4, "HALF_EVEN").toFixed(4)).toBe("2.5000");
    expect(round(d("2.50015"), 4, "HALF_EVEN").toFixed(4)).toBe("2.5002");
    expect(round(d("-2.50005"), 4, "HALF_EVEN").toFixed(4)).toBe("-2.5000");
  });

  it("TOWARD_ZERO truncates and AWAY_FROM_ZERO inflates, both symmetrically", () => {
    expect(round(d("2.50009"), 4, "TOWARD_ZERO").toFixed(4)).toBe("2.5000");
    expect(round(d("-2.50009"), 4, "TOWARD_ZERO").toFixed(4)).toBe("-2.5000");
    expect(round(d("2.50001"), 4, "AWAY_FROM_ZERO").toFixed(4)).toBe("2.5001");
    expect(round(d("-2.50001"), 4, "AWAY_FROM_ZERO").toFixed(4)).toBe("-2.5001");
  });

  it("rounding an already-exact value at its own scale is the identity", () => {
    for (const mode of [
      "HALF_AWAY_FROM_ZERO",
      "HALF_EVEN",
      "TOWARD_ZERO",
      "AWAY_FROM_ZERO",
    ] as const) {
      expect(round(d("1234.5678"), 4, mode).toFixed(4)).toBe("1234.5678");
    }
  });

  it("a negative or non-integer scale is a programmer error", () => {
    expect(() => round(d("1"), -1, "HALF_EVEN")).toThrow(RangeError);
    expect(() => round(d("1"), 1.5, "HALF_EVEN")).toThrow(RangeError);
  });
});
