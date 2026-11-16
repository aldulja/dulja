import { APP_ORIGIN } from "../src/window-options";
import { eventually, startBackendStub } from "./backend-stub";
import {
  expect,
  launchEnv,
  launchPackaged,
  PACKAGED_EXE,
  requirePackaged,
  test,
} from "./electron-fixtures";

test.describe("Electron security posture", () => {
  test("the renderer cannot reach Node", async ({ page }) => {
    const reachable = await page.evaluate(() => [
      typeof (globalThis as Record<string, unknown>)["require"],
      typeof (globalThis as Record<string, unknown>)["process"],
      typeof (globalThis as Record<string, unknown>)["module"],
      typeof (globalThis as Record<string, unknown>)["Buffer"],
      typeof (globalThis as Record<string, unknown>)["__dirname"],
    ]);
    expect(reachable).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined"]);
    // `window.dulja` is the one sanctioned door (Task 11, spec:1284) — it exists by design; what it
    // must NOT be is a leak of anything Node-shaped. `test/safe-storage.spec.ts`'s "exposes only the
    // declared namespaces" test is the rigorous check of its exact surface; this is just the negative
    // space around it, so a future change can't quietly widen the bridge back into raw Node.
    expect(await page.evaluate(() => typeof globalThis.dulja)).toBe("object");
    expect(
      await page.evaluate(
        () => typeof (globalThis.dulja as unknown as Record<string, unknown>)["ipcRenderer"],
      ),
    ).toBe("undefined");
    expect(
      await page.evaluate(
        () => typeof (globalThis.dulja as unknown as Record<string, unknown>)["require"],
      ),
    ).toBe("undefined");
  });

  test("the document is served from the app's own origin under the CSP", async ({ page }) => {
    expect(await page.evaluate(() => globalThis.location.origin)).toBe("dulja://app");
    const csp = await page.evaluate(
      () =>
        document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')
          ?.content ?? "",
    );
    // The CSP is delivered as a response header, not a meta tag — so there is nothing to read here:
    expect(csp).toBe("");
    // …and the header's arrival is proved by a behaviour the CSP governs and the DevTools protocol
    // does not exempt: an inline <script> inserted into the document. (`page.evaluate(() => eval(…))`
    // is NOT that proof — CDP's Runtime.evaluate is generally exempt from the page CSP, so it would
    // pass or fail for reasons unrelated to the header.) `script-src 'self'` with no 'unsafe-inline',
    // no nonce and no hash must refuse to execute it.
    const inlineScriptRan = await page.evaluate(
      () =>
        new Promise<boolean>((settle) => {
          const probe = globalThis as unknown as Record<string, unknown>;
          probe["__duljaCspProbe"] = false;
          const element = document.createElement("script");
          element.textContent = "window.__duljaCspProbe = true;";
          document.head.appendChild(element);
          setTimeout(() => settle(probe["__duljaCspProbe"] === true), 100);
        }),
    );
    expect(inlineScriptRan).toBe(false);
  });

  test("the app's own stylesheet applies and an injected <style> element does not", async ({
    page,
  }) => {
    // `style-src` carried `'unsafe-inline'` until the 0E final review, justified by a comment about a
    // "Tailwind runtime" that does not exist in v4. Removing an exception is only safe if something
    // then says the app still renders, so both halves are asserted here rather than assumed: the
    // renderer's real, linked stylesheet is loaded…
    expect(await page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0);
    // …and an inline <style> is refused, which is also the proof that the tightened directive is the
    // one actually being delivered. Measured by its effect, not by listening for a console message:
    // a rule that never applied is the behaviour that matters.
    const inlineStyleApplied = await page.evaluate(
      () =>
        new Promise<boolean>((settle) => {
          const probe = document.createElement("div");
          probe.id = "dulja-csp-style-probe";
          document.body.appendChild(probe);
          const element = document.createElement("style");
          element.textContent = "#dulja-csp-style-probe { position: fixed; }";
          document.head.appendChild(element);
          setTimeout(() => settle(globalThis.getComputedStyle(probe).position === "fixed"), 100);
        }),
    );
    expect(inlineStyleApplied).toBe(false);
  });

  test("navigation away from the app's origin is refused", async ({ page }) => {
    await page.evaluate(() => {
      globalThis.location.href = "https://example.test/";
    });
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => globalThis.location.origin)).toBe("dulja://app");
  });

  test("window.open is refused rather than opening a second renderer", async ({
    electronApp,
    page,
  }) => {
    const opened = await page.evaluate(() => globalThis.open("https://example.test/") !== null);
    expect(opened).toBe(false);
    expect(electronApp.windows()).toHaveLength(1);
  });

  /**
   * Every test above launches the development tree. DoD 0.13's "the token is not readable from disk in
   * plain text" rests entirely on the preload being there, and in the *package* the preload is a file
   * inside `app.asar` reached by a path `main.ts` computes differently when `app.isPackaged` — so
   * nothing above says the shipped artefact has a bridge at all. This is the only automated proof of
   * it, and the only thing standing between a packaging mistake and the renderer's storage fallback.
   *
   * Residual, deliberately not closed here: a preload that loads and simply exposes nothing raises no
   * `preload-error`, so `main.ts`'s guard cannot see it. This test would catch that — which is most of
   * why it is worth its second launch.
   */
  test("the packaged artefact opens a window on the app's origin with the bridge in it", async () => {
    requirePackaged(PACKAGED_EXE);
    const launch = await launchPackaged();
    try {
      expect(await launch.app.evaluate(({ app }) => app.isPackaged)).toBe(true);
      // Nothing else in this repository pins this: `safe-storage.spec.ts` and `launchPackaged` itself
      // always override `--user-data-dir`, so they are structurally blind to what `app.getPath`
      // ("userData") resolves to by default, and `PACKAGED_EXE` keys off `productName`, not `app.name`.
      // Without `app.setName("Dulja Back Office")` in `main.ts` (0E T13), this reads whatever name the
      // packaged `package.json` carries: `dulja-back-office` today, measured by commenting the call
      // out, rebuilding and re-running (0E T13 review r2). `electron-builder.yml`'s
      // `extraMetadata.name`, added in the same round as this assertion, is what Electron's default
      // falls back to now.
      // (It was the raw Bun workspace name `@dulja/desktop` before that key existed, which Windows
      // resolved as two nested folders because `/` is a path separator there too.) Either way the
      // display string is lost, and with it the fatal-preload dialog's title and — via Electron's own
      // default `join(getPath("appData"), app.getName())` — the `%APPDATA%` folder
      // `docs/runbooks/clean-vm-install.md` and DoD 0.13's "token not on disk" clause both name. A
      // silent revert of that one line would break both without failing anywhere else.
      expect(await launch.app.evaluate(({ app }) => app.getName())).toBe("Dulja Back Office");
      const page = await launch.app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      expect(await page.evaluate(() => globalThis.location.origin)).toBe(APP_ORIGIN);
      expect(await page.evaluate(() => typeof globalThis.dulja)).toBe("object");
      expect(await page.evaluate(() => Object.keys(globalThis.dulja).toSorted())).toEqual([
        "app",
        "auth",
        "print",
      ]);
      expect(
        await page.evaluate(() => typeof (globalThis as Record<string, unknown>)["require"]),
      ).toBe("undefined");
    } finally {
      await launch.close();
    }
  });

  /**
   * Phase 4's smoke test: the packaged back office paints its sign-in screen under its own CSP, and a
   * sign-in reaches the backend the build was configured with, from the `dulja://app` origin, through
   * CORS. The build's hosts (`DULJA_SMOKE_HOSTS`, the `.invalid` placeholders by default) are mapped to a
   * local https stub with Chromium's own resolver switch, so the bundle under test is the shipped one,
   * unmodified. The stub's throwaway certificate is accepted for this launch only.
   */
  test("the packaged app paints sign-in and sends it to its configured backend", async () => {
    requirePackaged(PACKAGED_EXE);
    const stub = await startBackendStub();
    const hosts = (process.env["DULJA_SMOKE_HOSTS"] || "project.invalid,api.invalid")
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host !== "");
    const rules = hosts.map((host) => `MAP ${host} 127.0.0.1:${stub.port}`).join(",");
    const launch = await launchPackaged(launchEnv(), PACKAGED_EXE, [
      `--host-resolver-rules=${rules}`,
    ]);
    try {
      await launch.app.evaluate(({ session }) =>
        session.defaultSession.setCertificateVerifyProc((_request, callback) => callback(0)),
      );
      const page = await launch.app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      const email = page.locator('input[type="email"]');
      const password = page.locator('input[type="password"]');
      await expect(email).toBeVisible();
      await expect(password).toBeVisible();
      await email.fill("smoke@dulja.invalid");
      await password.fill("not-a-real-password");
      await page.locator('button[type="submit"]').first().click();
      expect(
        await eventually(() => stub.requests.some((r) => r.method === "POST")),
        `stub saw ${JSON.stringify(stub.requests.map((r) => `${r.method} ${r.path}`))}`,
      ).toBe(true);
      const post = stub.requests.find((r) => r.method === "POST")!;
      expect(post.headers.origin).toBe(APP_ORIGIN);
      // The app survived the refusal: still its own window, still on its own origin.
      expect(await page.evaluate(() => globalThis.location.origin)).toBe(APP_ORIGIN);
      // PRD-10: an update check against a placeholder or absent feed is a state, never a crash.
      const update = await page.evaluate(() => globalThis.dulja.app.checkForUpdates());
      expect(["up-to-date", "available", "error"]).toContain(update.state);
    } finally {
      await launch.close();
      await stub.close();
    }
  });
});
