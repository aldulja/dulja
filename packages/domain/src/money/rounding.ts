import Decimal from "decimal.js";
import { D } from "./decimal";

/** SQL column scales (spec §3.9). Money 4, rates 8, quantities 6. */
export const MONEY_SCALE = 4;
export const RATE_SCALE = 8;
export const QUANTITY_SCALE = 6;

/**
 * The one rounding function (spec §4.6 "one function, explicit mode, symmetric across sign"; SAH-019).
 * Every mode here is symmetric across sign — there is deliberately no CEIL/FLOOR, because an asymmetric
 * mode applied to a signed money value is the SAH-019 defect ("configured everywhere, applied nowhere,
 * and the one rounding function is wrong").
 */
export type RoundingMode = "HALF_AWAY_FROM_ZERO" | "HALF_EVEN" | "TOWARD_ZERO" | "AWAY_FROM_ZERO";

const MODES: Record<RoundingMode, Decimal.Rounding> = {
  HALF_AWAY_FROM_ZERO: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  TOWARD_ZERO: Decimal.ROUND_DOWN,
  AWAY_FROM_ZERO: Decimal.ROUND_UP,
};

export function round(value: Decimal, scale: number, mode: RoundingMode): Decimal {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new RangeError(`round(): scale must be a non-negative integer, got ${scale}`);
  }
  return new D(value).toDecimalPlaces(scale, MODES[mode]);
}
