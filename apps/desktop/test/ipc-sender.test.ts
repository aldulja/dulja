import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ORIGIN } from "../src/window-options";

const read = (path: string): string => readFileSync(join(__dirname, "..", path), "utf8");

/** OPS-11: every back-office IPC handler checks its sender, as the till's handlers already did. */
describe("isTrustedIpcSender", () => {
  const mainFrame = { url: `${APP_ORIGIN}/` };
  const sender = { mainFrame };

  it("admits the main frame of a window on the app's own origin", async () => {
    const { isTrustedIpcSender } = await import("../src/ipc-sender");
    expect(isTrustedIpcSender({ sender, senderFrame: mainFrame })).toBe(true);
  });

  it("refuses a subframe, a foreign origin, a destroyed frame and a malformed event", async () => {
    const { isTrustedIpcSender } = await import("../src/ipc-sender");
    expect(isTrustedIpcSender({ sender, senderFrame: { url: `${APP_ORIGIN}/` } })).toBe(false);
    const foreign = { url: "https://evil.example/" };
    expect(isTrustedIpcSender({ sender: { mainFrame: foreign }, senderFrame: foreign })).toBe(
      false,
    );
    expect(isTrustedIpcSender({ sender, senderFrame: null })).toBe(false);
    expect(isTrustedIpcSender({})).toBe(false);
    expect(isTrustedIpcSender(null)).toBe(false);
  });

  it("main.ts checks the sender in every handler it registers", () => {
    const main = read("src/main.ts");
    const handlers = main.match(/ipcMain\.handle\(/g) ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    // One guarded registration helper, through which every channel goes.
    expect(main).toMatch(/isTrustedIpcSender\(event\)/);
    expect(handlers).toHaveLength(1);
  });
});

/** OPS-10: the till gets the back office's whole-app hardening, not only a guard on its first window. */
describe("POS hardening parity", () => {
  const pos = read("src/main-pos.ts");
  it("hardens every webContents the till creates and denies every permission request", () => {
    expect(pos).toContain('app.on("web-contents-created"');
    expect(pos).toContain("hardenWebContents(");
    expect(pos).toContain("denyAllPermissions(session.defaultSession)");
    const hardening = read("src/hardening.ts");
    for (const event of [
      '"will-navigate"',
      '"will-redirect"',
      '"will-frame-navigate"',
      '"will-attach-webview"',
      '"did-fail-load"',
      '"render-process-gone"',
    ])
      expect(hardening, event).toContain(event);
    expect(hardening).toContain('action: "deny"');
    expect(hardening).toContain("setPermissionRequestHandler");
    expect(hardening).toContain("setPermissionCheckHandler");
  });
  it("a missing renderer asset answers 404 instead of leaving the hidden window hidden", () => {
    expect(pos).toMatch(/catch[\s\S]{0,300}status: 404/);
  });
});

/** PRD-10: both products check for updates on their own, at startup and periodically. */
describe("startup update check", () => {
  it("both main processes schedule the check after the window loads", () => {
    for (const file of ["src/main.ts", "src/main-pos.ts"]) {
      expect(read(file), file).toContain("scheduleUpdateChecks(");
    }
    expect(read("src/updater.ts")).toMatch(/export function scheduleUpdateChecks/);
  });
});
