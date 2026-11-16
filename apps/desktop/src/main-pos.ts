import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, session } from "electron";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import {
  APP_ORIGIN,
  APP_SCHEME,
  browserWindowOptions,
  CONTENT_SECURITY_POLICY,
  isAppUrl,
} from "./window-options";
import { resolveRendererRequest } from "./renderer-request";
import { createSecureStore, type SecureStore } from "./secure-store";
import { POS_CHANNELS, CHANNELS } from "./bridge-types";
import {
  checkForUpdates,
  configureUpdater,
  DEV_POS_UPDATE_FEED,
  resolveUpdateFeed,
  scheduleUpdateChecks,
} from "./updater";
import { initSentry } from "./sentry";
import { parsePosBuildConfig, POS_CONFIG_FILE, resolveApiOrigin } from "./api-origin";
import { denyAllPermissions, hardenWebContents } from "./hardening";

app.setName("Dulja POS");
initSentry(process.env["SENTRY_DSN"], process.env["APP_ENV"] ?? "dev");
const RENDERER_DIR = app.isPackaged
  ? join(process.resourcesPath, "renderer")
  : resolve(__dirname, "../../pos/dist");
const POS_MAIN = app.isPackaged
  ? join(app.getAppPath(), "pos-main", "pos-main.cjs")
  : resolve(__dirname, "../../pos/dist-main/pos-main.cjs");
const PRELOAD_PATH = join(__dirname, "preload-pos.js");
/** Written at packaging time (ADR 0093); a development run reads it from the same place if it exists. */
const POS_CONFIG_PATH = app.isPackaged
  ? join(process.resourcesPath, POS_CONFIG_FILE)
  : resolve(__dirname, "../dist-config", POS_CONFIG_FILE);

function log(message: string): void {
  process.stderr.write(`[dulja-pos] ${message}\n`);
}

function readBakedConfig(): string | null {
  try {
    return readFileSync(POS_CONFIG_PATH, "utf8");
  } catch {
    return null;
  }
}
/** Structural build-output port; desktop imports no POS source or package. */
interface TillModule {
  openTill(options: {
    ipcMain: typeof ipcMain;
    channels: Readonly<Record<string, string>>;
    dbPath: string;
    baseUrl: string;
    deviceStore: SecureStore;
    allowEvent: (event: unknown) => boolean;
    print: (payload: unknown) => Promise<void>;
  }): Promise<{ close(): Promise<void> }>;
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
app.enableSandbox();
// OPS-10: the back office's whole-app hardening, applied to every webContents the till creates.
app.on("web-contents-created", (_event, contents) => hardenWebContents(contents, log));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let till: { close(): Promise<void> } | null = null;
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting || !till) return;
    event.preventDefault();
    quitting = true;
    void till.close().finally(() => app.quit());
  });
  void app
    .whenReady()
    .then(async () => {
      if (!existsSync(PRELOAD_PATH) || !existsSync(POS_MAIN))
        throw new Error("POS build output or preload is missing");
      // Before anything opens: a packaged till with no https origin refuses to start, with a dialog,
      // rather than enrolling against loopback or sending cashier PINs in clear (ADR 0093).
      const apiBaseUrl = resolveApiOrigin(
        app.isPackaged,
        process.env["DULJA_API_BASE_URL"],
        parsePosBuildConfig(readBakedConfig()),
      );
      protocol.handle(APP_SCHEME, async (request) => {
        const { target } = resolveRendererRequest(RENDERER_DIR, request.url);
        try {
          return await net.fetch(pathToFileURL(target).toString());
        } catch (error) {
          // A missing file otherwise rejects silently and leaves the `show: false` window hidden for ever.
          log(`failed to serve ${target}: ${String(error)}`);
          return new Response("dulja-pos: renderer asset not found", { status: 404 });
        }
      });
      denyAllPermissions(session.defaultSession);
      session.defaultSession.webRequest.onHeadersReceived((details, callback) =>
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
          },
        }),
      );
      // The till's own development feed, never the back office's (6B T10): an unset variable on an
      // unpackaged run falls back to `/updates/pos/`, and a packaged build keeps its shipped app-update.yml.
      configureUpdater(
        resolveUpdateFeed(
          app.isPackaged,
          process.env["DULJA_POS_UPDATE_FEED"],
          DEV_POS_UPDATE_FEED,
        ),
      );
      const window = new BrowserWindow({
        ...browserWindowOptions(PRELOAD_PATH),
        fullscreen: app.isPackaged,
        autoHideMenuBar: true,
      });
      window.webContents.on("preload-error", (_event, _path, error) => {
        process.stderr.write(`${error.message}\n`);
        app.exit(1);
      });
      window.once("ready-to-show", () => window.show());
      const allowEvent = (raw: unknown): boolean => {
        const event = raw as { sender?: unknown; senderFrame?: { url: string } | null };
        return (
          event.sender === window.webContents &&
          event.senderFrame === window.webContents.mainFrame &&
          isAppUrl(event.senderFrame.url)
        );
      };
      ipcMain.handle(CHANNELS.appVersion, (event) => {
        if (!allowEvent(event)) throw new Error("untrusted IPC sender");
        return app.getVersion();
      });
      ipcMain.handle(CHANNELS.appCheckForUpdates, (event) => {
        if (!allowEvent(event)) throw new Error("untrusted IPC sender");
        return checkForUpdates();
      });
      const load = createRequire(pathToFileURL(__filename).toString());
      const module = load(POS_MAIN) as TillModule;
      till = await module.openTill({
        ipcMain,
        channels: POS_CHANNELS,
        dbPath: join(app.getPath("userData"), "till.sqlite"),
        baseUrl: apiBaseUrl,
        deviceStore: createSecureStore(join(app.getPath("userData"), "secure"), safeStorage),
        allowEvent,
        print: async () =>
          new Promise<void>((done, fail) =>
            window.webContents.print({ silent: false, printBackground: true }, (ok, reason) =>
              ok ? done() : fail(new Error(reason)),
            ),
          ),
      });
      await window.loadURL(`${APP_ORIGIN}/index.html`);
      scheduleUpdateChecks();
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : "POS startup failed";
      process.stderr.write(`${message}\n`);
      if (app.isPackaged) dialog.showErrorBox("Dulja POS", message);
      app.exit(1);
    });
  app.on("window-all-closed", () => app.quit());
}
