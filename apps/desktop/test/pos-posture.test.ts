import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { browserWindowOptions, CONTENT_SECURITY_POLICY, isAppUrl } from "../src/window-options";

// `updater.ts` imports Electron's `app` and electron-updater at module scope; `resolveUpdateFeed` reads neither,
// so both are stubbed for the one pure function this file calls.
vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));

const read = (path: string): string => readFileSync(join(__dirname, "..", path), "utf8");
const main = read("src/main-pos.ts");
// OPS-10 moved the per-window guards into one hook over every webContents (`hardening.ts`).
const hardening = read("src/hardening.ts");
describe("POS Electron posture", () => {
  it("uses the same hardened window options without overrides", () => {
    expect(main).toContain("browserWindowOptions(PRELOAD_PATH)");
    expect(browserWindowOptions("preload").webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });
    expect(main).not.toMatch(
      /(?:nodeIntegration|webviewTag):\s*true|(?:contextIsolation|sandbox|webSecurity):\s*false/,
    );
  });
  it("uses contained asset resolution and exact sender frame checks", () => {
    expect(main).toContain("resolveRendererRequest(RENDERER_DIR, request.url)");
    expect(main).toContain("event.senderFrame === window.webContents.mainFrame");
    expect(main).toContain("event.sender === window.webContents");
    expect(main).toContain("isAppUrl(event.senderFrame.url)");
    expect(hardening).toContain("will-attach-webview");
    expect(hardening).toContain('action: "deny"');
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
  });
  it("locks renderer navigation to the app origin and applies the strict CSP", () => {
    expect(main).toContain("hardenWebContents(contents, log)");
    expect(hardening).toContain('"will-navigate"');
    expect(hardening).toMatch(/if \(isAppUrl\(url\)\) return;\s*event\.preventDefault\(\)/);
    expect(main).toContain('"Content-Security-Policy": [CONTENT_SECURITY_POLICY]');
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(isAppUrl("https://evil.example/x")).toBe(false);
  });
  it("mentions no ESC/POS, drawer port, serial, HID or USB code, and prints only through webContents.print — D18, SAH-086", () => {
    for (const file of ["src/main-pos.ts", "src/preload-pos.ts", "src/bridge-types.ts"]) {
      const text = read(file).toLowerCase();
      for (const banned of ["esc/pos", "escpos", "drawer_port", "serialport", "node-hid"])
        expect(text, `${file} / ${banned}`).not.toContain(banned);
      // As words: a bare substring "opos" would convict any later comment that says "proposal".
      expect(text, `${file} / opos`).not.toMatch(/\bopos\b/);
      expect(text, `${file} / usb`).not.toMatch(/\busb\b/);
    }
    // Printing is the ordinary Windows driver behind `webContents.print()` and nothing else (spec:1280, D18).
    expect(main).toContain("webContents.print(");
  });
  it("isolates runtime identity, uses packaged feed rules and handles shutdown/startup failures", () => {
    expect(main).toContain('app.setName("Dulja POS")');
    expect(main).toContain('app.getPath("userData")');
    // A per-machine install directory is not writable by a shop user (6B T9 Step 8).
    expect(main).not.toMatch(/dbPath:\s*join\(\s*__dirname/);
    expect(main).toMatch(
      /resolveUpdateFeed\(\s*app\.isPackaged,\s*process\.env\["DULJA_POS_UPDATE_FEED"\],\s*DEV_POS_UPDATE_FEED,?\s*\)/,
    );
    expect(main).not.toContain("DULJA_UPDATE_FEED");
    expect(main).toContain("app.enableSandbox()");
    expect(main).toContain("app.requestSingleInstanceLock()");
    expect(main).toContain('"before-quit"');
    expect(main).toContain("till.close()");
    expect(main).toContain('"preload-error"');
    expect(main).toContain("app.exit(1)");
  });
  it("an unpackaged till without DULJA_POS_UPDATE_FEED falls back to the POS feed, never the back office's (6B T10)", async () => {
    const { DEV_POS_UPDATE_FEED, DEV_UPDATE_FEED, resolveUpdateFeed } =
      await import("../src/updater");
    expect(DEV_POS_UPDATE_FEED).toMatch(/\/updates\/pos\/$/);
    expect(DEV_POS_UPDATE_FEED).not.toBe(DEV_UPDATE_FEED);
    expect(resolveUpdateFeed(false, undefined, DEV_POS_UPDATE_FEED)).toBe(DEV_POS_UPDATE_FEED);
    expect(resolveUpdateFeed(false, "", DEV_POS_UPDATE_FEED)).toBe(DEV_POS_UPDATE_FEED);
    const override = "http://127.0.0.1:4181/updates/pos/";
    expect(resolveUpdateFeed(false, override, DEV_POS_UPDATE_FEED)).toBe(override);
    // A packaged till keeps the feed it shipped with, whatever the environment says.
    expect(resolveUpdateFeed(true, override, DEV_POS_UPDATE_FEED)).toBeUndefined();
    // The back office's call, which passes no third argument, is unchanged.
    expect(resolveUpdateFeed(false, undefined)).toBe(DEV_UPDATE_FEED);
  });
});
