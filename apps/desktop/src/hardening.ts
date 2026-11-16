import type { Session, WebContents } from "electron";
import { isAppUrl } from "./window-options";

/**
 * The till's share of the back office's whole-app hardening (OPS-10), applied from `web-contents-created`
 * so every `webContents` the till ever creates is covered, not only its first window. The till opens no
 * external URL at all (the back office's allowlist is empty too), so every navigation off the app origin is
 * refused rather than handed to the OS browser.
 */
export function hardenWebContents(contents: WebContents, log: (message: string) => void): void {
  const guard = (event: { preventDefault(): void }, url: string): void => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    log(`refused navigation to ${url}`);
  };
  contents.on("will-navigate", (event, url) => guard(event, url));
  contents.on("will-redirect", (event, url) => guard(event, url));
  contents.on("will-frame-navigate", (details) => guard(details, details.url));
  contents.setWindowOpenHandler(({ url }) => {
    log(`refused window.open to ${url}`);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) log(`failed to load ${url}: ${description} (${code})`);
  });
  contents.on("render-process-gone", (_e, details) =>
    log(`renderer process gone: ${details.reason}`),
  );
  contents.on("unresponsive", () => log("renderer became unresponsive"));
}

/**
 * The till needs no browser permission: it prints through `webContents.print` and talks to its server from
 * the main process. So camera, microphone, geolocation, notifications, HID, serial and the rest are refused
 * outright instead of being left to Electron's default, which grants most of them.
 */
export function denyAllPermissions(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
