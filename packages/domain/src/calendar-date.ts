const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * True when `value` is a real calendar date written `YYYY-MM-DD`: a month 01–12 and a day that exists in that
 * month of that year, under the Gregorian leap rule. Pure string and integer work with no `Date`, so no
 * timezone can move a value date (§3.2 — an accounting date is a `date`, never derived from a timestamp).
 *
 * The ONE definition, because the shape alone is not enough and the failure is silent: postgres.js
 * serialises a `date` parameter through `new Date(x)`, and V8 rolls an impossible day over, so `2026-02-30`
 * reached the database as 2026-03-02 and a reversal or a receipt landed in a period nobody asked for.
 * `DateSchema` (@dulja/contracts) refines with it, and every input that is not a zod schema — a worker
 * payload, a CSV cell — calls it directly.
 */
export function isCalendarDate(value: string): boolean {
  const parts = ISO_DATE.exec(value);
  if (!parts) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  // PostgreSQL has no year zero; accepting it here only defers a validation error to a date column.
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= (month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]!);
}
