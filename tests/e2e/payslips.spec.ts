import { readFileSync } from "node:fs";
import { formatDate } from "@dulja/i18n";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./support/people";

const catalogues = new URL("../../packages/i18n/catalogues/", import.meta.url);
const en = JSON.parse(readFileSync(new URL("en.json", catalogues), "utf8")) as Record<
  string,
  string
>;

/** Enter on a focused control — the keyboard path every step takes (spec:2254, "no mouse required"). */
async function press(page: Page, locator: Locator) {
  await locator.focus();
  await page.keyboard.press("Enter");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Acceptance test 23 on 8D Task 10's payslip, HR-report and permit screens (⚠️ OD-24, the owner-authorized default
 * baseline of 2026-11-07): the POSTED June run the stack seeds is opened from the payroll register, its payslips are
 * generated (one PDF per employee, each listed with its server-computed SHA-256) and one is downloaded by keyboard;
 * its register opens in 7A's report screen with the run filled in; the HR reports entry lists only `hr.*` codes; and
 * the permit-expiry list shows the permit the stack sealed a month out. English LTR and Arabic RTL. SYNTH figures.
 */
for (const locale of ["en", "ar"] as const) {
  test(`payslips, the HR report entry and permit expiry in ${locale}`, async ({
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
    await page.getByRole("link", { name: en["app.nav.payrollRuns"]! }).click();
    if (locale === "ar") await page.getByLabel(en["app.language"]!).selectOption("ar");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");

    // ── The posted June run, opened from the register by keyboard ──────────────────────────────────────────
    const register = page.getByRole("table", { name: say("payroll.list"), exact: true });
    const june = register.getByRole("cell", {
      name: new RegExp(escape(formatDate("2026-06-01", { locale }))),
    });
    await expect(june).toBeVisible();
    await june.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("payroll-status")).toHaveText(say("payroll.status.posted"));
    const documentId = new URL(page.url()).pathname.split("/").at(-1)!;

    // ── Payslips: generate in the screen's language, every employee ─────────────────────────────────────────
    const panel = page.getByRole("region", { name: say("payslip.title") });
    await expect(panel.getByLabel(say("payslip.lang"))).toHaveValue(locale);
    const generated = page.waitForResponse(
      (r) => r.url().endsWith("/payslips") && r.request().method() === "POST",
    );
    await press(page, panel.getByRole("button", { name: say("payslip.generate"), exact: true }));
    const answer = await generated;
    expect(answer.status()).toBe(201);
    expect(answer.request().postDataJSON()).toEqual({ lang: locale });
    const payslips = (await answer.json()) as {
      items: { employeeNumber: string; fileName: string; sha256: string }[];
    };
    expect(payslips.items.map((p) => p.employeeNumber)).toEqual(["E-0001", "E-0002"]);
    const grid = panel.getByRole("table", { name: say("payslip.list") });
    for (const p of payslips.items) {
      expect(p.fileName).toBe(`payslip-${p.employeeNumber}-2026-06-30-${locale}.pdf`);
      await expect(page.getByTestId(`payslip-hash-${p.employeeNumber}`)).toHaveText(p.sha256);
      await expect(grid.getByText(p.fileName)).toBeVisible();
    }
    // Phase 8 review: the payslips already on the run are listed too — this generation, and any earlier one (the
    // English run's files are on the run when the Arabic one opens it) — from 2C's list under hr.payroll.read.
    const earlier = panel.getByRole("table", { name: say("payslip.earlier") });
    const listed = (fileName: string) => earlier.getByText(fileName, { exact: true }).first();
    for (const p of payslips.items) await expect(listed(p.fileName)).toBeVisible();
    if (locale === "ar") await expect(listed("payslip-E-0001-2026-06-30-en.pdf")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const headers = await grid
      .locator("th")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
    expect(locale === "ar" ? headers[0]! > headers[2]! : headers[0]! < headers[2]!).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`payslips-${locale}.png`), fullPage: true });

    // Enter on a payslip's row downloads it, through the attachment door.
    const downloaded = page.waitForEvent("download");
    await grid.getByRole("cell", { name: "E-0001", exact: true }).focus();
    await page.keyboard.press("Enter");
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(payslips.items[0]!.fileName);

    // ── The run's register, in 7A's report screen, with the run filled in ──────────────────────────────────
    await press(page, panel.getByRole("link", { name: say("payslip.register") }));
    await expect(page).toHaveURL(/\/reports\/hr\.payroll_register/);
    await expect(
      page.getByLabel(
        say("report.param.required", { label: say("report.param.name.payrollDocumentId") }),
      ),
    ).toHaveValue(documentId);

    // ── The HR reports entry: 7A's list, narrowed to the hr module ─────────────────────────────────────────
    await page.getByRole("link", { name: say("app.nav.hrReports") }).click();
    const reports = page.getByRole("table", { name: say("report.list") });
    await expect(reports.getByText("hr.payroll_register", { exact: true })).toBeVisible();
    await expect(reports.getByText("hr.annual_statement", { exact: true })).toBeVisible();
    await expect(reports.getByText(/^accounting\./)).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`hr-reports-${locale}.png`),
      fullPage: true,
    });

    // ── Permit expiry: the permit sealed a month out, behind hr.employee.read_sensitive ────────────────────
    await page.getByRole("link", { name: say("app.nav.permitExpiry") }).click();
    const permits = page.getByRole("table", { name: say("permit.list") });
    await expect(permits.getByRole("cell", { name: "E-0002", exact: true })).toBeVisible();
    await expect(page.getByLabel(say("permit.within"))).toBeFocused();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`permit-expiry-${locale}.png`),
      fullPage: true,
    });
  });
}
