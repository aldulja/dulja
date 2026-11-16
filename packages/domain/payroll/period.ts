import { isCalendarDate } from "../src/index";
import type { PayPeriod } from "./types";

const MS_PER_DAY = 86_400_000;
const SUNDAY = 0;
const SATURDAY = 6;

/**
 * A `YYYY-MM-DD` date as UTC midnight. ECMA-262 parses the date-only form as UTC, which is what we want: these are
 * `date` columns and carry no zone (§3.2). An impossible date is refused rather than rolled over (V8 reads
 * `2026-02-30` as 2 March), through the one calendar check the package has.
 */
function day(iso: string): number {
  if (!isCalendarDate(iso)) throw new RangeError(`'${iso}' is not a YYYY-MM-DD calendar date`);
  return Date.parse(iso);
}

/** Every day of the period the rule counts, inclusive of both ends. An inverted period is refused. */
export function periodDays(period: PayPeriod): number {
  const start = day(period.start);
  const end = day(period.end);
  if (end < start) {
    throw new RangeError(`pay period ${period.start}..${period.end} ends before it starts`);
  }
  return countDays(period, start, end);
}

/**
 * The days of `[start, end]` the employee was employed for, inclusive on both sides. `hiredOn` after the period
 * end, or `terminatedOn` before the period start, is zero — never negative.
 */
export function eligibleDays(
  period: PayPeriod,
  hiredOn: string,
  terminatedOn: string | null,
): number {
  const from = Math.max(day(period.start), day(hiredOn));
  const to = Math.min(day(period.end), terminatedOn === null ? day(period.end) : day(terminatedOn));
  if (to < from) return 0;
  return countDays(period, from, to);
}

/**
 * `calendar_days` counts every day; `working_days` counts Monday–Friday.
 *
 * **Public holidays are NOT subtracted.** `app.public_holiday` is 8D's table (§4.6.1); more to the point, whether a
 * holiday reduces a working-day denominator is a question for the accountant, which is ⚠️ OD-28 (8B Task 7,
 * `docs/owner/od-28-proration-rule.md`). The rule shipped is configuration, never a statutory claim (spec:2086).
 */
function countDays(period: PayPeriod, from: number, to: number): number {
  // Both ends are UTC midnights, so the difference is an exact multiple of a day.
  if (period.prorationRule === "calendar_days") return (to - from) / MS_PER_DAY + 1;
  let n = 0;
  for (let t = from; t <= to; t += MS_PER_DAY) {
    const dow = new Date(t).getUTCDay();
    if (dow !== SUNDAY && dow !== SATURDAY) n += 1;
  }
  return n;
}
