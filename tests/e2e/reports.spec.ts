import { readFileSync } from "node:fs";
import { formatDate } from "@dulja/i18n";
import { expect, test } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./support/people";

const catalogues = new URL("../../packages/i18n/catalogues/", import.meta.url);
const en = JSON.parse(readFileSync(new URL("en.json", catalogues), "utf8")) as Record<
  string,
  string
>;
const CODE = "accounting.trial_balance";

/**
 * Acceptance test 23 on 7A Task 15's screens (spec:106, spec:2253): the report list, the run screen and the
 * designer, driven by keyboard in English LTR and Arabic RTL against the local stack — a real report run
 * rendered by the worker's own handler, downloaded, and a core report cloned, edited, refused, saved and
 * archived through the designer.
 */
for (const locale of ["en", "ar"] as const) {
  test(`reports: list, run, download and design by keyboard in ${locale}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const messages = JSON.parse(
      readFileSync(new URL(`${locale}.json`, catalogues), "utf8"),
    ) as Record<string, string>;
    const say = (key: string, vars: Record<string, string> = {}) =>
      Object.entries(vars).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, value),
        messages[key]!,
      );
    await page.goto("/login");
    await page.getByLabel(en["auth.login.email"]!).fill(E2E_EMAIL);
    await page.getByLabel(en["auth.login.password"]!).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: en["auth.login.submit"]! }).click();
    await page.getByRole("link", { name: en["app.nav.users"]! }).click();
    await page.getByRole("link", { name: en["app.nav.reports"]!, exact: true }).click();
    if (locale === "ar") await page.getByLabel(en["app.language"]!).selectOption("ar");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(
      page.getByRole("heading", { name: say("report.title"), exact: true }),
    ).toBeVisible();

    // The list: "/" to the filter, narrow to the trial balance, Enter on its row runs it.
    const list = page.getByRole("table", { name: say("report.list"), exact: true });
    await expect(list.getByText(CODE, { exact: true })).toBeVisible();
    await list.getByText(CODE, { exact: true }).click();
    await page.keyboard.press("/");
    const filter = page.getByLabel(say("report.filter"));
    await expect(filter).toBeFocused();
    await filter.fill(CODE);
    await expect(list.locator("tbody tr")).toHaveCount(1);
    const listHeaders = await list
      .locator("th")
      .evaluateAll((elements) => elements.map((e) => e.getBoundingClientRect().x));
    expect(
      locale === "ar" ? listHeaders[0]! > listHeaders[2]! : listHeaders[0]! < listHeaders[2]!,
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`reports-list-${locale}.png`),
      fullPage: true,
    });
    await list.locator("tbody td").first().focus();
    await page.keyboard.press("Enter");

    // The run screen: the cursor starts in the first parameter.
    const name = locale === "ar" ? "ميزان المراجعة" : "Trial balance";
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    const period = page.getByLabel(
      say("report.param.required", { label: say("report.param.name.fiscalPeriodId") }),
    );
    await expect(period).toBeFocused();
    const january = formatDate("2026-01-01", { locale });
    const value = await period
      .locator("option")
      .evaluateAll(
        (options, prefix) =>
          (options as HTMLOptionElement[]).find((o) => o.label.startsWith(prefix))?.value ?? "",
        january,
      );
    expect(value).not.toBe("");
    await period.selectOption(value);
    const formats = page
      .getByRole("group", { name: say("report.run.formats") })
      .getByRole("button");
    const formatX = await formats.evaluateAll((elements) =>
      elements.map((e) => e.getBoundingClientRect().x),
    );
    expect(locale === "ar" ? formatX[0]! > formatX[2]! : formatX[0]! < formatX[2]!).toBe(true);
    await page.keyboard.press("Alt+3");
    const download = page.getByRole("button", {
      name: say("report.run.downloadAs", { format: say("report.format.csv") }),
    });
    await expect(download).toBeFocused({ timeout: 30_000 });
    await expect(
      page.getByRole("status").filter({ hasText: say("report.status.done") }),
    ).toBeVisible();
    const saved = page.waitForEvent("download");
    await page.keyboard.press("Enter");
    const file = await saved;
    expect(file.suggestedFilename()).toMatch(new RegExp(`^${CODE}-[0-9a-f-]{36}\\.csv$`));
    const csv = readFileSync(await file.path(), "utf8");
    // The run carries the screen's language: the column headings are the definition's own for it.
    expect(csv).toContain(locale === "ar" ? "الحساب" : "Account");
    expect(csv).toContain("1200");
    const recent = page.getByRole("table", { name: say("report.run.recent"), exact: true });
    await expect(
      recent.getByText(say("report.status.done"), { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`reports-run-${locale}.png`),
      fullPage: true,
    });

    // Back to the list (Esc), and Shift+Enter opens the row in the designer.
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: say("report.title"), exact: true }),
    ).toBeVisible();
    await page.getByLabel(say("report.filter")).fill(CODE);
    await expect(list.locator("tbody tr")).toHaveCount(1);
    await list.locator("tbody td").first().focus();
    await page.keyboard.press("Shift+Enter");
    const clone = page.getByRole("button", { name: say("report.designer.clone") });
    await expect(clone).toBeFocused();
    await expect(page.getByText(say("report.designer.coreReadOnly"))).toBeVisible();
    await page.keyboard.press("Enter");

    // The copy: retitle it, refuse a width the format forbids, correct it, save, archive.
    const title = page.getByLabel(say("report.designer.nameEn"));
    await expect(title).toBeFocused();
    await title.fill(`Trial balance copy ${locale}`);
    const firstColumn = page.locator("fieldset[data-column='0']");
    const width = firstColumn.getByLabel(say("report.designer.width"));
    await width.fill("5");
    await page.keyboard.press("Control+s");
    await expect(width).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert").first()).toContainText(
      say("problem.ERR_VALIDATION_FAILED.title"),
    );
    await page.screenshot({
      path: testInfo.outputPath(`reports-design-${locale}.png`),
      fullPage: true,
    });
    await width.fill("120");
    await page.keyboard.press("Control+s");
    await expect(page.getByText(say("report.designer.saved"))).toBeVisible();
    await expect(width).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: say("report.designer.archive") }).click();
    await page.getByRole("button", { name: say("report.designer.confirmArchive") }).click();
    await expect(
      page.getByRole("heading", { name: say("report.title"), exact: true }),
    ).toBeVisible();
    await expect(list.getByText(say("report.kind.copy"))).toHaveCount(0);
  });
}
