import { describe, expect, it } from "vitest";
import { APP_ORIGIN } from "../src/window-options";
import { decideNavigation, EXTERNAL_HOST_ALLOWLIST } from "../src/navigation-guard";

describe("EXTERNAL_HOST_ALLOWLIST — default-deny until OD-20 lands", () => {
  it("ships empty", () => expect(EXTERNAL_HOST_ALLOWLIST).toEqual([]));
});

describe("decideNavigation", () => {
  it("lets the app's own origin navigate normally", () => {
    expect(decideNavigation(`${APP_ORIGIN}/index.html`)).toEqual({ kind: "app" });
    expect(decideNavigation(`${APP_ORIGIN}/admin/users`)).toEqual({ kind: "app" });
  });

  it("refuses an external https host, and it never reaches shell.openExternal", () => {
    // With the real (empty) allowlist, every external host is refused — `main.ts`'s `guardNavigation`
    // only calls `shell.openExternal` when the verdict is "open-external", so "refuse" here is exactly
    // the proof that this host is never handed to the OS browser.
    expect(decideNavigation("https://evil.test/")).toEqual({ kind: "refuse" });
    expect(decideNavigation("https://example.test/")).toEqual({ kind: "refuse" });
  });

  it("refuses non-https and malformed URLs the same way", () => {
    for (const url of [
      "http://127.0.0.1:4173/",
      "file:///C:/Windows/System32/drivers/etc/hosts",
      "javascript:alert(1)",
      "about:blank",
      "not a url at all",
    ]) {
      expect(decideNavigation(url), url).toEqual({ kind: "refuse" });
    }
  });

  it("would open externally for a host that were actually on the allowlist", () => {
    // Exercises the "open-external" branch itself — otherwise it's dead code as far as the test suite
    // can tell, since the real, exported allowlist is empty by design. A custom allowlist here proves
    // the wiring works now, so adding the real host later (one line, per OD-20) is a config change, not
    // a code change that could silently be broken.
    expect(decideNavigation("https://docs.example.test/", ["docs.example.test"])).toEqual({
      kind: "open-external",
    });
    expect(decideNavigation("https://other.test/", ["docs.example.test"])).toEqual({
      kind: "refuse",
    });
  });
});
