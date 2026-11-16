import type { ReportFormatters, ReportLang } from "@dulja/domain";
import {
  formatDate,
  formatMoney,
  formatNumber,
  formatQuantity,
  type FormatContext,
} from "@dulja/i18n";

/**
 * The production `ReportFormatters`. `packages/domain`'s `intlFormatters` exists so the layout tests need no
 * dependency; THIS is what a rendered report uses, so the numeral system, the date style and the money
 * policy are 0E's `@dulja/i18n` functions and are not re-decided in this slice (spec:2061, spec:2253). The
 * calendar per language is the one `intlFormatters` already defaults to (Hijri for `ar`, Gregorian for
 * `en`), so a report does not change shape when it moves from the layout tests to the worker.
 */
export function i18nFormatters(
  lang: ReportLang,
  opts: { currency?: string; timeZone?: string } = {},
): ReportFormatters {
  const ctx: FormatContext = {
    locale: lang,
    calendar: lang === "ar" ? "islamic-umalqura" : "gregory",
    numberingSystem: "latn",
    timeZone: opts.timeZone ?? "Asia/Kuala_Lumpur",
  };
  return {
    date: (iso) => formatDate(iso, ctx, "medium"),
    number: (decimal, o) => formatNumber(decimal, ctx, o),
    money: (value) =>
      formatMoney(
        { amount: value.amount, currency: value.currency || opts.currency || "XXX" },
        ctx,
      ),
    quantity: (decimal) => formatQuantity(decimal, ctx),
    // @dulja/i18n has no percent formatter; a percent column holds a RATIO, shown as a plain number with a
    // suffix, and the ratio-to-per-cent multiplication is a decimal-point shift so no float touches it.
    percent: (decimal) => `${formatNumber(shiftTwo(decimal), ctx, { maximumFractionDigits: 4 })}%`,
  };
}

/** Multiplies a plain decimal string by 100 by moving the point — no `Number()`, no `Decimal` needed. */
export function shiftTwo(decimal: string): string {
  const negative = decimal.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? decimal.slice(1) : decimal).split(".");
  const digits = `${whole}${fraction.padEnd(2, "0").slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  const rest = fraction.slice(2);
  return `${negative ? "-" : ""}${digits}${rest === "" ? "" : `.${rest}`}`;
}
