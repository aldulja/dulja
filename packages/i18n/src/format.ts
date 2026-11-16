import type { Locale } from "./locale";

export type CalendarSystem = "gregory" | "islamic-umalqura";
export type NumberingSystem = "latn" | "arab";

export interface FormatContext {
  locale: Locale;
  /** Hijri display is a presentation concern via `Intl`; storage is always Gregorian (spec:2039). */
  calendar?: CalendarSystem;
  numberingSystem?: NumberingSystem;
  /** The company's timezone (spec:2039). Only `formatTimestamp` uses it; a `date` is zone-free by construction. */
  timeZone?: string;
}

/** The §4.2.8 wire shape of money. This package may not import `@dulja/domain` (§3.1), and must not: */
/** the amount stays a decimal string end to end, so no `number` ever holds it (spec:2041). */
export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

const DEFAULT_TIME_ZONE = "Asia/Kuala_Lumpur";
const DECIMAL = /^-?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function localeTag(ctx: FormatContext): string {
  const calendar = ctx.calendar ?? "gregory";
  const numberingSystem = ctx.numberingSystem ?? "latn";
  return `${ctx.locale}-u-ca-${calendar}-nu-${numberingSystem}`;
}

function assertDecimal(fn: string, field: string, value: string): void {
  if (!DECIMAL.test(value)) {
    throw new TypeError(`${fn}: ${field} must be a plain decimal string, received "${value}"`);
  }
}

/**
 * A `date` column (spec:2039 — "`effective_date` is a `date`, entered by the user"). It is a calendar
 * day, not an instant, so it is always rendered in UTC: rendering `2026-01-01` in a western zone would
 * otherwise print 31 December 2025 and silently move an accounting date into the previous period.
 *
 * **House date policy (0E's to set — spec:2061, spec:2253).** A rendered date is always one of `Intl`'s
 * three `dateStyle` values — `short` | `medium` | `long`, default `medium` — and never a hand-assembled
 * set of component options. The two are not interchangeable: `dateStyle: "medium"` gives `Jan 5, 2026`
 * for a single-digit day, whereas `{ day: "2-digit", month: "short", year: "numeric" }` gives
 * `Jan 05, 2026`, and they agree only from the 10th of the month onward. Any slice that builds its own
 * `Intl.DateTimeFormat` over a value this package also formats must use `dateStyle` so the two paths
 * cannot print the same date two ways.
 */
export function formatDate(
  isoDate: string,
  ctx: FormatContext,
  style: "short" | "medium" | "long" = "medium",
): string {
  if (!ISO_DATE.test(isoDate)) {
    throw new TypeError(`formatDate: expected YYYY-MM-DD, received "${isoDate}"`);
  }
  const at = new Date(`${isoDate}T00:00:00Z`);
  // Date silently rolls impossible days into the next month. Round-trip before formatting so an
  // accounting date cannot turn into a different day. i18n may not import the domain package (§3.1).
  if (
    Number.isNaN(at.getTime()) ||
    at.getUTCFullYear() < 1 ||
    at.toISOString().slice(0, 10) !== isoDate
  ) {
    throw new TypeError(`formatDate: expected a real calendar date, received "${isoDate}"`);
  }
  return new Intl.DateTimeFormat(localeTag(ctx), { dateStyle: style, timeZone: "UTC" }).format(at);
}

/** A `timestamptz` (spec:2039 — stored UTC, displayed in the company's timezone). */
export function formatTimestamp(iso: string, ctx: FormatContext): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    throw new TypeError(`formatTimestamp: expected an RFC 3339 timestamp, received "${iso}"`);
  }
  return new Intl.DateTimeFormat(localeTag(ctx), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: ctx.timeZone ?? DEFAULT_TIME_ZONE,
  }).format(at);
}

export function formatNumber(
  decimal: string,
  ctx: FormatContext,
  opts: { minimumFractionDigits?: number; maximumFractionDigits?: number } = {},
): string {
  assertDecimal("formatNumber", "value", decimal);
  // Intl.NumberFormat#format accepts a decimal string and formats it exactly (Intl.NumberFormat V3).
  // Passing the string — never Number(string) — is what keeps this off the float path.
  return new Intl.NumberFormat(localeTag(ctx), {
    minimumFractionDigits: opts.minimumFractionDigits ?? 0,
    maximumFractionDigits: opts.maximumFractionDigits ?? 20,
  }).format(decimal as unknown as number);
}

/** Quantities are `numeric(19,6)` (spec:2043) and are shown at their full scale. */
export function formatQuantity(decimal: string, ctx: FormatContext): string {
  assertDecimal("formatQuantity", "value", decimal);
  return new Intl.NumberFormat(localeTag(ctx), {
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
    useGrouping: false,
  }).format(decimal as unknown as number);
}

/**
 * Display rounding applies the currency's policy at render time (spec:2041). `minorUnits` comes from
 * `app.currency.minor_units` (§4.2.10) and is supplied by the caller — this package holds no currency table.
 */
export function formatMoney(
  value: MoneyJson,
  ctx: FormatContext,
  opts: { minorUnits?: number } = {},
): string {
  assertDecimal("formatMoney", "amount", value.amount);
  const digits = opts.minorUnits ?? 2;
  return new Intl.NumberFormat(localeTag(ctx), {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value.amount as unknown as number);
}
