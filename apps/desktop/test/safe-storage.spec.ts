import { _electron as electron } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { expect, launchEnv, ROOT, test as base } from "./electron-fixtures";

const TOKEN = "dulja-e2e-refresh-token-9f2c";

const walk = async (dir: string, out: string[] = []): Promise<string[]> => {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
};

interface Fixtures {
  electronApp: ElectronApplication;
}

/**
 * This spec writes a real, DPAPI-encrypted secret to disk (that's the whole point of it) — override the
 * shared fixture's `electronApp` with its own throwaway `--user-data-dir` so a local run doesn't leave
 * that blob behind in the developer's actual roaming profile with nothing to clean it up. `page` (used
 * below) is inherited unchanged from `electron-fixtures.ts` and resolves against this overridden one.
 */
const test = base.extend<Fixtures>({
  // oxlint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const userDataDir = await mkdtemp(join(tmpdir(), "dulja-e2e-userdata-"));
    const app = await electron.launch({
      args: [ROOT, `--user-data-dir=${userDataDir}`],
      env: launchEnv(),
    });
    try {
      await use(app);
    } finally {
      await app.close();
      // Best-effort: Chromium can hold a handle open a beat past `close()` on Windows. A leftover temp
      // directory is a %TEMP% cleanup nuisance, not the plaintext-on-disk defect this spec exists to
      // catch, so a failed rm here must not fail the test.
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

test.describe("safeStorage token store", () => {
  test("stores and returns the token through the bridge, and leaves no plaintext on disk", async ({
    electronApp,
    page,
  }) => {
    const setResult = await page.evaluate(
      (token) => globalThis.dulja.auth.set("sb-auth-token", token),
      TOKEN,
    );
    // The real DPAPI path on this host — the one branch an E2E spec against a live keyring *can* prove.
    // The other branch (`ok: false, reason: "encryption-unavailable"`) is proven in
    // `test/secure-store.test.ts`'s `setOrRefuse` suite, since DPAPI is always available here.
    expect(setResult).toEqual({ ok: true });
    expect(await page.evaluate(() => globalThis.dulja.auth.get("sb-auth-token"))).toBe(TOKEN);

    const userData: string = await electronApp.evaluate(({ app }) => app.getPath("userData"));
    // Close before reading: Chromium holds several of its own internal files open (LevelDB logs, lock
    // files) while running, which makes a live read racy on Windows (`EBUSY: resource busy or locked`)
    // for reasons unrelated to our own `secure/` files. A clean shutdown releases everything; the
    // fixture's own teardown then finds the app already closed and is a no-op.
    await electronApp.close();
    const files = await walk(userData);
    // The positive control: without this, a refactor that moved the store elsewhere (`appData`,
    // `os.homedir()`, ...) would make `walk` return only Chromium's own files, every assertion below
    // would be vacuously satisfied, and this — the one end-to-end proof of DoD 0.13 — would stay green
    // while searching the wrong tree entirely.
    expect(files.some((f) => f.includes(`${sep}secure${sep}`) && f.endsWith(".bin"))).toBe(true);
    for (const file of files) {
      const bytes = await readFile(file);
      // utf8/latin1 alone would miss the token if it were rendered in either of these instead.
      expect(bytes.toString("utf8"), file).not.toContain(TOKEN);
      expect(bytes.toString("latin1"), file).not.toContain(TOKEN);
      expect(bytes.toString("utf16le"), file).not.toContain(TOKEN);
      expect(bytes.toString("base64"), file).not.toContain(Buffer.from(TOKEN).toString("base64"));
    }
  });

  test("the bridge exposes only the declared namespaces", async ({ page }) => {
    expect(await page.evaluate(() => Object.keys(globalThis.dulja).toSorted())).toEqual([
      "app",
      "auth",
      "print",
    ]);
    expect(await page.evaluate(() => Object.keys(globalThis.dulja.auth).toSorted())).toEqual([
      "get",
      "remove",
      "set",
    ]);
    expect(await page.evaluate(() => Object.keys(globalThis.dulja.app).toSorted())).toEqual([
      "checkForUpdates",
      "version",
    ]);
    expect(await page.evaluate(() => Object.keys(globalThis.dulja.print).toSorted())).toEqual([
      "toPdf",
    ]);
    expect(
      await page.evaluate(
        () => typeof (globalThis.dulja as unknown as Record<string, unknown>)["ipcRenderer"],
      ),
    ).toBe("undefined");
  });
});
