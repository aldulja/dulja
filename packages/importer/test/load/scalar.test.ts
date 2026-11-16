import { currency, Money } from "@dulja/domain";
import { describe, expect, it } from "vitest";
import {
  dateOf,
  flagOf,
  moneyOf,
  optionalDateOf,
  optionalText,
  quantityOf,
  rationalOf,
  requireText,
} from "../../src/load/scalar";
import type { LegacyRow } from "../../src/legacy/types";

const MYR = currency("MYR");
const row: LegacyRow = {
  NAME: "  Piece  ",
  BLANK: "   ",
  NONE: null,
  FLAG: true,
  AMT: "1234.56785",
  NEG: "-0.00005",
  EXP: "1.2345000000000000E+002",
  WIDE: "1000000000000000",
  QTY: "2.0000005",
  WORD: "twelve",
  DAY: "2026-01-31",
  STAMP: "2026-01-31 23:59:59.0000",
  BADDAY: "2026-02-30",
  SLASH: "31/01/2026",
};

describe("the scalar boundary — legacy text becomes a Dulja type here or nowhere (9B plan N5)", () => {
  it("trims text, reads a boolean as 1/0, and treats blank as absent", () => {
    expect(requireText(row, "NAME", "UNITS/1")).toBe("Piece");
    expect(requireText(row, "FLAG", "UNITS/1")).toBe("1");
    expect(optionalText(row, "BLANK")).toBeNull();
    expect(optionalText(row, "NONE")).toBeNull();
    expect(optionalText(row, "MISSING")).toBeNull();
    expect(() => requireText(row, "BLANK", "UNITS/1")).toThrow(
      /^ERR_VALIDATION_FAILED: UNITS\/1: BLANK is empty; the loader will not guess a value/,
    );
  });

  it("refuses a NULL amount and a NULL quantity rather than reading either as zero (SAH-007, SAH-011)", () => {
    expect(() => moneyOf(row, "NONE", MYR, "ACCTOTALS/7")).toThrow(
      /^ERR_VALIDATION_FAILED: ACCTOTALS\/7: NONE is NULL; a NULL legacy amount is never read as zero \(SAH-007, SAH-011\)$/,
    );
    expect(() => quantityOf(row, "NONE", "BILLITEMS/9")).toThrow(
      /NONE is NULL; a NULL legacy quantity is never read as zero/,
    );
  });

  it("rounds an amount once, at scale 4, half away from zero, in the company's currency", () => {
    const amount = moneyOf(row, "AMT", MYR, "x");
    expect(amount.toString()).toBe("1234.5679");
    expect(amount.currency).toBe("MYR");
    expect(moneyOf(row, "NEG", MYR, "x").toString()).toBe("-0.0001");
    expect(moneyOf(row, "EXP", MYR, "x").equals(Money.of("123.45", MYR))).toBe(true);
  });

  it("refuses a value that is not a decimal, and one numeric(19,4) cannot hold", () => {
    expect(() => moneyOf(row, "WORD", MYR, "x")).toThrow(
      /WORD is "twelve", which is not a decimal/,
    );
    expect(() => moneyOf(row, "WIDE", MYR, "x")).toThrow(/does not fit numeric\(19,4\)/);
  });

  it("reads a quantity at scale 6", () => {
    expect(quantityOf(row, "QTY", "x").toString()).toBe("2.000001");
    expect(() => quantityOf(row, "WIDE", "x")).toThrow(/does not fit numeric\(19,6\)/);
  });

  it("takes the calendar date of a date or a timestamp, and refuses anything else", () => {
    expect(dateOf(row, "DAY", "x")).toBe("2026-01-31");
    expect(dateOf(row, "STAMP", "x")).toBe("2026-01-31");
    expect(optionalDateOf(row, "NONE", "x")).toBeNull();
    expect(() => dateOf(row, "BADDAY", "x")).toThrow(
      /"2026-02-30", which is not a YYYY-MM-DD date/,
    );
    expect(() => optionalDateOf(row, "SLASH", "x")).toThrow(/which is not a YYYY-MM-DD date/);
    expect(() => dateOf(row, "NONE", "x")).toThrow(/NONE is empty/);
  });

  it("reads a legacy flag in the forms a Firebird D_BOOLEAN or smallint casts to, and refuses any other value", () => {
    const flags: LegacyRow = {
      A: "1",
      B: "0",
      C: "T",
      D: "f",
      E: "Yes",
      F: "N",
      G: true,
      H: "2",
      I: null,
    };
    expect(["A", "B", "C", "D", "E", "F", "G"].map((c) => flagOf(flags, c, "x"))).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(flagOf(flags, "I", "x")).toBeNull();
    expect(flagOf(flags, "MISSING", "x")).toBeNull();
    // "2" is not read as false — the plan's `truthy` would have, and a typo'd flag would have silently made a
    // service a product.
    expect(() => flagOf(flags, "H", "MATERIALS/12")).toThrow(
      /^ERR_VALIDATION_FAILED: MATERIALS\/12: H is "2", which is not a flag \(1\/0, T\/F, Y\/N, TRUE\/FALSE, YES\/NO\)$/,
    );
  });

  it("converts a legacy float factor to an exact Rational, never through a number and never to Money (SAH-066)", () => {
    const factors: LegacyRow = {
      TWELVE: "12",
      HALF: "0.5",
      SCI: "1.25E+001",
      THIRD: "0.333333333333333",
      TINY: "1e-30",
      ZERO: "0.0000",
      NEG: "-3",
      NONE: null,
      WORD: "a dozen",
    };
    expect(rationalOf(factors, "TWELVE", "x")).toEqual({ numerator: 12n, denominator: 1n });
    expect(rationalOf(factors, "HALF", "x")).toEqual({ numerator: 1n, denominator: 2n });
    expect(rationalOf(factors, "SCI", "x")).toEqual({ numerator: 25n, denominator: 2n });
    // The stored float, exactly as the source prints it — 1/3 is what the operator meant and nothing here guesses
    // it: the factor that round-trips is the owner's to enter after cut-over (spec SAH-066).
    expect(rationalOf(factors, "THIRD", "x")).toEqual({
      numerator: 333333333333333n,
      denominator: 1000000000000000n,
    });
    expect(() => rationalOf(factors, "ZERO", "MATUNITS/1")).toThrow(
      /^ERR_VALIDATION_FAILED: MATUNITS\/1: ZERO is 0\.0000; a unit conversion factor must be positive \(SAH-066\)$/,
    );
    expect(() => rationalOf(factors, "NEG", "x")).toThrow(/must be positive \(SAH-066\)/);
    expect(() => rationalOf(factors, "NONE", "MATUNITS/1")).toThrow(
      /^ERR_VALIDATION_FAILED: MATUNITS\/1: NONE is NULL; a missing conversion factor is never read as 1 \(SAH-066\)$/,
    );
    expect(() => rationalOf(factors, "WORD", "x")).toThrow(/"a dozen", which is not a decimal/);
    expect(() => rationalOf(factors, "TINY", "x")).toThrow(/does not fit a bigint ratio/);
  });
});
