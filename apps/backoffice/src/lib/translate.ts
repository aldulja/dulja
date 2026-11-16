import type { TranslationKey } from "@dulja/i18n";

/**
 * The translator every renderer in this app takes. It lives in its own module so the i18n layer and
 * the error layer can both depend on it without either depending on the other.
 *
 * `TranslationKey` makes a typo a compile error rather than a raw dotted key on screen: `createI18n`
 * sets `fallbackLng: false`, so there is no second chance at runtime.
 */
export type Translate = (key: TranslationKey, vars?: Record<string, unknown>) => string;
