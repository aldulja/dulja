/** The two locales of v1 (spec:1131 "Arabic and English at parity, both directions"). */
export type Locale = "en" | "ar";
export type Dir = "ltr" | "rtl";

export const LOCALES = ["en", "ar"] as const satisfies readonly Locale[];
export const DEFAULT_LOCALE: Locale = "en";

const DIR_BY_LOCALE: Readonly<Record<Locale, Dir>> = { en: "ltr", ar: "rtl" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The `dir` attribute the document root carries for this locale. Never inferred from content. */
export function dirFor(locale: Locale): Dir {
  return DIR_BY_LOCALE[locale];
}
