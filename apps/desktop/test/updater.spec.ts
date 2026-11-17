import { _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { isIP, type AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { APP_ORIGIN } from "../src/window-options";
// Safe to import into the Playwright runner, which is plain Node: nothing at this module's top level
// touches `app` or `autoUpdater` (the latter is a lazy getter on `electron-updater`'s exports, and
// `require("electron")` outside Electron merely returns the executable's path as a string).
import { DEV_UPDATE_FEED, resolveUpdateFeed } from "../src/updater";
import type { UpdateStatus } from "../src/bridge-types";
import type { PackagedLaunch } from "./electron-fixtures";
import {
  expect,
  launchEnv,
  launchPackaged,
  PACKAGED_EXE,
  requirePackaged,
  ROOT,
  test,
} from "./electron-fixtures";

/** The version electron-updater compares the feed against: `app.getVersion()` reads this manifest. */
async function appVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
    version?: string;
  };
  const { version } = manifest;
  if (version === undefined) throw new Error("apps/desktop/package.json declares no version");
  return version;
}

/**
 * A static `latest.yml` on loopback, shaped like the one `electron-builder` writes into
 * `dist-installer/`. OWNER GATE OD-20 has not supplied the R2-backed domain, so this stands in for it:
 * the request, the parse and the version comparison are all real, only the host is local.
 */
