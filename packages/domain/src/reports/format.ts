import type { ReportLang } from "./codes";

/** The five formatting operations `renderReport` needs. Injected, so the numeral and calendar policy stays
 *  0E's (`@dulja/i18n`'s `FormatContext`) and is re-decided nowhere in the layout (7A Task 8). */
export interface ReportFormatters {
  date(isoDate: string): string;
  number(
    decimal: string,
    opts?: { minimumFractionDigits?: number; maximumFractionDigits?: number },
  ): string;
  money(value: { amount: string; currency: string }): string;
  quantity(decimal: string): string;
  percent(decimal: string): string;
}

export interface IntlFormatterOptions {
  /** Default: `gregory` for `en`, `islamic-umalqura` for `ar`. */
  calendar?: "gregory" | "islamic-umalqura";
  /** Default: `latn` for both — 0E's `FormatContext` default. */
  numberingSystem?: "latn" | "arab";
  /** Part of the interface 7B consumes, and read by none of the five formats: a `date` column is a calendar
   *  date, not an instant, so no zone may move its day (see `dateFormat` below). An instant format added
   *  later reads it, defaulting to `Asia/Kuala_Lumpur` (spec:2039). */
  timeZone?: string;
  /** The company's base currency, for a money cell whose row names none. */
  currency?: string;
}

/** A decimal string as `Intl.NumberFormat` accepts it (ES2023): formatted exactly, with no `Number()`
 *  conversion, so no amount ever passes through a float (spec:2041). */
const decimalLiteral = (decimal: string): Intl.StringNumericLiteral =>
  decimal as Intl.StringNumericLiteral;

/**
 * `Intl` only. `packages/domain` imports nothing internal (§3.1), so it cannot reach `@dulja/i18n`; this
 * implementation exists so the layout tests need no dependency, and the worker replaces it with an adapter
 * over 0E's `formatDate` / `formatNumber` / `formatMoney` / `formatQuantity` (Task 10). The numeral system and
 * the Hijri calendar are 0E's `FormatContext` policy and are not re-decided here.
 */
export function intlFormatters(
  lang: ReportLang,
  opts: IntlFormatterOptions = {},
): ReportFormatters {
  const calendar = opts.calendar ?? (lang === "ar" ? "islamic-umalqura" : "gregory");
  const numberingSystem = opts.numberingSystem ?? "latn";
  const tag = `${lang}-u-ca-${calendar}-nu-${numberingSystem}`;

  // A date column is a `date` (spec:2039's `effective_date`), not an instant. It is built at UTC midnight
  // and formatted in UTC, so the display zone can never move its calendar day: a fixed "noon UTC" read in the
  // display zone still shifts the day in a zone beyond ±12:00 (Pacific/Kiritimati is +14:00).
  const dateFormat = new Intl.DateTimeFormat(tag, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const quantityFormat = new Intl.NumberFormat(tag, {
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
    useGrouping: false,
  });
  const percentFormat = new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 4 });

  return {
    date(isoDate) {
      return dateFormat.format(new Date(`${isoDate}T00:00:00Z`));
    },
    number(decimal, o) {
      return new Intl.NumberFormat(tag, {
        minimumFractionDigits: o?.minimumFractionDigits ?? 0,
        maximumFractionDigits: o?.maximumFractionDigits ?? 6,
      }).format(decimalLiteral(decimal));
    },
    money(value) {
      const currency = value.currency || opts.currency || "XXX";
      return new Intl.NumberFormat(tag, {
        style: "currency",
        currency,
        currencyDisplay: "code",
      }).format(decimalLiteral(value.amount));
    },
    quantity(decimal) {
      return quantityFormat.format(decimalLiteral(decimal));
    },
    percent(decimal) {
      return percentFormat.format(decimalLiteral(decimal));
    },
  };
}
