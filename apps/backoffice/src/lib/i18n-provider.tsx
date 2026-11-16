import { createI18n, isLocale, type Locale } from "@dulja/i18n";
import { DirectionProvider } from "@dulja/ui";
import type { i18n as I18n } from "i18next";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Translate } from "./translate";

export interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

/**
 * Where the chosen locale survives a reload. Synchronous and tiny on purpose: the provider needs an
 * answer before its first paint, or the shell renders English and flips a frame later.
 */
export interface LocaleStore {
  read(): Locale | null;
  write(locale: Locale): void;
}

const STORAGE_KEY = "dulja.locale";

/**
 * `localStorage`, which the packaged app has because it is served from the `dulja://app` origin
 * rather than `file://`. A private window, or a profile with site data blocked, throws on the
 * property access itself — that is caught by the provider rather than here, so the guarantee covers
 * every injected store and not just this one. The locale is not a secret, so unlike the refresh
 * token it needs no Electron-side store.
 */
export const browserLocaleStore: LocaleStore = {
  read() {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    return isLocale(raw) ? raw : null;
  },
  write(locale) {
    globalThis.localStorage.setItem(STORAGE_KEY, locale);
  },
};

/**
 * Reading and writing the preference are the two places a store can take the app down with it, so
 * both are guarded here, at the seam, rather than inside one implementation of it. A locale
 * preference is never worth a blank screen, and Task 11 may yet inject a bridge-backed store whose
 * failure modes nothing in this file can anticipate.
 *
 * The read is validated as well as caught, because a foreign store is likelier to *return* something
 * wrong than to throw: a value corrupted in storage, a string persisted by an older build, another
 * key namespace. `LocaleStore.read` promises a `Locale`, but that promise is only a type — an
 * unchecked one would reach `createI18n` and `dirFor`, and `dirFor` answers `undefined` for anything
 * outside {en, ar}, which is an unpredictable `dir` attribute rather than a clean fallback. Anything
 * that is not a `Locale` is treated exactly as no preference at all.
 */
const readLocale = (store: LocaleStore): Locale | null => {
  try {
    const stored: unknown = store.read();
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
};

const writeLocale = (store: LocaleStore, locale: Locale): void => {
  try {
    store.write(locale);
  } catch {
    // A preference that cannot be remembered is not an error worth surfacing.
  }
};

const I18nContext = createContext<I18nValue | null>(null);

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error("useI18n must be used inside <I18nProvider>");
  return value;
}

export interface I18nProviderProps {
  children: ReactNode;
  /** Test seam; otherwise the stored preference, otherwise English. */
  initialLocale?: Locale;
  store?: LocaleStore;
}

/**
 * Translation and direction, with no chrome attached. Split out of `AppShell` because Task 6's login
 * screen is unauthenticated: inside the shell it would inherit a header and a "Users and roles" link
 * before anyone has signed in, and outside it there would be no `t` at all. `DirectionProvider` lives
 * here rather than in the shell for the same reason — an Arabic login screen has to be right-to-left.
 */
export function I18nProvider({
  children,
  initialLocale,
  store = browserLocaleStore,
}: I18nProviderProps) {
  // Read once, through a lazy initialiser, so the store is not touched on every render and so the
  // value is stable enough to be an honest dependency of the creation effect below.
  const [bootLocale] = useState<Locale>(() => initialLocale ?? readLocale(store) ?? "en");
  const [locale, setLocaleState] = useState<Locale>(bootLocale);
  const [language, setLanguage] = useState<Locale>(bootLocale); // what i18next has actually applied
  const [i18n, setI18n] = useState<I18n | null>(null);

  // Built at the stored locale, not at English-then-corrected: the second effect would otherwise
  // paint one frame of English chrome at LTR before flipping.
  useEffect(() => {
    let cancelled = false;
    void createI18n({ locale: bootLocale }).then((instance) => {
      if (cancelled) return;
      setI18n(instance);
      setLanguage(bootLocale);
    });
    return () => {
      cancelled = true;
    };
  }, [bootLocale]);

  /**
   * `changeLanguage` is a **promise** and fires no React update. Without recording its completion in
   * state, the switch re-renders once with `i18n.language` still the old value, commits the old
   * catalogue's strings, and then nothing re-renders when the promise settles — the chrome stays
   * English forever while `dir` flips. `language` is that record; do not "simplify" it away.
   */
  useEffect(() => {
    if (i18n === null) return;
    let live = true;
    void i18n.changeLanguage(locale).then(() => {
      if (live) setLanguage(locale);
    });
    return () => {
      live = false;
    };
  }, [i18n, locale]);

  /** The tab's own name is user-facing too, and `index.html` ships a placeholder `<title>`. */
  useEffect(() => {
    if (i18n === null) return;
    const target = globalThis.document as Document | undefined;
    if (target) target.title = i18n.getFixedT(language)("app.name");
  }, [i18n, language]);

  if (i18n === null) return null;
  // `getFixedT(language)` makes the applied language an explicit input of every lookup, so React's
  // dependency on it is real rather than incidental.
  const fixedT = i18n.getFixedT(language);
  const t: Translate = (key, vars) => fixedT(key, vars ?? {}) as string;
  const setLocale = (next: Locale) => {
    writeLocale(store, next);
    setLocaleState(next);
  };

  return (
    // `locale` is what the switcher shows; `language` is what is rendered. Direction follows
    // `language` so that `dir`, `lang` and every string flip in one commit — which is exactly what
    // `shell.test.tsx` and acceptance test 23 assert.
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      <DirectionProvider locale={language}>{children}</DirectionProvider>
    </I18nContext.Provider>
  );
}
