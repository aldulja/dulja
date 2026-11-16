import { D } from "./decimal";
import { Money, MoneyCurrencyMismatchError, type CurrencyCode } from "./money";
import { MONEY_SCALE, RATE_SCALE, round } from "./rounding";

/** A rate quoted as 1 unit of `from` = `rate` units of `to`; `rate` has RATE_SCALE decimal places. */
export interface ExchangeRate {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  readonly rate: string;
  readonly effectiveFrom: string;
  readonly source: string;
}

const RATE = /^\d+\.\d{8}$/;
const MAX_RATE = new D("99999999999.99999999");

/**
 * base = round(value × rate, 4) — HALF_AWAY_FROM_ZERO, matching the Postgres numeric round() used by the
 * ledger_entry base amount checks (spec §3.8).
 */
export function toBase(value: Money, rate: ExchangeRate): Money {
  if (!RATE.test(rate.rate)) {
    throw new RangeError(`toBase(): rate '${rate.rate}' is not numeric(19,${RATE_SCALE})`);
  }
  const decimal = new D(rate.rate);
  if (!decimal.isPositive() || decimal.isZero() || decimal.greaterThan(MAX_RATE)) {
    throw new RangeError(`toBase(): rate '${rate.rate}' is outside numeric(19,${RATE_SCALE})`);
  }
  if ((value.currency as string) !== (rate.from as string)) {
    throw new MoneyCurrencyMismatchError(value.currency as string, rate.from as string);
  }
  return Money.fromDecimal(
    round(value.toDecimal().times(decimal), MONEY_SCALE, "HALF_AWAY_FROM_ZERO"),
    rate.to,
    "HALF_AWAY_FROM_ZERO",
  );
}

/** The identity rate used when from and to are the same currency (§4.2.10). */
export const UNIT_RATE = (c: CurrencyCode): ExchangeRate => ({
  from: c,
  to: c,
  rate: "1.00000000",
  effectiveFrom: "0001-01-01",
  source: "unit",
});
