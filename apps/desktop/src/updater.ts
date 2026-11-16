import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "./bridge-types";

/** `console.*` is `oxlint`'s `no-console` (error, repo-wide); stderr is this process's whole log sink. */
function logUpdaterFault(message: string): void {
  process.stderr.write(`[dulja-desktop] ${message}\n`);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Where a development run points when nothing else says otherwise. Loopback: it reaches nothing until
 * something is served there, which is the honest default for a machine that has no release feed.
 */
export const DEV_UPDATE_FEED = "http://127.0.0.1:4180/updates/backoffice/";

/**
 * The till's development placeholder: the same loopback host, under the POS prefix. `pos.exe` is a second
 * product with its own feed (6B amendment A5, `DULJA_POS_UPDATE_FEED`), so an unpackaged POS run must never
 * fall back to the back office's prefix — a local feed served there would offer the till the back office's
 * releases as its own updates (6B T10). `main-pos.ts` passes this as `resolveUpdateFeed`'s third argument.
 */
export const DEV_POS_UPDATE_FEED = "http://127.0.0.1:4180/updates/pos/";

/**
 * Which feed a launch is allowed to use. `undefined` means "the feed this build was packaged with" —
 * see the `setFeedURL` call below.
 *
 * **A packaged build ignores `DULJA_UPDATE_FEED` outright**, and that half is the security-relevant
 * one. `electron-builder.yml` installs per-user (`nsis.perMachine: false`) and carries
 * `forceCodeSigning: false` while OWNER GATE OD-18 leaves builds unsigned, so electron-updater has no
 * publisher name to verify a downloaded installer against: the feed URL is the only trust root the
 * update path has. `DULJA_UPDATE_FEED` is an ordinary user environment variable — anything running as
 * the logged-in user can `setx` it with no admin rights — and a trust root a non-privileged process
 * can rewrite is not a trust root at all.
 *
 * Necessary, not sufficient, and the difference belongs here rather than in a review note: the same
 * `perMachine: false` puts `resources/app-update.yml` under `%LOCALAPPDATA%`, which that same
 * non-privileged process can edit directly. What this closes is the one write path into the trust root
 * that never touches the installation — a persistent `HKCU\Environment` value, which outlives a
 * reinstall and looks like nothing. What makes the artefact itself worth trusting is the signature
 * OD-18 owes; until it lands the update path is hardened, not safe.
 *
 * Parameters rather than reads of `app.isPackaged` and `process.env`, so both branches are decidable
 * in a test on whichever branch the host happens to be — the same reason `navigation-guard.ts` and
 * `window-options.ts` exist as separate pure modules. `devFeed` is the product's own development
 * placeholder: the back office's by default, `DEV_POS_UPDATE_FEED` for `main-pos.ts`.
 */
export function resolveUpdateFeed(
  isPackaged: boolean,
  override: string | undefined,
  devFeed: string = DEV_UPDATE_FEED,
): string | undefined {
  if (isPackaged) return undefined;
  // At an environment boundary the empty string **is** absence — the rule `apps/backoffice/src/lib/env.ts`
  // and `release.yml`'s `IsNullOrWhiteSpace` guard both act on, and the one `configureUpdater` already
  // applies to the value it is handed. Said here as well as there because the two say different things:
  // `configureUpdater` reads `""` as "no override, leave the shipped file in charge", which is right for
  // a package and useless for a development run that has no shipped file — that one wants the
  // placeholder, so a developer who exported the variable empty gets the same run as one who never set
  // it, rather than an updater pointed at nothing.
  return override === undefined || override === "" ? devFeed : override;
}

/**
 * electron-builder's updater against the feed the edge Worker serves from R2 (§3.11 `UPDATE_FEED`, the
 * R2 binding; spec:1279 "Every till updates itself"). The feed URL is configuration, never a literal.
 *
 * `undefined` means "use the feed this build was packaged with" — see the `setFeedURL` call below.
 */
export function configureUpdater(feedUrl: string | undefined): void {
  autoUpdater.autoDownload = false;
  // `AppUpdater` is an `EventEmitter`, and Node throws an `'error'` event that nobody listened for.
  // Every failure inside electron-updater is dispatched through it, so without this listener a feed
  // that is merely unreachable can surface as an uncaught exception in the main process — the app
  // dying because the update server is down. Registered once, before anything can emit.
  autoUpdater.on("error", (cause: unknown) => logUpdaterFault(`updater: ${describe(cause)}`));
  // Without this, `AppUpdater.isUpdaterActive()` is false for any unpackaged run: `checkForUpdates()`
  // then resolves `null` having sent no request at all, and `checkForUpdates` below would report
  // `up-to-date` about a feed it never contacted — a spec asserting that state would prove nothing.
  // A packaged app is active already (`app.isPackaged`); this only opens the development path.
  autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  // Conditional, and that is the whole point of it. `setFeedURL` assigns `AppUpdater.clientPromise`,
  // and `getUpdateInfoAndProvider` reads the `app-update.yml` electron-builder bakes into the package
  // ONLY while `clientPromise` is null. Calling it unconditionally therefore makes that file dead
  // code: an installed till would dial whatever default the developer's binary happened to carry —
  // loopback — for the rest of its life, and would go on doing so after OD-20 lands. So an absent
  // override leaves the shipped configuration in charge, which is what shipping it was for.
  if (feedUrl !== undefined && feedUrl !== "") {
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
  }
}

/** Never throws into the renderer: an unreachable feed is a state, not an exception. */
export async function checkForUpdates(): Promise<UpdateStatus> {
  try {
    const result = await autoUpdater.checkForUpdates();
    // `isUpdateAvailable` rather than comparing `updateInfo.version` to `currentVersion`: a feed that
    // has gone *backwards* (a pulled release) reports a different version that is not an update, and
    // electron-updater has already applied its own staging-rollout and support checks to this flag.
    if (result === null || !result.isUpdateAvailable) return { state: "up-to-date" };
    // `autoDownload` is off, so this is the only thing that starts one. It must not be left floating:
    // an unhandled rejection in the main process is precisely the silent failure this module exists to
    // avoid, and the state below is already decided by the check, not by the download.
    void autoUpdater.downloadUpdate().catch((cause: unknown) => {
      logUpdaterFault(`failed to download the new version: ${describe(cause)}`);
    });
    return { state: "available", version: result.updateInfo.version };
  } catch (cause) {
    return { state: "error", message: describe(cause) };
  }
}

/**
 * PRD-10: neither product used to look for an update unless its renderer asked, and the till's never did,
 * so every till stayed on the build it was installed with. One check shortly after startup and one every
 * few hours after that; `checkForUpdates` starts the download when there is one, and electron-updater's
 * default `autoInstallOnAppQuit` installs it the next time the app quits (a till's shift and outbox live in
 * SQLite and survive the restart). A feed that is unreachable or not configured is logged and nothing else:
 * no dialog, no crash.
 */
export const UPDATE_CHECK_DELAY_MS = 30_000;
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function scheduleUpdateChecks(): void {
  const run = (): void => {
    void checkForUpdates().then((status) => {
      if (status.state === "error")
        logUpdaterFault(`scheduled check for a new version failed: ${status.message ?? ""}`);
    });
  };
  setTimeout(run, UPDATE_CHECK_DELAY_MS).unref();
  setInterval(run, UPDATE_CHECK_INTERVAL_MS).unref();
}
