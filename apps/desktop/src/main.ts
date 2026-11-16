import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import {
  APP_ORIGIN,
  APP_SCHEME,
  BACKOFFICE_START_PATH,
  browserWindowOptions,
  CONTENT_SECURITY_POLICY,
} from "./window-options";
import { resolveRendererRequest } from "./renderer-request";
import { decideNavigation } from "./navigation-guard";
import { preloadFaultAction, type PreloadFault } from "./preload-guard";
import { createSecureStore, setOrRefuse } from "./secure-store";
import { captureFault, initSentry } from "./sentry";
import {
  checkForUpdates,
  configureUpdater,
  resolveUpdateFeed,
  scheduleUpdateChecks,
} from "./updater";
import { isTrustedIpcSender } from "./ipc-sender";
import { CHANNELS, type AuthSetResult } from "./bridge-types";

/**
 * First, before anything reads `app.getName()` or `app.getPath("userData")`. Electron's default for
 * both is `package.json`'s `name` field, and `apps/desktop`'s is the Bun workspace name `@dulja/desktop`
 * — found (0E T13) by launching the packaged app and asking it directly: with no `setName` call,
 * `app.getPath("userData")` came back `%APPDATA%\@dulja/desktop`, which Windows resolves as two nested
 * folders (`@dulja\desktop`) because it treats `/` as a path separator too, and the same string is the
 * title Electron would give the fatal-preload dialog below. Neither matches `productName` in
 * `electron-builder.yml`, the Start-menu entry, or the installer window a clean-VM run actually shows —
 * an unrelated npm scope leaking into what a user or an owner-gate verifier sees. `productName` itself
 * is not a runtime API `main.ts` can read (it is electron-builder's build-time field, baked into the
 * packaged `.exe`'s version resource, not into `app.asar`'s `package.json`), so the fix is to set the
 * same string at the one place Electron does read.
 */
app.setName("Dulja Back Office");

/**
 * Above `protocol.registerSchemesAsPrivileged` below, for two reasons that only bite once the owner
 * supplies a DSN (OD-22): `@sentry/electron`'s main SDK throws if `init` runs after the `ready` event,
 * and it registers its own privileged scheme and then proxies `registerSchemesAsPrivileged` so that a
 * later call of ours *appends* to its list instead of replacing it. Reversed, this app would work
 * perfectly with no DSN and break the day one arrives.
 *
 * **Both reads below are runtime reads, from the end user's own process environment at launch.** This
 * file is compiled by `tsc` and packaged as-is; nothing substitutes a value into it at build time.
 * electron-builder does substitute the build environment into its own *configuration* — that is how
 * `${env.DULJA_UPDATE_FEED}` reaches the shipped `app-update.yml` — but it carries nothing into the
 * packaged process's `process.env`, which is what these two reads need. Nothing sets `SENTRY_DSN` or
 * `APP_ENV` on the machine a packaged build actually runs on — an installed app is started from the
 * Start menu, not from a shell that exported them — so in a packaged build `initSentry` returns early
 * (`sentry.ts` treats an absent or empty DSN as "off") and the main-process SDK is inert; were a DSN
 * to reach it, its events would be labelled `dev`. That is OWNER GATE OD-22 and §5.0 row 0.14, whose
 * home is slice 0C, not 0E — recorded here because this is where whoever wires it will be standing,
 * not as work this slice left undone.
 */
initSentry(process.env["SENTRY_DSN"], process.env["APP_ENV"] ?? "dev");

/**
 * The built back office. A path, not an import — `desktop` imports build outputs only (spec:2389).
 * Packaged, it arrives as `extraResources` (electron-builder.yml) beside the asar, never inside it.
 */
const RENDERER_DIR = app.isPackaged
  ? join(process.resourcesPath, "renderer")
  : resolve(__dirname, "../../backoffice/dist");

/** Built by `bun build src/preload.ts --outfile dist/preload.js`, so it sits beside this file. */
const PRELOAD_PATH = join(__dirname, "preload.js");

