import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  expect,
  launchPackaged,
  PACKAGED_EXE,
  requirePackaged,
  ROOT,
  test,
} from "./electron-fixtures";

/**
 * Runs inside the Electron main process, and opens a real database: the load is the assertion, since
 * `better_sqlite3.node` is a native addon and a wrong ABI fails at `require`, not at `prepare`.
 *
 * The specifier is a parameter because Playwright evaluates this in a synthetic main module whose
 * `paths` array is empty — a bare specifier resolves only where Electron's own app-path search finds
 * it, which inside the package it does and in the development tree it does not. That difference is an
 * artefact of how the spec reaches the main process, not of the app: `dist/main.js` is a real module
 * with real `paths`, and 6B's `require("better-sqlite3")` from it resolves normally.
 */
function openInMemoryDatabase(_electron: unknown, specifier: string): number {
  const entry = process.mainModule;
  if (entry === undefined) throw new Error("the main process has no entry module to resolve from");
  const Database = entry.require(specifier) as new (path: string) => {
    prepare(sql: string): { get(): { answer: number } };
    close(): void;
  };
  const db = new Database(":memory:");
  const row = db.prepare("select 42 as answer").get();
  db.close();
  return row.answer;
}

test.describe("better-sqlite3 against Electron's Node ABI (DoD 0.13)", () => {
  test("loads in the main process of the development tree", async ({ electronApp }) => {
    const specifier = join(ROOT, "node_modules", "better-sqlite3");
    expect(await electronApp.evaluate(openInMemoryDatabase, specifier)).toBe(42);
  });

  // DoD 0.13 says "loads inside the **packaged** app", which the test above cannot show: it resolves
  // `better-sqlite3` out of the workspace's `node_modules`, and against the workspace's Electron
  // rather than the one the installer carries. This one launches the installer's own executable and
  // uses a bare specifier, so Electron's own resolution inside `app.asar` is part of what passes.
  // Skipped where `dist-installer/` was never built — no longer the case on every PR (0E T13, after
  // review): `ci.yml`'s `desktop` job now runs `dist:dir` (`electron-builder --win --dir`) first, which
  // writes `win-unpacked/` without a full NSIS package, so this case runs there too, not only at release
  // time. `.github/workflows/release.yml` still runs the full `dist` then `test:electron` on a tag push
  // or manual dispatch, against the real signed-or-unsigned installer rather than the `--dir` tree.
  test("loads inside the packaged app, from outside the asar archive", async () => {
    requirePackaged(PACKAGED_EXE);
    // Asserted separately from the load, because the load does not depend on it: two mechanisms put
    // the binary outside the archive (`electron-builder.yml`'s `asarUnpack` and electron-builder's own
    // smart-unpack of `.node` files), so removing either one changes nothing. What this holds is the
    // arrangement itself — a native binary on disk, where a signing step can reach it (ADR 0017).
    expect(
      existsSync(
        resolve(
          PACKAGED_EXE,
          "../resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node",
        ),
      ),
      "better-sqlite3's native binary is inside app.asar, not beside it",
    ).toBe(true);
    const launch = await launchPackaged();
    try {
      // Without this the test could pass against a development launch and prove nothing about the
      // package: `isPackaged` is false for every other Electron process this suite starts.
      expect(await launch.app.evaluate(({ app }) => app.isPackaged)).toBe(true);
      expect(await launch.app.evaluate(openInMemoryDatabase, "better-sqlite3")).toBe(42);
    } finally {
      await launch.close();
    }
  });
});
