import { describe, expect, it } from "vitest";
import {
  currency,
  Money,
  MoneyCurrencyMismatchError,
  toBase,
  UNIT_RATE,
  type ExchangeRate,
} from "../src/index";

const MYR = currency("MYR");
const USD = currency("USD");
const usdMyr: ExchangeRate = {
  from: USD,
  to: MYR,
  rate: "4.68000000",
  effectiveFrom: "2026-09-04",
  source: "BNM 2026-09-04",
};

describe("toBase() — base = round(value × rate, 4), HALF_AWAY_FROM_ZERO (spec §3.8 ledger CHECK)", () => {
  it("converts into the rate's `to` currency", () => {
    const base = toBase(Money.of("100.0000", USD), usdMyr);
    expect(base.toJSON()).toEqual({ amount: "468.0000", currency: "MYR" });
  });

  it("rounds half away from zero, symmetrically — the mode the ledger CHECK uses", () => {
    const rate: ExchangeRate = { ...usdMyr, rate: "1.00005000" };
    expect(toBase(Money.of("1.0001", USD), rate).toString()).toBe("1.0002");
    expect(toBase(Money.of("-1.0001", USD), rate).toString()).toBe("-1.0002");
  });

  it("refuses a value whose currency is not the rate's `from`", () => {
    expect(() => toBase(Money.of("1.0000", MYR), usdMyr)).toThrow(MoneyCurrencyMismatchError);
    try {
      toBase(Money.of("1.0000", MYR), usdMyr);
    } catch (e) {
      expect((e as MoneyCurrencyMismatchError).code).toBe("ERR_MONEY_CURRENCY_MISMATCH");
    }
  });

  it("UNIT_RATE is the identity: rate 1, source 'unit', from === to", () => {
    const unit = UNIT_RATE(MYR);
    expect(unit).toEqual({
      from: MYR,
      to: MYR,
      rate: "1.00000000",
      effectiveFrom: "0001-01-01",
      source: "unit",
    });
    expect(toBase(Money.of("1234.5678", MYR), unit).toString()).toBe("1234.5678");
  });

  it("a rate is rejected unless it is a positive value at exactly 8 decimal places (§4.2.8 RateSchema)", () => {
    for (const bad of ["4.68", "0.00000000", "-1.00000000", "4.680000000", "abc"]) {
      expect(() => toBase(Money.of("1.0000", USD), { ...usdMyr, rate: bad }), bad).toThrow(
        RangeError,
      );
    }
  });

  it("accepts numeric(19,8)'s 11-digit integral boundary and rejects a twelfth digit", () => {
    expect(
      toBase(Money.of("1.0000", USD), { ...usdMyr, rate: "99999999999.99999999" }).toString(),
    ).toBe("100000000000.0000");
    expect(() =>
      toBase(Money.of("1.0000", USD), { ...usdMyr, rate: "100000000000.00000000" }),
    ).toThrow(RangeError);
  });
});
