import { isAppUrl } from "./window-options";

/**
 * Hosts the app may hand to the OS browser via `shell.openExternal`. Empty by design — default-deny,
 * not a gap:
 * - We cannot write a correct allowlist yet. The production domain is owner decision OD-20, which
 *   has not landed. An allowlist containing a guessed domain would be worse than none, because it
 *   would look authoritative and be wrong.
 * - The app currently has no feature that needs to open an external link. Default-deny costs nothing
 *   today.
 * - The threat is real but bounded: a compromised renderer cannot execute code this way, but it can
 *   make the OS open an arbitrary site in the user's browser, which is a plausible phishing step.
 *   Scheme-gating already blocks `file:` and the `ms-*` handler classes; this closes the remaining
 *   half.
 * - When OD-20 lands, adding the real host is one line, and the refusal log (`main.ts`'s
 *   `logRendererFault`) will have already told us if anything legitimately needed it.
 */
export const EXTERNAL_HOST_ALLOWLIST: readonly string[] = [];

export type NavigationVerdict =
  /** The app's own origin — let the navigation proceed. */
  | { readonly kind: "app" }
  /** An `https:` URL whose host is on the allowlist — hand it to the OS browser. */
  | { readonly kind: "open-external" }
  /** Everything else — block it, and it never reaches `shell.openExternal`. */
  | { readonly kind: "refuse" };

/**
 * The navigation lock's decision, spec:1284 — kept pure and free of any `electron` import so it's
 * unit-testable without launching Electron (`main.ts`'s `guardNavigation` and its `setWindowOpenHandler`
 * are the only callers, and do the actual `event.preventDefault()`/`shell.openExternal` I/O).
 */
export function decideNavigation(
  url: string,
  allowlist: readonly string[] = EXTERNAL_HOST_ALLOWLIST,
): NavigationVerdict {
  if (isAppUrl(url)) return { kind: "app" };
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && allowlist.includes(parsed.host)) {
      return { kind: "open-external" };
    }
  } catch {
    // An unparseable URL is refused, same as any other non-app, non-allowlisted one.
  }
  return { kind: "refuse" };
}