async function serveFeed(version: string): Promise<{
  url: string;
  requested: string[];
  /** Re-points the feed at a version learned after launch (a release build carries its tag's version). */
  setVersion(next: string): void;
  close(): Promise<void>;
}> {
  const requested: string[] = [];
  let current = version;
  const body = (): string =>
    [
      `version: ${current}`,
      "files:",
      "  - url: dulja-backoffice-setup.exe",
      "    sha512: AA==",
      "    size: 1",
      "path: dulja-backoffice-setup.exe",
      "sha512: AA==",
      "releaseDate: '2026-09-05T00:00:00.000Z'",
      "",
    ].join("\n");
  const server: Server = createServer((request, response) => {
    requested.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/yaml" });
    response.end(body());
  });
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const bound = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${bound}/updates/backoffice/`,
    requested,
    setVersion: (next) => {
      current = next;
    },
    close: () => new Promise<void>((settle) => server.close(() => settle())),
  };
}

/**
 * The true contents of the packaged `app-update.yml`, and where to record them while they are being
 * rewritten.
 *
 * A `finally` is not enough on its own: Playwright abandons a test body at `timeout` (120s here) and
 * at Ctrl-C without unwinding it, so the restore below can simply not happen. What leaks then is a
 * *valid* URL on a dead loopback port, which `legacy-087` would go on grading and passing — a regression
 * test quietly certifying an artefact this suite corrupted. So the baseline is written beside the file
 * first and consulted here on the next run: if what is on disk is exactly what a previous run
 * rewrote, that run died before restoring and the recorded original wins; anything else (a fresh
 * `dist`, a clean previous run) is legitimate and becomes the new baseline. The sidecar deliberately
 * carries no `.json`/`.yml` extension, so `legacy-087`'s metadata walk does not pick it up.
 */
async function readFeedBaseline(
  configPath: string,
): Promise<{ baseline: string; baselinePath: string }> {
  const baselinePath = `${configPath}.spec-baseline`;
  const current = await readFile(configPath, "utf8");
  if (!existsSync(baselinePath)) return { baseline: current, baselinePath };
  const recorded = JSON.parse(await readFile(baselinePath, "utf8")) as {
    shipped: string;
    rewritten: string;
  };
  return { baseline: current === recorded.rewritten ? recorded.shipped : current, baselinePath };
}

/**
 * The shared `electronApp` fixture cannot be used here — the feed is per-test and has to be in the
 * environment before the process starts — so the thing that fixture exists to guarantee is done by
 * hand: nothing may escape this function still running. A launched app that is never closed keeps
 * `app.requestSingleInstanceLock()`, and every later spec in the run then fails for that reason
 * instead of its own.
 */
async function launchAgainst(feed: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [ROOT],
    env: { ...launchEnv(), DULJA_UPDATE_FEED: feed },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const origin = await page.evaluate(() => globalThis.location.origin);
    if (origin !== APP_ORIGIN) throw new Error(`expected ${APP_ORIGIN}, got ${origin}`);
    return { app, page };
  } catch (cause) {
    await app.close();
    throw cause;
  }
}

const askRenderer = (page: Page): Promise<UpdateStatus> =>
  page.evaluate(() => globalThis.dulja.app.checkForUpdates());

/**
 * Whether a `URL.hostname` names this machine. By address rather than by spelling: `localhost` is not
 * `127.0.0.1` as a string but is one in effect, the whole 127/8 range is loopback while only that one
 * canonical address was being excluded, and `URL` serialises an IPv6 host with its brackets
 * (`"[::1]"`), so a literal `"::1"` comparison could never match anything. The gate this feeds decides
 * whether the OD-20 spec runs, so a hole here is a spec that runs against a placeholder and fails for
 * the wrong reason.
 */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  if (isIP(host) === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
  return false;
}

/**
 * No launch at all: the feed decision is a pure function precisely so that the branch this host is not
 * on can still be asserted. Nothing else here can reach it — a development-tree launch is unpackaged by
 * construction, and the one case below that launches a real package skips wherever `dist-installer/` is
 * absent, which on every PR it is (`ci.yml`'s `dist:dir` writes no `app-update.yml`).
 *
 * Their proper home is a vitest `test/updater.test.ts` beside `navigation-guard.test.ts` — the runner
 * this repository uses for pure modules — and `vitest.config.ts`'s `include` matches `.test.ts` only, so
 * where they sit `bun run test` cannot see them. Moving them is a file move plus `test.describe`/`test`
 * becoming `describe`/`it`; until then `test:electron`, which every PR does run, is what covers them.
 */
test.describe("resolveUpdateFeed — a packaged build's feed is not user-writable", () => {
  test("a packaged app ignores DULJA_UPDATE_FEED, whatever it names", () => {
    expect(resolveUpdateFeed(true, "http://attacker.example/updates/backoffice/")).toBeUndefined();
    expect(resolveUpdateFeed(true, DEV_UPDATE_FEED)).toBeUndefined();
  });

  test("a packaged app with nothing set is unchanged — app-update.yml stays in charge", () => {
    expect(resolveUpdateFeed(true, undefined)).toBeUndefined();
  });

  test("a development run still honours the override", () => {
    const feed = "http://127.0.0.1:4181/updates/backoffice/";
    expect(resolveUpdateFeed(false, feed)).toBe(feed);
  });

  test("a development run with nothing set gets the loopback placeholder", () => {
    expect(resolveUpdateFeed(false, undefined)).toBe(DEV_UPDATE_FEED);
  });

  test("an empty variable is an absent one, not a feed", () => {
    expect(resolveUpdateFeed(false, "")).toBe(DEV_UPDATE_FEED);
  });

  /**
   * The function is only as good as its one caller, and no other case in this file can see that call.
   * `navigation-guard.ts` and `window-options.ts` need no equivalent: a development launch takes the
   * same branch an install does, so their wiring is proven by behaviour. This one exists *for* the
   * packaged branch — which no development launch reaches, and which the packaged case below skips on
   * every PR. Restore the expression this replaced, leave `resolveUpdateFeed` exported and unused, and
   * every other assertion in this suite still passes. So the call site itself is the assertion.
   *
   * Read over the whole file, comments and all, which costs nothing: `main.ts` discusses the variable
   * twice, as `` `DULJA_UPDATE_FEED` `` and as `${env.DULJA_UPDATE_FEED}`, and neither is a
   * `process.env` read. Prose about it stays free; a second *read* of it does not.
   */
  test("main.ts reads the variable once, and hands it the real packaged flag", async () => {
    const source = await readFile(join(ROOT, "src/main.ts"), "utf8");
    // The first argument is the security-critical one, so it is pinned to `app.isPackaged` exactly —
    // a literal `false` there would reopen the hole with the function still in place. The second is
    // left to spell itself however it likes; the count below is what constrains it.
    expect(source).toMatch(/resolveUpdateFeed\(\s*app\.isPackaged\s*,/);
    // Both spellings, because nothing in this repository's `tsconfig` forbids the dot form.
    const read = /process\.env(?:\[\s*["']DULJA_UPDATE_FEED["']\s*\]|\.DULJA_UPDATE_FEED\b)/g;
    expect(
      source.match(read) ?? [],
      "every read of DULJA_UPDATE_FEED in main.ts must go through resolveUpdateFeed",
    ).toHaveLength(1);
  });
});

test.describe("auto-update through the bridge", () => {
  test("an unreachable feed is a state, not an exception thrown into the renderer", async () => {
    // Port 9 (discard) refuses rather than hangs, so this is a connection failure and not a timeout.
    const { app, page } = await launchAgainst("http://127.0.0.1:9/none/");
    try {
      const status = await askRenderer(page);
      expect(status.state).toBe("error");
      expect(status.message ?? "").not.toBe("");
      // The window survived it: an updater fault must not take the app down with it.
      expect(await page.evaluate(() => globalThis.location.origin)).toBe(APP_ORIGIN);
    } finally {
      await app.close();
    }
  });

  test("a feed at the running version reports up-to-date, having actually fetched latest.yml", async () => {
    const version = await appVersion();
    const feed = await serveFeed(version);
    const { app, page } = await launchAgainst(feed.url);
    try {
      expect(await askRenderer(page)).toEqual({ state: "up-to-date" });
      // Without this the spec would pass identically against a feed never contacted — which is what
      // electron-updater does by default outside a packaged app (`isUpdaterActive`). The path is
      // compared without its query: electron-updater appends its own `?noCache=<random>`.
      expect(feed.requested.map((url) => url.split("?")[0])).toContain(
        "/updates/backoffice/latest.yml",
      );
      expect(await page.evaluate(() => globalThis.dulja.app.version())).toBe(version);
    } finally {
      await app.close();
      await feed.close();
    }
  });

  test("a feed ahead of the running version reports the version that is available", async () => {
    const feed = await serveFeed("99.0.0");
    const { app, page } = await launchAgainst(feed.url);
    try {
      expect(await askRenderer(page)).toEqual({ state: "available", version: "99.0.0" });
    } finally {
      await app.close();
      await feed.close();
    }
  });

  /**
   * The clause the other three cannot reach. Every one of them sets `DULJA_UPDATE_FEED`, so all they
   * prove is that an override is honoured. An installed till has no such variable: its feed is the
   * `app-update.yml` electron-builder wrote at build time, and `AppUpdater` consults that file only
   * while nothing has called `setFeedURL` — so an unconditional `setFeedURL` (which is what this task
   * shipped first) makes the file dead and pins every install to the developer's default forever.
   *
   * The shipped file is **rewritten** to an ephemeral port rather than served on the one it was built
   * with, and that is what makes the test decisive. A local `dist` bakes in the same loopback URL that
   * `main.ts` uses as its development default, so serving that port would answer either way and the
   * test could not tell "read the file" from "fell back to the built-in default". Pointed somewhere
   * only the file knows about, silence is a failure. Restored afterwards; `win-unpacked/` is build
   * output, and the next `dist` overwrites it regardless.
   *
   * It also launches **with** `DULJA_UPDATE_FEED` set, to a decoy — the half this case originally
   * lacked, and the one that catches the defect it was blind to. While the variable was read
   * unconditionally it overrode the baked-in file in a packaged build too, so anything running as the
   * logged-in user could `setx` an unsigned, per-user install (`electron-builder.yml:78,102`) onto an
   * attacker's feed with no admin rights. A build that honoured it now fails twice over: the decoy
   * records a request, and the status names the decoy's version rather than `up-to-date`.
   */
  test("a packaged app dials the feed it was built with, ignoring DULJA_UPDATE_FEED", async () => {
    requirePackaged(PACKAGED_EXE);
    const configPath = resolve(PACKAGED_EXE, "../resources/app-update.yml");
    // A `dist` without `DULJA_UPDATE_FEED` set fails *after* packaging (ADR 0017 decision 5), which
    // leaves the executable on disk with no feed config beside it. Skipping says so; a bare ENOENT
    // out of the `readFile` below would not. Where a package is required (both Windows workflows; PRD-32,
    // `ci.yml` writes a placeholder file into its `--dir` tree) a missing file fails instead.
    requirePackaged(configPath, `part-built: no ${configPath}`);
    const feed = await serveFeed(await appVersion());
    // Far enough ahead that obeying it would read `available 99.0.0`, not `up-to-date` — so the wrong
    // branch is legible in the status even if the request bookkeeping were somehow lost.
    const decoy = await serveFeed("99.0.0");
    const { baseline, baselinePath } = await readFeedBaseline(configPath);
    // Everything that mutates state lives inside the `try`, and `launch` is declared outside it, so
    // that a failure anywhere still reaches the restore below.
    let launch: PackagedLaunch | undefined;
    try {
      const rewritten = baseline.replace(/^url:.*$/m, `url: ${feed.url}`);
      expect(rewritten, `no url line in ${configPath}:\n${baseline}`).not.toBe(baseline);
      await writeFile(baselinePath, JSON.stringify({ shipped: baseline, rewritten }));
      await writeFile(configPath, rewritten);
      launch = await launchPackaged({ ...launchEnv(), DULJA_UPDATE_FEED: decoy.url });
      // At the running build's own version, whatever a release stamped into it (OPS-06).
      const running = await launch.app.evaluate(({ app }) => app.getVersion());
      feed.setVersion(running);
      // electron-updater reads `<channel>.yml`, the channel being the version's prerelease tag: a preview
      // build (`0.1.0-preview.7`, `release.yml`) follows `preview.yml`, a release `latest.yml`.
      const channel = /^\d+\.\d+\.\d+-([A-Za-z]+)/.exec(running)?.[1] ?? "latest";
      const page = await launch.app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      expect(await askRenderer(page)).toEqual({ state: "up-to-date" });
      expect(feed.requested.map((path) => path.split("?")[0])).toContain(
        `/updates/backoffice/${channel}.yml`,
      );
      expect(decoy.requested, "a packaged build honoured DULJA_UPDATE_FEED").toEqual([]);
    } finally {
      // Nested, so that a rejecting `close()` cannot pre-empt the restore. The restore is the only
      // side effect here that outlives the process, and it is the one that must not be skipped.
      try {
        await launch?.close();
        await feed.close();
        await decoy.close();
      } finally {
        await writeFile(configPath, baseline);
        await rm(baselinePath, { force: true });
      }
    }
  });

  /**
   * OWNER GATE OD-20, and the only spec in this file that talks to the real thing.
   *
   * It used to gate on a non-loopback `DULJA_UPDATE_FEED` in the environment and pass it through to a
   * packaged launch. A packaged build now ignores that variable outright — the whole point of
   * `resolveUpdateFeed` — so passing it through would prove nothing, and the gate would either dial
   * whatever loopback placeholder the local `dist` was built against and fail, or pass while testing
   * something else entirely. The gate is therefore re-anchored on the **artefact**: `DULJA_UPDATE_FEED`
   * is a build-time input (`electron-builder.yml`'s `url: ${env.DULJA_UPDATE_FEED}`, ADR 0017 decision
   * 5), so whether this executable was packaged against the owner's domain is a fact about the
   * `app-update.yml` beside it, not about the shell running the suite. The OD-20 verification command
   * moves with it: *build* with the domain exported, then run the suite.
   *
   * Loopback is excluded rather than merely "present", because the local `dist` everyone runs is built
   * against the placeholder `main.ts` uses in development, which answers nothing. That also makes the
   * gate skip rather than fail if the case above ever dies mid-way and leaves its rewritten loopback
   * URL on disk.
   */
  test("the packaged app reaches the owner's own feed when it was built against one", async () => {
    requirePackaged(PACKAGED_EXE);
    const configPath = resolve(PACKAGED_EXE, "../resources/app-update.yml");
    test.skip(!existsSync(configPath), `part-built: no ${configPath}`);
    const urlLine = /^url:[ \t]*(.*)$/m.exec(await readFile(configPath, "utf8"))?.[1]?.trim() ?? "";
    // `url: ''` is what `dist` writes when the variable was exported empty — the pattern is expanded,
    // never defaulted (`docs/runbooks/clean-vm-install.md:84`) — and the empty string **is** absence at
    // an environment boundary, the rule `apps/backoffice/src/lib/env.ts:21-34` and `release.yml:64`
    // (`IsNullOrWhiteSpace`) both act on. Read that way here too, and read *first*: `new URL("")` throws
    // `TypeError: Invalid URL`, so the emptiness test has to short-circuit ahead of it or an unbuilt
    // feed would fail the run instead of skipping it. A non-empty but malformed value still throws,
    // which is correct: that is a mistake, not an absence.
    const built = urlLine.replace(/^['"]|['"]$/g, "");
    // `.invalid` (RFC 2606) is the placeholder `ci.yml` and a preview release build against: it can
    // never resolve, so it is no more the owner's feed than loopback is.
    test.skip(
      built === "" ||
        isLoopback(new URL(built).hostname) ||
        new URL(built).hostname.endsWith(".invalid"),
      `OD-20: this build was packaged against ${built === "" ? "no feed" : built}`,
    );
    // No `DULJA_UPDATE_FEED` in the environment, deliberately: an installed till has none either, and
    // a packaged build would ignore it if it had.
    const launch = await launchPackaged();
    try {
      const page = await launch.app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      const status = await askRenderer(page);
      // Not `up-to-date` specifically: a real feed is entitled to be ahead of the build under test.
      // What it may never be is unreachable, which is the whole content of the gate.
      expect(
        ["up-to-date", "available", "downloading"],
        `${built} answered ${status.message}`,
      ).toContain(status.state);
    } finally {
      await launch.close();
    }
  });
});
