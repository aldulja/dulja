import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRendererRequest } from "../src/renderer-request";

const RENDERER_DIR = `C:${sep}app${sep}apps${sep}backoffice${sep}dist`;
const url = (pathname: string): string => `dulja://app${pathname}`;

describe("resolveRendererRequest — the protocol handler's containment check", () => {
  it("serves a real asset inside the renderer directory", () => {
    const result = resolveRendererRequest(RENDERER_DIR, url("/assets/app.js"));
    expect(result.isAsset).toBe(true);
    expect(result.target).toBe(`${RENDERER_DIR}${sep}assets${sep}app.js`);
  });

  it("falls back to the SPA shell for an extensionless route", () => {
    const result = resolveRendererRequest(RENDERER_DIR, url("/admin/users"));
    expect(result.isAsset).toBe(false);
    expect(result.target).toBe(`${RENDERER_DIR}${sep}index.html`);
  });

  it("blocks upward traversal out of the renderer directory", () => {
    const result = resolveRendererRequest(RENDERER_DIR, url("/../../../etc/passwd"));
    expect(result.isAsset).toBe(false);
    expect(result.target).toBe(`${RENDERER_DIR}${sep}index.html`);
  });

  it("blocks a sibling directory whose name merely starts with the renderer dir's name", () => {
    // The request decodes to `/x<sep>..<sep>..<sep>dist-evil<sep>payload.js`, which resolves to
    // `dist-evil<sep>payload.js` — a *sibling* of `dist`, not inside it. A bare
    // `candidate.startsWith(RENDERER_DIR)` (no trailing separator) wrongly admits this, because
    // "…dist-evil…" does start with "…dist".
    //
    // The separator is derived from `sep` rather than hard-coded as `%5c`, which is what this test
    // did until CI first ran it on Linux. A backslash is a separator on Windows only; on POSIX it is
    // an ordinary filename character, so `%5c` there is not an escape attempt at all — it names one
    // real file sitting legitimately inside the renderer directory, `normalize` leaves it alone, and
    // the containment check correctly admits it. The old assertion therefore failed on Linux against
    // an implementation that was behaving properly. Encoding the platform's own separator exercises
    // the property on whichever platform the suite runs, which is both: the `desktop` job runs these
    // on windows-latest and `checks` runs them again on ubuntu-latest.
    const escapedSep = sep === "\\" ? "%5c" : "%2f";
    const traversal = ["x", "..", "..", "dist-evil", "payload.js"].join(escapedSep);
    const result = resolveRendererRequest(RENDERER_DIR, url(`/${traversal}`));
    expect(result.isAsset).toBe(false);
    expect(result.target).toBe(`${RENDERER_DIR}${sep}index.html`);
  });

  it("does not throw on a malformed percent-escape, and falls back to the SPA shell", () => {
    expect(() => resolveRendererRequest(RENDERER_DIR, url("/%zz"))).not.toThrow();
    const result = resolveRendererRequest(RENDERER_DIR, url("/%zz"));
    expect(result.isAsset).toBe(false);
    expect(result.target).toBe(`${RENDERER_DIR}${sep}index.html`);
  });

  it("recognises an asset whose extension's dot is itself percent-encoded", () => {
    // The raw, still-encoded pathname `/logo%2Epng` has no literal `.` in it at all (`%2E` is the
    // encoded form) — testing the extension regex against the raw pathname instead of the decoded one
    // always missed this, and every such asset fell through to the SPA shell.
    const result = resolveRendererRequest(RENDERER_DIR, url("/logo%2Epng"));
    expect(result.isAsset).toBe(true);
    expect(result.target).toBe(`${RENDERER_DIR}${sep}logo.png`);
  });
});