/**
 * `DULJA_UPDATE_FEED` (OWNER GATE OD-20) reaches the updater **only when this is not a packaged app**.
 * A packaged install uses the feed it was built with, full stop: unsigned (OD-18) and installed
 * per-user, it has no publisher to verify a downloaded installer against, so its feed URL is the trust
 * root of the whole update path — and that variable is writable by anything running as the logged-in
 * user, with no admin rights. The argument in full — including what this does *not* buy while OD-18
 * leaves the artefact unsigned — is on `resolveUpdateFeed`. A development run is the developer's own
 * machine with no install to hijack, so it still honours the variable and falls back to a loopback
 * placeholder when it is unset.
 *
 * `undefined` here is not "no feed": it is what leaves electron-updater reading the `app-update.yml`
 * electron-builder baked in at build time — the file exists for exactly that, and `configureUpdater`
 * explains why overriding it unconditionally would silently retire it.
 */
const UPDATE_FEED = resolveUpdateFeed(app.isPackaged, process.env["DULJA_UPDATE_FEED"]);

// Must run before `app.whenReady()`: a standard, secure scheme is what gives the renderer a real origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** `console.*` is `oxlint`'s `no-console` (error, repo-wide); stderr is this process's whole log sink. */
function logRendererFault(message: string): void {
  process.stderr.write(`[dulja-desktop] ${message}\n`);
}

/**
 * How long a fault box waits for someone to dismiss it before the process exits anyway. A till runs
 * unattended: a modal nobody clicks is a machine that never reaches its exit and so never gets
 * restarted by whatever supervises it. (It also keeps a failure in the packaged E2E specs failing
 * fast rather than running into Playwright's own timeout.)
 */
const FAULT_DIALOG_TIMEOUT_MS = 15_000;

/**
 * The one fault this app refuses to survive — see `preload-guard.ts` for why. Reported to Sentry and
 * flushed before the exit, because `app.exit` is immediate and would otherwise drop the event.
 * `showMessageBox`, not `showErrorBox`: the latter blocks the main thread outright and cannot be
 * bounded.
 */
async function failPreload(fault: PreloadFault): Promise<void> {
  const action = preloadFaultAction(fault, app.isPackaged);
  logRendererFault(action.message);
  if (action.showDialog) {
    await Promise.race([
      dialog.showMessageBox({ type: "error", title: app.getName(), message: action.message }),
      delay(FAULT_DIALOG_TIMEOUT_MS),
    ]);
  }
  await captureFault(new Error(action.message));
  app.exit(action.exitCode);
}

function serveRenderer(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const { target } = resolveRendererRequest(RENDERER_DIR, request.url);
    try {
      return await net.fetch(pathToFileURL(target).toString());
    } catch (error) {
      // A missing file otherwise rejects silently, leaving the `show: false` window invisible forever
      // with no diagnostic anywhere. Log it and answer with a real error response so the navigation
      // fails loudly (`did-fail-load` below) instead of hanging.
      logRendererFault(`failed to serve ${target}: ${String(error)}`);
      return new Response("dulja-desktop: renderer asset not found", { status: 404 });
    }
  });
}

function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
      },
    });
  });
}

/**
 * Any URL not on the app's own origin is refused, full stop; the decision (app / open-external / refuse)
 * is `decideNavigation`, kept in its own file so the default-deny allowlist logic is unit-testable
 * without Electron. `EXTERNAL_HOST_ALLOWLIST` is empty today — see the comment on it — so this
 * currently refuses every external URL and never reaches `shell.openExternal`.
 */
function guardNavigation(event: Electron.Event, url: string): void {
  const verdict = decideNavigation(url);
  if (verdict.kind === "app") return;
  event.preventDefault();
  if (verdict.kind === "open-external") {
    void shell.openExternal(url);
  } else {
    logRendererFault(`refused external navigation to ${url}`);
  }
}

