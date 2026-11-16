import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  currency,
  Money,
  MoneyCurrencyInvalidError,
  MoneyCurrencyMismatchError,
  MoneyScaleError,
  rational,
} from "../src/index";

const MYR = currency("MYR");
const m = (s: string) => Money.of(s, MYR);

describe("Money — spec §3.9 'opaque, carries its currency, never a float' (SAH-008)", () => {
  it("currency() accepts three upper-case letters and rejects everything else", () => {
    expect(currency("MYR")).toBe("MYR");
    for (const bad of ["myr", "MY", "MYRR", "M1R", " MYR", ""]) {
      expect(() => currency(bad)).toThrow(MoneyCurrencyInvalidError);
    }
    try {
      currency("myr");
    } catch (e) {
      expect((e as MoneyCurrencyInvalidError).code).toBe("ERR_MONEY_CURRENCY_INVALID");
    }
  });

  it("of() pads to four decimal places and refuses a fifth", () => {
    expect(m("1.5").toString()).toBe("1.5000");
    expect(m("1234").toString()).toBe("1234.0000");
    expect(m("-0.0001").toString()).toBe("-0.0001");
    expect(() => m("1.12345")).toThrow(MoneyScaleError);
    try {
      m("1.12345");
    } catch (e) {
      expect((e as MoneyScaleError).code).toBe("ERR_MONEY_SCALE");
    }
  });

  it("of() refuses anything that is not a decimal literal — no NaN, no Infinity, no exponent", () => {
    for (const bad of ["", "abc", "NaN", "Infinity", "1e4", "1,000.00", "0x10"]) {
      expect(() => Money.of(bad, MYR), bad).toThrow(MoneyScaleError);
    }
  });

  it("add and subtract are exact and stay at scale 4", () => {
    expect(m("0.1").add(m("0.2")).toString()).toBe("0.3000");
    expect(m("1000000000000.0001").add(m("0.0002")).toString()).toBe("1000000000000.0003");
    expect(m("5").subtract(m("7.5")).toString()).toBe("-2.5000");
  });

  it("adding a different currency is a runtime error as well as a compile error", () => {
    const usd = Money.fromJSON({ amount: "1.0000", currency: "USD" });
    const myr = Money.fromJSON({ amount: "1.0000", currency: "MYR" });
    expect(() => myr.add(usd)).toThrow(MoneyCurrencyMismatchError);
    try {
      myr.add(usd);
    } catch (e) {
      expect((e as MoneyCurrencyMismatchError).code).toBe("ERR_MONEY_CURRENCY_MISMATCH");
    }
  });

  it("multiply and divide demand an explicit rounding mode and accept a Rational", () => {
    expect(m("10").multiply("0.175", "HALF_AWAY_FROM_ZERO").toString()).toBe("1.7500");
    expect(m("10").multiply(rational(1n, 3n), "HALF_AWAY_FROM_ZERO").toString()).toBe("3.3333");
    expect(m("10").multiply(rational(1n, 3n), "TOWARD_ZERO").toString()).toBe("3.3333");
    expect(m("10").divide(new Decimal("3"), "HALF_EVEN").toString()).toBe("3.3333");
    expect(() => m("10").divide("0", "HALF_EVEN")).toThrow(RangeError);
  });

  it("allocate splits to the cent with nothing lost and nothing invented", () => {
    const parts = m("1.0000").allocate([1n, 1n, 1n], "HALF_AWAY_FROM_ZERO");
    expect(parts.map((p) => p.toString())).toEqual(["0.3334", "0.3333", "0.3333"]);
    expect(parts.reduce((a, b) => a.add(b), Money.zero(MYR)).toString()).toBe("1.0000");
    const weighted = m("100.0000").allocate([70n, 30n], "HALF_AWAY_FROM_ZERO");
    expect(weighted.map((p) => p.toString())).toEqual(["70.0000", "30.0000"]);
    const negative = m("-1.0000").allocate([1n, 1n, 1n], "HALF_AWAY_FROM_ZERO");
    expect(negative.map((p) => p.toString())).toEqual(["-0.3334", "-0.3333", "-0.3333"]);
    expect(negative.reduce((a, b) => a.add(b), Money.zero(MYR)).toString()).toBe("-1.0000");
    const zeroWeight = m("10.0000").allocate([0n, 1n], "HALF_AWAY_FROM_ZERO");
    expect(zeroWeight.map((p) => p.toString())).toEqual(["0.0000", "10.0000"]);
  });

  it("allocate refuses weights that cannot describe a split", () => {
    expect(() => m("1").allocate([], "HALF_EVEN")).toThrow(RangeError);
    expect(() => m("1").allocate([0n, 0n], "HALF_EVEN")).toThrow(RangeError);
    expect(() => m("1").allocate([-1n, 2n], "HALF_EVEN")).toThrow(RangeError);
  });

  it("comparison, sign predicates and abs behave on both sides of zero", () => {
    expect(m("1").compare(m("2"))).toBe(-1);
    expect(m("2").compare(m("2"))).toBe(0);
    expect(m("3").compare(m("2"))).toBe(1);
    expect(m("2").equals(m("2.0000"))).toBe(true);
    expect([m("0").isZero(), m("-1").isNegative(), m("1").isPositive()]).toEqual([
      true,
      true,
      true,
    ]);
    expect([m("0").isNegative(), m("0").isPositive()]).toEqual([false, false]);
    expect(m("-2.5").abs().toString()).toBe("2.5000");
    expect(m("-2.5").negate().toString()).toBe("2.5000");
  });

  it("the wire form is { amount, currency } and round-trips exactly (§4.2.8 MoneySchema)", () => {
    expect(m("1234.5").toJSON()).toEqual({ amount: "1234.5000", currency: "MYR" });
    expect(Money.fromJSON({ amount: "1234.5000", currency: "MYR" }).toString()).toBe("1234.5000");
    expect(() => Money.fromJSON({ amount: "1234.5", currency: "MYR" })).not.toThrow();
    expect(() => Money.fromJSON({ amount: "1.00000", currency: "MYR" })).toThrow(MoneyScaleError);
  });

  it("fromDecimal rounds explicitly — there is no implicit truncation anywhere", () => {
    expect(Money.fromDecimal(new Decimal("1.00005"), MYR, "HALF_AWAY_FROM_ZERO").toString()).toBe(
      "1.0001",
    );
    expect(Money.fromDecimal(new Decimal("1.00005"), MYR, "HALF_EVEN").toString()).toBe("1.0000");
  });

  it("there is no way from Money to number — the property the no-number-money lint relies on", () => {
    expect((Money.zero(MYR) as unknown as Record<string, unknown>)["toNumber"]).toBeUndefined();
    expect((Money.zero(MYR) as unknown as Record<string, unknown>)["valueOf"]).toBe(
      Object.prototype.valueOf,
    );
  });

  it("instances are frozen — a Money never changes after construction", () => {
    const a = m("1");
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.add(m("1")).toString()).toBe("2.0000");
    expect(a.toString()).toBe("1.0000");
  });
});
