import { CATALOGUES } from "./i18n";
import { LOCALES, type Locale } from "./locale";

export interface CatalogueViolation {
  locale: Locale | "*";
  key: string;
  rule: string;
  detail: string;
}

export const CATALOGUE_RULES = [
  "missing_key",
  "empty_value",
  "trailing_whitespace",
  "source_language_fallback",
  "wrong_script",
  "component_name_leak",
  "mixed_numerals",
] as const;

/** Keys whose value is deliberately in another script: each language names itself (ADR 0018). */
const EXEMPT_PREFIXES = ["app.endonym."];
const ARABIC = /[؀-ۿݐ-ݿ]/;
const LATIN_WORD = /[A-Za-z]{2,}/;
/**
 * Arabic-Indic and extended Arabic-Indic digits. Every figure the apps format is Western (`localeTag`'s
 * `nu-latn` default, which no screen overrides), so a digit typed into a catalogue in either set puts a second
 * numbering system on the screen beside them — acceptance test 23's "never two systems at once". The till's
 * `pos.shortcuts` and two 6C staff hints shipped that way (2026-10-23).
 */
const NON_WESTERN_DIGIT = /[\u0660-\u0669\u06F0-\u06F9]/;
/** A raw identifier shipped as UI text — the "TBXToolbar3" shape of SAH-085. */
const COMPONENT_NAME = /^[A-Z][A-Za-z]*\d+$/;

const exempt = (key: string): boolean => EXEMPT_PREFIXES.some((p) => key.startsWith(p));

/**
 * The mechanical half of spec:2061 — "Both catalogues must be complete before merge — no empty
 * `msgstr`, no source-language fallbacks in the other language (SAH-085)". Every rule below names a
 * concrete failure the legacy build shipped.
 */
export function checkCatalogues(
  catalogues: Readonly<Record<Locale, Readonly<Record<string, string>>>> = CATALOGUES,
): CatalogueViolation[] {
  const out: CatalogueViolation[] = [];
  const keys = [...new Set(LOCALES.flatMap((l) => Object.keys(catalogues[l] ?? {})))].toSorted();

  for (const key of keys) {
    for (const locale of LOCALES) {
      const value = catalogues[locale]?.[key];
      if (value === undefined) {
        out.push({
          locale,
          key,
          rule: "missing_key",
          detail: `the ${locale} catalogue has no entry for this key`,
        });
        continue;
      }
      if (value.trim() === "") {
        out.push({ locale, key, rule: "empty_value", detail: "value is empty or whitespace only" });
        continue;
      }
      if (value !== value.trim()) {
        out.push({
          locale,
          key,
          rule: "trailing_whitespace",
          detail: `value is "${value}" — trim it`,
        });
      }
      if (exempt(key)) continue;
      if (COMPONENT_NAME.test(value.trim())) {
        out.push({
          locale,
          key,
          rule: "component_name_leak",
          detail: `"${value}" looks like a component name, not a sentence`,
        });
      }
      if (NON_WESTERN_DIGIT.test(value)) {
        out.push({
          locale,
          key,
          rule: "mixed_numerals",
          detail: `"${value}" writes a digit in Arabic-Indic numerals; every formatted figure is Western`,
        });
      }
      if (locale === "en" && ARABIC.test(value)) {
        out.push({
          locale,
          key,
          rule: "wrong_script",
          detail: "an English value contains Arabic characters",
        });
      }
      if (locale === "ar" && !ARABIC.test(value) && LATIN_WORD.test(value)) {
        out.push({
          locale,
          key,
          rule: "wrong_script",
          detail: "an Arabic value contains no Arabic characters",
        });
      }
    }

    if (exempt(key)) continue;
    const en = catalogues.en?.[key];
    const ar = catalogues.ar?.[key];
    if (en !== undefined && ar !== undefined && en === ar && LATIN_WORD.test(en)) {
      out.push({
        locale: "ar",
        key,
        rule: "source_language_fallback",
        detail: `the Arabic value is the English one verbatim: "${en}"`,
      });
    }
  }
  return out;
}
