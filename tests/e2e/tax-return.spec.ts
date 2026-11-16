import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./support/people";

const catalogues = new URL("../../packages/i18n/catalogues/", import.meta.url);
const en = JSON.parse(readFileSync(new URL("en.json", catalogues), "utf8")) as Record<
  string,
  string
>;

for (const locale of ["en", "ar"] as const) {
  test(`tax return: keyboard workflow, ledger reconciliation and ${locale} layout`, async ({
    page,
  }, testInfo) => {
    const messages = JSON.parse(
      readFileSync(new URL(`${locale}.json`, catalogues), "utf8"),
    ) as Record<string, string>;
    const say = (key: string) => messages[key]!;
    await page.goto("/login");
    await page.getByLabel(en["auth.login.email"]!).fill(E2E_EMAIL);
    await page.getByLabel(en["auth.login.password"]!).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: en["auth.login.submit"]! }).click();
    await page.getByRole("link", { name: en["app.nav.users"]! }).click();
    await page.getByRole("link", { name: en["app.nav.taxReturns"]! }).click();
    if (locale === "ar") await page.getByLabel(en["app.language"]!).selectOption("ar");
    await expect(page.getByRole("heading", { name: say("tax.title"), exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await page.keyboard.press("Control+n");
    await expect(page.getByLabel(say("tax.start"))).toBeFocused();
    await page.getByLabel(say("tax.regime")).selectOption("SYNTH-MY-v1:1");
    // Separate complete fiscal quarters each include one seeded invoice.
    await page.getByLabel(say("tax.start")).fill(locale === "en" ? "2026-01-01" : "2026-04-01");
    await page.getByLabel(say("tax.end")).fill(locale === "en" ? "2026-03-31" : "2026-06-30");
    await page.keyboard.press("Control+s");
    const generate = page.getByRole("button", { name: say("tax.generate") });
    await expect(generate).toBeEnabled();
    await page.keyboard.press("Control+g");
    const boxes = page.getByRole("table", { name: say("tax.boxes"), exact: true });
    await expect(boxes.locator("tbody tr")).toHaveCount(5);
    for (const code of ["S1", "S2", "S3", "P1", "P2"])
      await expect(boxes.getByRole("cell", { name: code, exact: true })).toBeVisible();
    await expect(
      boxes.locator("tbody tr").filter({ hasText: "S2" }).locator("td").last(),
    ).toContainText("110.0000");
    const reconciliation = page.getByTestId("tax-reconciliation");
    await expect(reconciliation.locator("tbody tr")).toHaveCount(2);
    const output = reconciliation.locator("tbody tr").filter({ hasText: "2300" });
    await expect(output.locator("td").nth(0)).toContainText("110.0000");
    await expect(output.locator("td").nth(1)).toContainText("110.0000");
    await expect(output.locator("td").last()).toContainText("0.0000");
    await expect(reconciliation.getByText(say("tax.mismatch"))).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    // Logical column order mirrors, while numeric runs retain their own reading direction.
    const headers = await boxes
      .locator("th")
      .evaluateAll((elements) => elements.map((e) => e.getBoundingClientRect().x));
    expect(headers).toHaveLength(3);
    expect(locale === "ar" ? headers[0]! > headers[2]! : headers[0]! < headers[2]!).toBe(true);
    const cell = output.locator("td").last();
    const alignment = await cell.evaluate((e) => {
      const run = e.querySelector("bdi")!;
      const range = document.createRange();
      range.selectNodeContents(run);
      const bounds = range.getBoundingClientRect();
      const box = e.getBoundingClientRect();
      return {
        direction: getComputedStyle(run).direction,
        startGap: bounds.left - box.left,
        endGap: box.right - bounds.right,
      };
    });
    expect(alignment.direction).toBe("ltr");
    expect(locale === "ar" ? alignment.startGap : alignment.endGap).toBeLessThan(2);
    const screenshot = testInfo.outputPath(`tax-return-${locale}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    // A partial fiscal period is refused through the same screen, with translated remedy chrome.
    await page.keyboard.press("Control+n");
    await page.getByLabel(say("tax.regime")).selectOption("SYNTH-MY-v1:1");
    await page.getByLabel(say("tax.start")).fill("2026-07-02");
    await page.getByLabel(say("tax.end")).fill("2026-09-30");
    await page.keyboard.press("Control+s");
    const error = page.getByRole("alert");
    await expect(error).toContainText(say("problem.ERR_POLICY_REQUIRES_MISSING.title"));
    await expect(error).toContainText(say("problem.ERR_POLICY_REQUIRES_MISSING.remedy"));
    await expect(page.getByRole("button", { name: say("tax.create") })).toBeEnabled();
    await testInfo.attach(`tax-return-${locale}`, { path: screenshot, contentType: "image/png" });
  });
}
