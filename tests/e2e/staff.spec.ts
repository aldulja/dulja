import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./support/people";

const catalogues = new URL("../../packages/i18n/catalogues/", import.meta.url);
const english = JSON.parse(readFileSync(new URL("en.json", catalogues), "utf8")) as Record<
  string,
  string
>;
for (const locale of ["en", "ar"] as const) {
  test(`staff, cashier PIN and branch limits: keyboard and ${locale} layout`, async ({
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
    await page.getByRole("link", { name: english["app.nav.staff"]! }).click();
    if (locale === "ar") await page.getByLabel(english["app.language"]!).selectOption("ar");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const createEmployee = page.getByRole("button", {
      name: say("staff.createEmployee"),
      exact: true,
    });
    await createEmployee.focus();
    await page.keyboard.press("Enter");
    const employeeForm = page.getByRole("form", { name: say("staff.createEmployee") });
    await expect(employeeForm.getByLabel(say("staff.employeeNumber"))).toBeFocused();
    const employeeNumber = `E2E-STAFF-${locale}`;
    await employeeForm.getByLabel(say("staff.employeeNumber")).fill(employeeNumber);
    await employeeForm.getByLabel(say("staff.nameEn")).fill(`Browser staff ${locale}`);
    await employeeForm.getByLabel(say("staff.nameAr")).fill("موظف المتصفح");
    await employeeForm.getByLabel(say("staff.hiredOn")).fill("2026-01-01");
    await employeeForm.getByRole("button", { name: say("staff.save"), exact: true }).focus();
    await page.keyboard.press("Enter");
    const cell = page.getByRole("cell", { name: employeeNumber, exact: true });
    await expect(cell).toBeVisible();
    await cell.focus();
    await page.keyboard.press("/");
    await expect(page.getByLabel(say("staff.search"))).toBeFocused();
    await page.getByLabel(say("staff.search")).fill(employeeNumber);
    await cell.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: say("staff.close") })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(cell).toBeFocused();
    const headers = await page
      .getByRole("table", { name: say("staff.employees"), exact: true })
      .locator("th")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
    expect(locale === "ar" ? headers[0]! > headers[3]! : headers[0]! < headers[3]!).toBe(true);

    await page.screenshot({ path: testInfo.outputPath(`employees-${locale}.png`), fullPage: true });
    await page.getByRole("link", { name: say("app.nav.cashiers") }).click();
    const createCashier = page.getByRole("button", {
      name: say("staff.createCashier"),
      exact: true,
    });
    await expect(createCashier).toBeEnabled();
    await createCashier.focus();
    await page.keyboard.press("Enter");
    const credentialForm = page.getByRole("form", { name: say("staff.createCashier") });
    await credentialForm
      .getByLabel(say("staff.employeeNumber"))
      .selectOption({ label: employeeNumber });
    await credentialForm.getByLabel(say("staff.email")).fill(`staff-${locale}@example.invalid`);
    await credentialForm.getByLabel(say("staff.displayName")).fill(`Browser cashier ${locale}`);
    const pin = credentialForm.getByLabel(say("staff.pin"));
    await expect(pin).toHaveValue("");
    await pin.fill("1234");
    await page.keyboard.press("Tab");
    await expect(pin).toHaveValue("");
    await pin.fill("5678");
    await page.keyboard.press("Enter");
    const cashierCell = page.getByRole("cell", { name: employeeNumber, exact: true });
    await expect(cashierCell).toBeVisible();
    await cashierCell.focus();
    await page.keyboard.press("Enter");
    const resetForm = page.getByRole("form", { name: say("staff.resetPin") });
    await expect(resetForm.getByLabel(say("staff.pin"))).toHaveValue("");
    await page.screenshot({ path: testInfo.outputPath(`cashiers-${locale}.png`), fullPage: true });
    await resetForm.getByLabel(say("staff.pin")).fill("9012");
    await page.keyboard.press("Enter");
    await expect(resetForm).toHaveCount(0);

    await page.getByRole("link", { name: say("app.nav.branchLimits") }).click();
    const limit = page.getByLabel(say("staff.limit.maxLineDiscountPct"));
    await expect(limit).toBeVisible();
    await limit.fill("10");
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes("branch-pos-policies") && response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: say("staff.save"), exact: true }).focus();
    await page.keyboard.press("Enter");
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON().maxLineDiscountPct).toBe("0.100000");
    await expect(limit).toHaveValue("10.0000");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`staff-${locale}.png`), fullPage: true });
  });
}