/**
 * The navigation lock, spec:1284, applied once to every `webContents` this app ever creates — not just
 * the first window's. Binding inside `createWindow` instead would leave any `webContents` created later
 * (devtools, a Task 11/12 secondary window, `@sentry/electron`'s own windows) completely unguarded.
 * `will-navigate` only ever covered the main frame; `will-redirect` (a server-side redirect away from an
 * admitted URL) and `will-frame-navigate` (any frame, main or sub — closing the subframe gap `CSP`
 * alone doesn't) round it out.
 */
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", guardNavigation);
  contents.on("will-redirect", guardNavigation);
  // Unlike the two events above, `will-frame-navigate`'s listener gets one merged event+params object
  // (no separate positional `url`) — `details` itself carries `.url` alongside `.preventDefault()`.
  contents.on("will-frame-navigate", (details) => guardNavigation(details, details.url));
  contents.setWindowOpenHandler(({ url }) => {
    const verdict = decideNavigation(url);
    if (verdict.kind === "open-external") {
      void shell.openExternal(url);
    } else {
      logRendererFault(`refused window.open to ${url}`);
    }
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());

  // A preload that throws is reported here and nowhere else: without this listener the window opens
  // anyway, `window.dulja` is absent, and DoD 0.13's "the token is not readable from disk in plain
  // text" is broken in complete silence. `preload-guard.ts` carries the full argument.
  contents.on("preload-error", (_e, preloadPath, error) => {
    void failPreload({ kind: "error", preloadPath, detail: error.message });
  });

  // No load-failure handling previously existed anywhere: a renderer that fails to load left a
  // `show: false` window invisible forever with nothing recorded.
  contents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    logRendererFault(`failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
  });
  contents.on("render-process-gone", (_e, details) => {
    logRendererFault(`renderer process gone: ${details.reason}`);
  });
  contents.on("unresponsive", () => logRendererFault("renderer became unresponsive"));
});

/**
 * A `(_event, key: string) => ...` parameter annotation is a compile-time fiction over IPC: the
 * renderer is on the other side of a structured-clone boundary and can send anything at all. This is
 * the actual runtime check the earlier annotations only pretended to be.
 */
function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

/**
 * Every channel goes through this one registration, so none can be added without the sender check
 * (OPS-11): the main frame of a window on the app's own origin, the rule `main-pos.ts`'s `allowEvent`
 * applies to the till. Navigation is locked to that origin today; this keeps the refresh-token store
 * closed to any window or frame a later change adds.
 */
function handle(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedIpcSender(event)) throw new Error("untrusted IPC sender");
    return handler(event, ...args);
  });
}

/**
 * The one sanctioned door out of the sandbox (spec:1284). Each channel is a named, argument-typed
 * operation — never a generic `invoke` the renderer could redirect. `safeStorage` is named only here:
 * the main process is the only context that has it (`preload.ts` never imports `electron`'s `safeStorage`
 * at all, only `contextBridge`/`ipcRenderer`).
 */
function registerBridgeHandlers(): void {
  const store = createSecureStore(join(app.getPath("userData"), "secure"), safeStorage);
  handle(CHANNELS.authGet, (_event, key) => store.get(expectString(key, "key")));
  handle(CHANNELS.authSet, (_event, key, value): Promise<AuthSetResult> =>
    setOrRefuse(store, expectString(key, "key"), expectString(value, "value")),
  );
  handle(CHANNELS.authRemove, (_event, key) => store.remove(expectString(key, "key")));
  handle(CHANNELS.appVersion, () => app.getVersion());
  handle(CHANNELS.printToPdf, async (event, options) => {
    const landscape = (options as { landscape?: unknown } | null)?.landscape;
    if (typeof landscape !== "boolean") throw new TypeError("options.landscape must be a boolean");
    return new Uint8Array(await event.sender.printToPDF({ landscape, printBackground: true }));
  });
  handle(CHANNELS.appCheckForUpdates, () => checkForUpdates());
}

function createWindow(): void {
  // Checked before the window exists rather than discovered by its absence: `BrowserWindow` accepts a
  // `preload` path that is not there and opens a bridgeless renderer without a word.
  if (!existsSync(PRELOAD_PATH)) {
    void failPreload({ kind: "missing", preloadPath: PRELOAD_PATH });
    return;
  }
  const window = new BrowserWindow(browserWindowOptions(PRELOAD_PATH));
  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${APP_ORIGIN}${BACKOFFICE_START_PATH}`);
}

app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    serveRenderer();
    applyCsp();
    configureUpdater(UPDATE_FEED);
    registerBridgeHandlers();
    createWindow();
    scheduleUpdateChecks();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => app.quit());
}
