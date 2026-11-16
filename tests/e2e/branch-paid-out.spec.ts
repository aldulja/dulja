import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./support/people";

/**
 * UI-05 (OD-10, `docs/owner/od-10/decision.md`): paid-outs are the branch's own setting, set in the back office.
 * Through the real API: switch them on with a maximum, keyboard only, and read both back after a reload.
 */
const catalogues = new URL("../../packages/i18n/catalogues/", import.meta.url);
const english = JSON.parse(readFileSync(new URL("en.json", catalogues), "utf8")) as Record<
  string,
  string
>;
for (const [locale, maximum] of [
  ["en", "200"],
  ["ar", "150.5"],
] as const) {
  test(`branch paid-out settings round-trip: keyboard and ${locale} layout`, async ({
    page,
  }, testInfo) => {
    const messages = JSON.parse(
      readFileSync(new URL(`${locale}.json`, catalogues), "utf8"),
    ) as Record<string, string>;
    const say = (key: string) => messages[key]!;
    await page.goto("/login");
    await page.getByLabel(english["auth.login.email"]!).fill(E2E_EMAIL);
    await page.getByLabel(english["auth.login.password"]!).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: english["auth.login.submit"]! }).click();
    await page.getByRole("link", { name: english["app.nav.users"]! }).click();
    if (locale === "ar") await page.getByLabel(english["app.language"]!).selectOption("ar");
    await page.getByRole("link", { name: say("app.nav.branchLimits") }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");

    const allowed = page.getByRole("checkbox", { name: say("staff.paidOutAllowed") });
    const amount = page.getByLabel(say("staff.limit.maxPaidOutAmount"));
    await expect(amount).toBeVisible();
    if (!(await allowed.isChecked())) {
      await allowed.focus();
      await page.keyboard.press("Space");
    }
    await expect(allowed).toBeChecked();
    await amount.focus();
    await amount.fill(maximum);
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes("branch-pos-policies") && response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: say("staff.save"), exact: true }).focus();
    await page.keyboard.press("Enter");
    const response = await saved;
    expect(response.status()).toBe(200);
    const sent = response.request().postDataJSON() as Record<string, unknown>;
    expect(sent.paidOutAllowed).toBe(true);
    const wire = maximum.includes(".")
      ? `${maximum.padEnd(maximum.indexOf(".") + 5, "0")}`
      : `${maximum}.0000`;
    expect(sent.maxPaidOutAmount).toBe(wire);
    const stored = (await response.json()) as Record<string, unknown>;
    expect(stored.paidOutAllowed).toBe(true);
    expect(stored.maxPaidOutAmount).toBe(wire);
    await expect(page.getByRole("alert")).toHaveCount(0);

    // The chosen language is kept across the reload, so the screen comes back in it.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(page.getByLabel(say("staff.limit.maxPaidOutAmount"))).toHaveValue(wire);
    await expect(page.getByRole("checkbox", { name: say("staff.paidOutAllowed") })).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath(`paid-out-${locale}.png`), fullPage: true });
  });
}
