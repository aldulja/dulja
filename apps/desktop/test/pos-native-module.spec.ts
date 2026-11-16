import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eventually, startBackendStub } from "./backend-stub";
import {
  launchEnv,
  launchPackaged,
  PACKAGED_POS_EXE,
  type PackagedLaunch,
} from "./electron-fixtures";

const exe = PACKAGED_POS_EXE;
/** The packaged till's baked API origin (ADR 0093), beside the renderer under `resources/`. */
const configPath = resolve(exe, "../resources/pos-config.json");

function requirePosPackage(): void {
  test.skip(process.platform !== "win32", "Windows-only product");
  test.skip(
    !existsSync(exe) &&
      process.env["DULJA_REQUIRE_POS_PACKAGE"] !== "1" &&
      process.env["DULJA_REQUIRE_PACKAGE"] !== "1",
    "POS package has not been built in this run",
  );
  expect(existsSync(exe), `required packaged POS executable: ${exe}`).toBe(true);
}

type PosBridge = {
  app: { checkForUpdates(): Promise<{ state: string; message?: string }> };
  pos: {
    status(): Promise<{ enrolled: boolean; pendingOutbox: number }>;
    enrol(code: string): Promise<unknown>;
  };
};

test("packaged POS opens its own SQLite through the built composition root and exposes the sandbox bridge", async () => {
  requirePosPackage();
  const launch = await launchPackaged(launchEnv(), exe);
  const userData = await launch.app.evaluate(({ app }) => app.getPath("userData"));
  try {
    const page = await launch.app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    expect(await launch.app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(
      await page.evaluate(() => ({
        origin: location.origin,
        node: typeof (globalThis as { require?: unknown }).require,
        auth: typeof (globalThis as { dulja?: { auth?: unknown } }).dulja?.auth,
      })),
    ).toEqual({ origin: "dulja://app", node: "undefined", auth: "undefined" });
    // It paints: an unenrolled till opens on its enrolment form, under its own CSP.
    await expect(page.getByRole("heading", { name: "Enrol till" })).toBeVisible();
    const status = await page.evaluate(async () =>
      (globalThis as unknown as { dulja: PosBridge }).dulja.pos.status(),
    );
    expect(status).toMatchObject({ enrolled: false, pendingOutbox: 0 });
    // Startup opens the durable schema via the bundle's external native require, not a development import.
    expect(existsSync(join(userData, "till.sqlite"))).toBe(true);
    // The CSP header's arrival, proved as posture.spec.ts proves the back office's: an inline <script> must
    // not run under `script-src 'self'`. Calling `new Function` from `page.evaluate` proves nothing, because
    // the DevTools protocol's Runtime.evaluate is exempt from the page's CSP.
    const inlineScriptRan = await page.evaluate(
      () =>
        new Promise<boolean>((settle) => {
          const probe = globalThis as unknown as Record<string, unknown>;
          probe["__duljaPosCspProbe"] = false;
          const element = document.createElement("script");
          element.textContent = "window.__duljaPosCspProbe = true;";
          document.head.appendChild(element);
          setTimeout(() => settle(probe["__duljaPosCspProbe"] === true), 100);
        }),
    );
    expect(inlineScriptRan).toBe(false);
    // PRD-10: an update check against a feed that is placeholder or absent is a state, not a crash or a dialog.
    const update = await page.evaluate(async () =>
      (globalThis as unknown as { dulja: PosBridge }).dulja.app.checkForUpdates(),
    );
    expect(["up-to-date", "available", "error"]).toContain(update.state);
    await expect(page.getByRole("heading", { name: "Enrol till" })).toBeVisible();
  } finally {
    await launch.close();
  }
});

/**
 * OPS-05 / ADR 0093: the till dials the origin baked into its package and nothing else. The baked file is
 * rewritten to a local https stub for the run (as `updater.spec.ts` rewrites `app-update.yml`), and the launch
 * carries a decoy `DULJA_API_BASE_URL`, which a packaged till must ignore. Enrolment is the first request an
 * unenrolled till makes; the stub refuses it, which is enough — the request arrived where it should.
 */
test("packaged POS sends enrolment to its baked API origin, never the environment's", async () => {
  requirePosPackage();
  expect(existsSync(configPath), `no ${configPath}`).toBe(true);
  const shipped = await readFile(configPath, "utf8");
  expect((JSON.parse(shipped) as { apiBaseUrl: string }).apiBaseUrl).toMatch(/^https:\/\//);
  const stub = await startBackendStub();
  const decoy = await startBackendStub();
  let launch: PackagedLaunch | undefined;
  try {
    await writeFile(configPath, JSON.stringify({ apiBaseUrl: stub.origin }));
    launch = await launchPackaged(
      {
        ...launchEnv(),
        DULJA_API_BASE_URL: decoy.origin,
        // Lets this launch's main process accept the stub's throwaway certificate; nothing else changes.
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
      exe,
    );
    const page = await launch.app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: "Enrol till" })).toBeVisible();
    const outcome = await page.evaluate(async () => {
      try {
        await (globalThis as unknown as { dulja: PosBridge }).dulja.pos.enrol(
          "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
        );
        return "enrolled";
      } catch {
        return "refused";
      }
    });
    expect(outcome).toBe("refused");
    expect(
      await eventually(() => stub.requests.some((r) => r.path.startsWith("/v1/sync/enrol"))),
      `stub saw ${JSON.stringify(stub.requests.map((r) => `${r.method} ${r.path}`))}`,
    ).toBe(true);
    expect(stub.requests.find((r) => r.path.startsWith("/v1/sync/enrol"))?.method).toBe("POST");
    expect(decoy.requests, "a packaged till honoured DULJA_API_BASE_URL").toEqual([]);
  } finally {
    try {
      await launch?.close();
      await stub.close();
      await decoy.close();
    } finally {
      await writeFile(configPath, shipped);
    }
  }
});
