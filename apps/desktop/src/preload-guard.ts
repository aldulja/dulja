/** Why the preload is absent or unusable. `missing`: no file. `error`: Electron's `preload-error`. */
export type PreloadFault =
  | { kind: "missing"; preloadPath: string }
  | { kind: "error"; preloadPath: string; detail: string };

export interface PreloadFaultAction {
  message: string;
  /** A packaged app has no console anyone reads; a developer run and CI both have stderr. */
  showDialog: boolean;
  exitCode: number;
}

/**
 * DoD 0.13 in one sentence: "the token is not readable from disk in plain text". A preload that fails
 * to load is the exact way that clause breaks — there is no `window.dulja`, the renderer's
 * `pickSessionStore` sees an ordinary browser, and the Supabase refresh token lands in Chromium's own
 * LevelDB unencrypted. Electron's default for both faults is silence: a missing `preload` path is not
 * an error at all, and `preload-error` is an event nobody is obliged to listen to. So the app refuses
 * to keep running instead: a broken preload is a broken security posture, not a degraded feature.
 *
 * (Task 6 gave the renderer a backstop — Electron-shaped with no bridge falls back to memory only —
 * but a backstop is not the fix: the app is still unusable, and only this side can say why.)
 */
export function preloadFaultAction(fault: PreloadFault, isPackaged: boolean): PreloadFaultAction {
  const detail =
    fault.kind === "missing"
      ? `the preload script is missing at ${fault.preloadPath}`
      : `the preload script at ${fault.preloadPath} failed to run: ${fault.detail}`;
  return {
    message: `refusing to open a window without the context bridge — ${detail}`,
    showDialog: isPackaged,
    exitCode: 1,
  };
}
