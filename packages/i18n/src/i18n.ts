import ICU from "i18next-icu";
import i18next, { type i18n } from "i18next";
import ar from "../catalogues/ar.json" with { type: "json" };
import en from "../catalogues/en.json" with { type: "json" };
import { DEFAULT_LOCALE, LOCALES, type Locale } from "./locale";

export type Catalogue = Readonly<Record<string, string>>;

/** The shipped catalogues. The completeness checker (src/completeness.ts) runs over exactly this object. */
export const CATALOGUES: Readonly<Record<Locale, Catalogue>> = { en, ar };

/** Every key the application may ask for. A typo is a compile error, not a fallback string. */
export type TranslationKey = keyof typeof en;

export interface CreateI18nOptions {
  locale?: Locale;
  /** Test seam: swap the catalogues without touching the shipped files. */
  catalogues?: Readonly<Record<Locale, Catalogue>>;
}

/**
 * An initialised i18next instance with the ICU message format (spec:2061 "an ICU message").
 * `keySeparator` and `nsSeparator` are false: keys are flat dotted literals (ADR 0018), so
 * "admin.users.title" is one key and can never be mistaken for a nested lookup.
 */
export async function createI18n(opts: CreateI18nOptions = {}): Promise<i18n> {
  const catalogues = opts.catalogues ?? CATALOGUES;
  const instance = i18next.createInstance();
  await instance.use(ICU).init({
    lng: opts.locale ?? DEFAULT_LOCALE,
    supportedLngs: [...LOCALES],
    fallbackLng: false, // LEGACY-085: a missing Arabic string must show as missing, never as English
    returnNull: false,
    resources: Object.fromEntries(
      LOCALES.map((locale) => [locale, { translation: catalogues[locale] }]),
    ),
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false }, // React escapes; double-escaping mangles Arabic punctuation
  });
  return instance;
}
