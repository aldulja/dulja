import { D } from "./decimal";
import { Money, type CurrencyCode } from "./money";
import { round, type RoundingMode } from "./rounding";

/** Round an amount to a positive money-scale increment without rounding the quotient early. */
export function roundToIncrement<C extends CurrencyCode>(
  value: Money<C>,
  increment: string,
  mode: RoundingMode = "HALF_AWAY_FROM_ZERO",
): Money<C> {
  // Money validates decimal syntax and scale before Decimal parses the increment.
  const step = new D(Money.of(increment, value.currency).toString());
  if (!step.isPositive() || step.isZero())
    throw new RangeError("Rounding increment must be positive");
  const quotient = new D(value.toString()).dividedBy(step);
  return Money.fromDecimal(round(quotient, 0, mode).times(step), value.currency, mode);
}
