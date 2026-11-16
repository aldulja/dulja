import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { CATALOGUES, type Locale, type TranslationKey } from "@dulja/i18n";
import { BACKOFFICE_START_PATH, browserWindowOptions } from "../../apps/desktop/src/window-options";
import { serveRenderer, type ServedRenderer } from "./support/renderer-server";

/**
 * `backoffice.exe` serves `apps/backoffice/dist` from `dulja://app` under `CONTENT_SECURITY_POLICY`
 * (`apps/desktop/src/main.ts`), whose `script-src 'self'` has no `'unsafe-eval'`. The rest of this suite serves
 * the same bundle with no policy at all, so it stayed green while the packaged window painted nothing: Ajv
 * compiled `@dulja/domain`'s validators with `new Function` at import, and the refusal threw before React
 * mounted. This serves the bundle the global setup built through the desktop's own request resolver, under
 * the desktop's own policy, and requires the sign-in screen to render in both languages with no page error
 * and no policy violation.
 */

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const say = (locale: Locale, key: TranslationKey): string => {
  const found = CATALOGUES[locale][key];
  if (found === undefined) throw new Error(`no ${locale} string for ${key}`);
  return found;
};
const { width, height } = browserWindowOptions("");
test.use({ viewport: { width: width!, height: height! } });

let served: ServedRenderer | undefined;

test.beforeAll(async () => {
  served = await serveRenderer(join(ROOT, "apps", "backoffice", "dist"), "backoffice");
});

test.afterAll(async () => {
  await served?.close();
});

test("the back office renders under the desktop's content security policy", async ({ page }) => {
  const faults: string[] = [];
  page.on("pageerror", (error) => faults.push(`pageerror: ${error.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { duljaCspViolations?: string[] }).duljaCspViolations ??= [];
      (window as unknown as { duljaCspViolations: string[] }).duljaCspViolations.push(
        `${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  // The path `main.ts` opens, so a change back to `/index.html` (the router's "Not Found") fails here.
  await page.goto(`${served!.origin}${BACKOFFICE_START_PATH}`);
  await expect(page.getByRole("heading", { name: say("en", "auth.login.title") })).toBeVisible();
  await expect(page.getByLabel(say("en", "auth.login.email"))).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  await page.getByLabel(say("en", "app.language")).selectOption("ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: say("ar", "auth.login.title") })).toBeVisible();
  await expect(page.getByLabel(say("ar", "auth.login.password"))).toBeVisible();

  const violations = await page.evaluate(
    () => (window as unknown as { duljaCspViolations?: string[] }).duljaCspViolations ?? [],
  );
  expect(faults).toEqual([]);
  expect(violations).toEqual([]);
});
