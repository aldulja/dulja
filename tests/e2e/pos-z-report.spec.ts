import { readFileSync } from "node:fs";
import { formatMoney } from "@dulja/i18n";
import { expect, test } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./support/people";
const catalogues = new URL("../../packages/i18n/catalogues/", import.meta.url);
const english = JSON.parse(readFileSync(new URL("en.json", catalogues), "utf8")) as Record<
  string,
  string
>;
for (const locale of ["en", "ar"] as const) {
  test(`shift register, Z-report and print are keyboard accessible in ${locale}`, async ({
    page,
  }, testInfo) => {
    const labels = JSON.parse(
      readFileSync(new URL(`${locale}.json`, catalogues), "utf8"),
    ) as Record<string, string>;
    const say = (key: string) => labels[key]!;
    // The currency's display rounding, per locale: "MYR 100.00" in English, "100.00 MYR" in Arabic.
    const money = (amount: string) => formatMoney({ amount, currency: "MYR" }, { locale });
    await page.goto("/login");
    await page.getByLabel(english["auth.login.email"]!).fill(E2E_EMAIL);
    await page.getByLabel(english["auth.login.password"]!).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: english["auth.login.submit"]! }).click();
    await page.getByRole("link", { name: english["app.nav.users"]! }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("link", { name: english["shift.title"]! }).focus();
    await page.keyboard.press("Enter");
    if (locale === "ar") await page.getByLabel(english["app.language"]!).selectOption("ar");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const register = page.getByRole("table", { name: say("shift.title"), exact: true });
    await expect(register.getByRole("button", { name: "BROWSER-TILL", exact: true })).toBeVisible();

    // Reach the Z-report with the keyboard alone: Tab into the register's single tab stop — past the
    // filters, whose date inputs take a Tab per field — then Enter (spec:2254).
    const firstCell = register.locator('td[data-cell="0:0"]');
    for (let presses = 0; presses < 60; presses += 1) {
      if (await firstCell.evaluate((cell) => cell === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(firstCell).toBeFocused();
    await page.keyboard.press("Enter");
    const report = page.getByRole("article", { name: say("shift.zReport") });
    await expect(report).toBeVisible();
    await expect(page).toHaveURL(/\/pos\/shifts\/[0-9a-f-]{36}\/z-report\?company=/);
    await expect(report.getByText(money("100.0000")).first()).toBeVisible();
    // The fixture's count was exact, so the over/short is there, untoned.
    await expect(report.locator("[data-tone]")).toHaveAttribute("data-tone", "none");
    await expect(
      report.getByRole("cell", { name: say("shift.no_sale"), exact: true }),
    ).toBeVisible();

    // Column order follows the reading direction, and an amount sits on the reader's END side — the
    // right in English, the left in Arabic — because `align: "end"` reaches the cell as a logical
    // property (test 23, spec:2441).
    const headers = await register
      .locator("th")
      .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().x));
    expect(headers[0]! < headers[1]!).toBe(locale === "en");
    const counted = register.locator('td[data-cell="0:4"]');
    await expect(counted).toHaveText(money("100.0000"));
    await expect(counted).toHaveCSS("text-align", "end");
    const gap = await counted.evaluate((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      const text = range.getBoundingClientRect();
      const box = cell.getBoundingClientRect();
      return { left: text.left - box.left, right: box.right - text.right };
    });
    const [end, start] = locale === "en" ? [gap.right, gap.left] : [gap.left, gap.right];
    expect(end).toBeLessThan(2);
    expect(start).toBeGreaterThan(end);

    await page.screenshot({ path: testInfo.outputPath(`shifts-${locale}.png`), fullPage: true });
    await report.getByRole("button", { name: say("shift.print") }).focus();
    await expect(report.getByRole("button", { name: say("shift.print") })).toBeFocused();
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("navigation")).toBeHidden();
    // The page is the report: neither the company picker nor the register above it prints.
    await expect(page.getByLabel(say("staff.company"), { exact: true })).toBeHidden();
    await expect(page.getByRole("heading", { name: say("shift.title"), exact: true })).toBeHidden();
    await expect(report.getByRole("heading", { name: say("shift.zReport") })).toBeVisible();
    // The drawer-control counts are on the paper a manager signs; the per-event list is not.
    const counts = report.getByRole("list", { name: say("shift.eventCounts") });
    await expect(counts).toBeVisible();
    await expect(counts).toHaveText(`${say("shift.no_sale")}: 1`);
    await expect(report.getByRole("table", { name: say("shift.events") })).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath(`z-report-print-${locale}.png`),
      fullPage: true,
    });
    await page.emulateMedia({ media: "screen" });

    // Esc closes the report and returns focus to the row it was opened from; "/" then jumps to the
    // filter.
    await page.keyboard.press("Escape");
    await expect(report).toBeHidden();
    await expect(page).toHaveURL(/\/pos\/shifts$/);
    await expect(firstCell).toBeFocused();
    await page.keyboard.press("/");
    await expect(page.getByLabel(say("staff.branch"), { exact: true })).toBeFocused();

    await page.getByLabel(say("shift.view")).selectOption("sales");
    await expect(page.getByRole("table", { name: say("shift.sales"), exact: true })).toBeVisible();
    await page.getByLabel(say("shift.from")).fill("");
    await expect(page.getByText(say("shift.chooseDates"), { exact: true })).toBeVisible();

    // Esc popped the report's history entry instead of pushing the register again, so the browser's
    // back now leaves the screen rather than reopening the report the operator just closed.
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/users$/);
  });
}
