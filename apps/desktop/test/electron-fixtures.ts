import { _electron as electron, test as base } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_ORIGIN } from "../src/window-options";

export const ROOT = resolve(__dirname, "..");

/**
 * The unpacked payload both `bun run --cwd apps/desktop dist` and `dist:dir` write. `ci.yml`'s `desktop`
 * job runs `dist:dir` (0E T13, after review) on every PR — cheaper than a full installer, since it skips
 * the NSIS script, LZMA compression and the 126 MB write — so this exists there too now, not only at
 * release time. `.github/workflows/release.yml` runs the full `dist` and `test:electron` straight after,
 * against a real signed-or-unsigned NSIS package rather than the `--dir` tree; either way, a packaging
 * regression that reaches this path now surfaces on the PR that caused it, not only at release time.
 */
export const PACKAGED_EXE =
  process.env["DULJA_BACKOFFICE_EXE"] ||
  resolve(ROOT, "dist-installer/win-unpacked/Dulja Back Office.exe");

/**
 * The till's unpacked tree (`dist:pos:dir`), or — in `release.yml`, after a silent NSIS install — the
 * installed executable, named by `DULJA_POS_EXE`. `DULJA_BACKOFFICE_EXE` does the same for the back
 * office, so the same specs run against the `--dir` tree on a PR and the installed app at release.
 */
export const PACKAGED_POS_EXE =
  process.env["DULJA_POS_EXE"] || resolve(ROOT, "dist-installer-pos/win-unpacked/Dulja POS.exe");

/**
 * Skips a packaged case where nothing was packaged — a developer's checkout — unless the run says a
 * package must be there (`DULJA_REQUIRE_PACKAGE=1`, set by both Windows workflows), where a missing file
 * is a failure: a CI run that packaged nothing must not go green on skips (PRD-32).
 */
export function requirePackaged(path: string, what = path): void {
  const required = process.env["DULJA_REQUIRE_PACKAGE"] === "1";
  test.skip(!required && !existsSync(path), `not built: ${what}`);
  if (!existsSync(path)) throw new Error(`required by DULJA_REQUIRE_PACKAGE but missing: ${what}`);
}

/**
 * This host's shell inherits `ELECTRON_RUN_AS_NODE=1` (almost certainly leaked from Claude Code's own
 * Electron-hosted process tree) — with it set, any spawned `electron.exe`, this app's own launch
 * included, runs as plain Node instead of the real Electron runtime, so `electron.protocol` etc. come
 * back `undefined` and the app crashes before `app.whenReady()`. Deleting it here, once, from the env
 * object handed to every launch is what makes the suite reproducible outside whatever shell happens to
 * invoke `playwright test` — no out-of-band `unset` required. Exported so a spec that needs to override
 * the `electronApp` fixture (e.g. to add its own `--user-data-dir`) still launches with the same fix.
 */
export function launchEnv(): Record<string, string> {
  const env: NodeJS.ProcessEnv = { ...process.env, DULJA_E2E: "1" };
  delete env["ELECTRON_RUN_AS_NODE"];
  // Dropped for the same reason, one layer up: whoever ran `dist` had to export `DULJA_UPDATE_FEED`
  // (electron-builder cannot resolve `publish.url` without it), and that value inherited into a
  // launch would override the feed under test — silently turning the packaged updater spec, whose
  // whole subject is what happens when the variable is *absent*, into a test of the variable.
  delete env["DULJA_UPDATE_FEED"];
  delete env["DULJA_POS_UPDATE_FEED"];
  // And for the till's API origin: a packaged till ignores it (ADR 0093), and a development launch
  // under test must not dial whatever the packaging step exported.
  delete env["DULJA_API_BASE_URL"];
  // `electron.launch`'s `env` wants `Record<string, string>`; `NodeJS.ProcessEnv` allows `undefined`
  // values (rare on Windows, but real) — drop them rather than coerce them to the string `"undefined"`.
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) sanitized[key] = value;
  }
  return sanitized;
}

export interface PackagedLaunch {
  app: ElectronApplication;
  /** Closes the app and removes its throwaway profile. Always call it from a `finally`. */
  close(): Promise<void>;
}

/**
 * Launches the *installed* artefact rather than the development tree — the only way to say anything
 * about what DoD 0.13 calls "the packaged app". Not a fixture: every caller has to `test.skip` on
 * `existsSync(PACKAGED_EXE)` first, because a developer's own checkout only has `dist-installer/` if
 * they have run `dist` or `dist:dir` themselves (`ci.yml`'s `desktop` job does run `dist:dir` before
 * `test:electron`, so these cases are not skipped there — see `PACKAGED_EXE` above). Its own
 * `--user-data-dir` for the reason `safe-storage.spec.ts` gives: a real install writes into the
 * developer's roaming profile and nothing would clean it up.
 */
export async function launchPackaged(
  env: Record<string, string> = launchEnv(),
  executablePath: string = PACKAGED_EXE,
  extraArgs: string[] = [],
): Promise<PackagedLaunch> {
  const userDataDir = await mkdtemp(join(tmpdir(), "dulja-e2e-packaged-"));
  // Best-effort: Chromium can hold a handle open a beat past `close()` on Windows, and a leftover temp
  // directory is a %TEMP% nuisance rather than a test failure.
  const discardProfile = (): Promise<void> =>
    rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  let app: ElectronApplication;
  try {
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDir}`, ...extraArgs],
      env,
    });
  } catch (cause) {
    // A launch that never returns leaves the caller nothing to close, so the profile is cleaned up
    // here rather than in every caller's `finally` — a packaged app that refuses to start is exactly
    // the case the specs using this are written to catch.
    await discardProfile();
    throw cause;
  }
  return {
    app,
    close: async () => {
      await app.close();
      await discardProfile();
    },
  };
}

interface Fixtures {
  electronApp: ElectronApplication;
  page: Page;
}

/**
 * One launch helper instead of four copy-pasted ones (was: every spec hand-rolled its own
 * `electron.launch`/`app.close`). `app.close()` runs in a `finally`, so a failing assertion inside a
 * test still releases the single-instance lock (`app.requestSingleInstanceLock()` in `main.ts`) instead
 * of leaving a zombie process that makes every subsequent spec in the run fail for an unrelated reason.
 * The `page` fixture also pins the window to the app's own origin before handing it to a test: a
 * `loadURL` that silently failed would otherwise leave a blank page where every `typeof` reads
 * `"undefined"` and the "renderer cannot reach Node" spec would pass for the wrong reason.
 */
export const test = base.extend<Fixtures>({
  // Playwright's fixture-dependency resolution parses this parameter's source text and requires an
  // object-destructuring pattern, even an empty one.
  // oxlint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const app = await electron.launch({ args: [ROOT], env: launchEnv() });
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const origin = await page.evaluate(() => globalThis.location.origin);
    if (origin !== APP_ORIGIN) {
      throw new Error(`expected the fixture window to be on ${APP_ORIGIN}, got ${origin}`);
    }
    await use(page);
  },
});

export { expect } from "@playwright/test";
