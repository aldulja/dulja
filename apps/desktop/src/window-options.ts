import type { BrowserWindowConstructorOptions } from "electron";

export const APP_SCHEME = "dulja" as const;
export const APP_ORIGIN = `${APP_SCHEME}://app` as const;
/**
 * Where `backoffice.exe` opens: the origin's root. The protocol handler answers `/` and `/index.html` alike
 * with the shell, but the back office's router routes the PATH and has no `/index.html` route, so that URL
 * opened on "Not Found" instead of sign-in (found verifying PR 12). `tests/e2e/backoffice-csp.spec.ts` opens the
 * built bundle at this same path and requires sign-in. The till (`main-pos.ts`) has no router and keeps
 * `/index.html`.
 */
export const BACKOFFICE_START_PATH = "/" as const;

/**
 * spec:1284 "a strict Content-Security-Policy". `connect-src` admits https so the renderer can reach
 * the API. Nothing admits script beyond the app's own bundle, nothing admits eval, and — since the
 * 0E final review — nothing admits inline style either.
 *
 * `style-src` used to carry `'unsafe-inline'`, justified here as "Tailwind's runtime injects a style
 * element". Tailwind v4 through `@tailwindcss/vite` has no runtime: it is a build-time plugin, the
 * built renderer links one extracted stylesheet (`apps/backoffice/dist/index.html` contains no
 * `<style>` element at all), and neither `apps/backoffice/src` nor `packages/ui/src` writes a `style=`
 * attribute or a `style={{…}}` prop. The justification described nothing that happens, so the
 * exception went with it. `posture.spec.ts` holds the removal down from the other side: it asserts
 * the linked stylesheet is applied in the running renderer *and* that an injected `<style>` is not.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** spec:1284, verbatim: contextIsolation on, nodeIntegration off, sandbox on. */
export function browserWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    show: false, // shown on `ready-to-show`, so no white flash
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  };
}

/** The navigation lock (spec:1284 "renderer navigation locked to the app's own origin"). */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}` === APP_ORIGIN;
  } catch {
    return false;
  }
}
