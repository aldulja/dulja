import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { Quantity, rational } from "../src/index";

const q = (s: string) => Quantity.of(s);

describe("Quantity — spec §3.9 'numeric(19,6), exact rational conversions' (LEGACY-066)", () => {
  it("of() pads to six decimal places and refuses a seventh", () => {
    expect(q("12").toString()).toBe("12.000000");
    expect(q("12.5").toString()).toBe("12.500000");
    expect(() => q("12.0000005")).toThrow(RangeError);
    expect(() => q("1e3")).toThrow(RangeError);
    expect(() => q("")).toThrow(RangeError);
  });

  it("of() accepts numeric(19,6)'s 13-digit integral boundary and rejects a fourteenth digit", () => {
    expect(q("9999999999999.999999").toString()).toBe("9999999999999.999999");
    expect(() => q("10000000000000.000000")).toThrow(RangeError);
  });

  it("add, subtract and negate are exact at scale 6", () => {
    expect(q("0.1").add(q("0.2")).toString()).toBe("0.300000");
    expect(q("1").subtract(q("2.5")).toString()).toBe("-1.500000");
    expect(q("-3").negate().toString()).toBe("3.000000");
    expect(Quantity.zero().toString()).toBe("0.000000");
  });

  it("multiply requires an explicit rounding mode", () => {
    expect(q("3").multiply("0.3333335", "HALF_AWAY_FROM_ZERO").toString()).toBe("1.000001");
    expect(q("3").multiply("0.3333335", "TOWARD_ZERO").toString()).toBe("1.000000");
    expect(q("3").multiply(new Decimal("2"), "HALF_EVEN").toString()).toBe("6.000000");
  });

  it("multiply rejects non-finite factors before producing a quantity", () => {
    for (const factor of ["NaN", "Infinity", "-Infinity", new Decimal(NaN)]) {
      expect(() => q("1").multiply(factor, "HALF_EVEN"), String(factor)).toThrow(RangeError);
    }
  });

  it("arithmetic refuses results outside numeric(19,6)", () => {
    const max = q("9999999999999.999999");
    expect(() => max.add(q("0.000001"))).toThrow(RangeError);
    expect(() => q("-9999999999999.999999").subtract(q("0.000001"))).toThrow(RangeError);
    expect(() => max.multiply("2", "HALF_EVEN")).toThrow(RangeError);
    expect(() => max.convert(rational(2n, 1n))).toThrow(RangeError);
  });

  it("convert() divides exactly and rounds HALF_EVEN once, at the end (spec §3.9)", () => {
    expect(q("5").convert(rational(12n, 1n)).toString()).toBe("60.000000");
    expect(q("1").convert(rational(1n, 3n)).toString()).toBe("0.333333");
    expect(q("2").convert(rational(1n, 3n)).toString()).toBe("0.666667");
    expect(q("1").convert(rational(15n, 10_000_000n)).toString()).toBe("0.000002");
    expect(q("1").convert(rational(25n, 10_000_000n)).toString()).toBe("0.000002");
  });

  it("converting there and back loses nothing when the ratio divides exactly", () => {
    const cartons = q("7.5");
    const units = cartons.convert(rational(12n, 1n));
    expect(units.convert(rational(1n, 12n)).toString()).toBe(cartons.toString());
  });

  it("compare, isZero, isNegative and the wire form", () => {
    expect(q("1").compare(q("2"))).toBe(-1);
    expect(q("2").compare(q("2.000000"))).toBe(0);
    expect(q("3").compare(q("2"))).toBe(1);
    expect([Quantity.zero().isZero(), q("-1").isNegative(), q("0").isNegative()]).toEqual([
      true,
      true,
      false,
    ]);
    expect(q("1.5").toJSON()).toBe("1.500000");
    expect(q("1.5").toDecimal().toFixed(6)).toBe("1.500000");
  });

  it("instances are frozen", () => {
    const a = q("1");
    expect(Object.isFrozen(a)).toBe(true);
    a.add(q("1"));
    expect(a.toString()).toBe("1.000000");
  });
});
