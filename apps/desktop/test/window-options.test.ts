import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  BACKOFFICE_START_PATH,
  browserWindowOptions,
  CONTENT_SECURITY_POLICY,
  isAppUrl,
} from "../src/window-options";

describe("browserWindowOptions — spec:1284, verbatim and not optional", () => {
  const options = browserWindowOptions("/app/preload.js");

  it("isolates the context", () => expect(options.webPreferences?.contextIsolation).toBe(true));
  it("disables node integration", () =>
    expect(options.webPreferences?.nodeIntegration).toBe(false));
  it("sandboxes the renderer", () => expect(options.webPreferences?.sandbox).toBe(true));
  it("keeps web security on", () => expect(options.webPreferences?.webSecurity).toBe(true));
  it("disables remote content bridges", () => {
    expect(options.webPreferences?.webviewTag).toBe(false);
    expect(options.webPreferences?.nodeIntegrationInSubFrames).toBe(false);
  });
  it("points at exactly one preload script", () =>
    expect(options.webPreferences?.preload).toBe("/app/preload.js"));
  it("does not show the window before it has painted", () => expect(options.show).toBe(false));
});

/**
 * Directive-wise, never against the whole string. This was written when `style-src` still carried
 * `'unsafe-inline'`: the policy is one line, so a negative lookahead like
 * `/script-src 'self'(?!.*unsafe-inline)/` saw style-src's token from script-src's only candidate
 * position and never matched — it failed on a policy that was in fact correct. No directive carries
 * `'unsafe-inline'` any more (0E final review), so that specific trap is gone; the per-directive shape
 * stays because it is what keeps these assertions honest if one is ever added back.
 */
const directive = (name: string): string | undefined =>
  CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith(`${name} `) || d === name);

describe("CONTENT_SECURITY_POLICY", () => {
  it("permits no eval and no inline script", () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(directive("script-src")).toBe("script-src 'self'");
  });
  it("permits no inline style either — nothing in the renderer injects one", () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    expect(directive("style-src")).toBe("style-src 'self'");
  });
  it("forbids objects, framing and form posts", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'none'");
  });
  it("declares a default-src of self", () =>
    expect(CONTENT_SECURITY_POLICY).toMatch(/^default-src 'self'/));
});

describe("isAppUrl — the navigation lock", () => {
  it("admits the app's own origin", () => {
    expect(isAppUrl(`${APP_ORIGIN}/index.html`)).toBe(true);
    expect(isAppUrl(`${APP_ORIGIN}/admin/users`)).toBe(true);
  });
  it("refuses everything else", () => {
    for (const url of [
      "https://evil.test/",
      "http://127.0.0.1:4173/",
      "file:///C:/Windows/System32/drivers/etc/hosts",
      "dulja://other/index.html",
      "javascript:alert(1)",
      "about:blank",
    ]) {
      expect(isAppUrl(url), url).toBe(false);
    }
  });
});

describe("where backoffice.exe opens", () => {
  it("opens the origin's root, which the router routes to sign-in, and never /index.html", () => {
    // `/index.html` reaches the shell too, but the back office's router answers that path with "Not Found".
    // `tests/e2e/backoffice-csp.spec.ts` proves this path renders sign-in under the desktop's policy.
    expect(BACKOFFICE_START_PATH).toBe("/");
    const main = readFileSync(join(__dirname, "../src/main.ts"), "utf8");
    expect(main).toContain("window.loadURL(`${APP_ORIGIN}${BACKOFFICE_START_PATH}`)");
    expect(main).not.toMatch(/loadURL\([^)]*index\.html/);
  });
});
