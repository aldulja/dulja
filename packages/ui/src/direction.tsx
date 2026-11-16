import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { dirFor, type Dir, type Locale } from "@dulja/i18n";

export interface DirectionValue {
  locale: Locale;
  dir: Dir;
}

const DirectionContext = createContext<DirectionValue | null>(null);

export interface DirectionProviderProps {
  locale: Locale;
  children: ReactNode;
  /** Test seam: the document whose root receives `lang`/`dir`. Defaults to the ambient one. */
  target?: Document;
}

/**
 * The one place `dir` is decided (spec:2253). Nothing reads `navigator.language` and nothing infers
 * direction from content — the locale decides, and the document root carries it so CSS logical
 * properties resolve for every descendant, including portalled dialogs.
 */
export function DirectionProvider({ locale, children, target }: DirectionProviderProps) {
  const value = useMemo<DirectionValue>(() => ({ locale, dir: dirFor(locale) }), [locale]);
  useEffect(() => {
    const root = (target ?? globalThis.document)?.documentElement;
    if (!root) return;
    root.setAttribute("lang", locale);
    root.setAttribute("dir", value.dir);
  }, [locale, target, value.dir]);
  return <DirectionContext.Provider value={value}>{children}</DirectionContext.Provider>;
}

export function useDirection(): DirectionValue {
  const value = useContext(DirectionContext);
  if (value === null) throw new Error("useDirection must be used inside <DirectionProvider>");
  return value;
}
