import { isAppUrl } from "./window-options";

/**
 * Whether an `ipcMain.handle` event came from the main frame of a window on the app's own origin (OPS-11).
 * Navigation is locked to that origin today, so nothing else can reach the bridge; this keeps it that way
 * for a window or frame added later, the same check the till's `allowEvent` makes. Pure, so a test can hand
 * it a fake event.
 */
export function isTrustedIpcSender(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const event = raw as {
    sender?: { mainFrame?: unknown } | null;
    senderFrame?: { url?: unknown } | null;
  };
  const frame = event.senderFrame;
  if (frame === null || frame === undefined || typeof frame.url !== "string") return false;
  return event.sender?.mainFrame === frame && isAppUrl(frame.url);
}
