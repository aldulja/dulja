import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { E2E_EMAIL, E2E_HR_EMPLOYEE, E2E_PASSWORD } from "./support/people";

const catalogues = new URL("../../packages/i18n/catalogues/", import.meta.url);
const en = JSON.parse(readFileSync(new URL("en.json", catalogues), "utf8")) as Record<
  string,
  string
>;

/** Enter on a focused control — the keyboard path every step takes (spec:2254, "no mouse required"). */
async function press(page: Page, locator: ReturnType<Page["getByRole"]>) {
  await locator.focus();
  await page.keyboard.press("Enter");
}

/**
 * Acceptance test 23 on 8A Task 13's HR screens (⚠️ OD-24, the owner-authorized default baseline of 2026-11-07):
 * a pay component created, an employee's identity details, statutory profile and compensation entered, a rate
 * table verified by a principal who did not load it and refused — with the rule named — to the one who did, and the
 * company's HR settings saved, all by keyboard, in English LTR and Arabic RTL.
 */
for (const locale of ["en", "ar"] as const) {
  test(`HR screens: pay components, HR record, statutory tables and settings in ${locale}`, async ({
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
    const tag = locale.toUpperCase();
    await page.goto("/login");
    await page.getByLabel(en["auth.login.email"]!).fill(E2E_EMAIL);
    await page.getByLabel(en["auth.login.password"]!).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: en["auth.login.submit"]! }).click();
    await page.getByRole("link", { name: en["app.nav.users"]! }).click();
    await page.getByRole("link", { name: en["app.nav.payComponents"]! }).click();
    if (locale === "ar") await page.getByLabel(en["app.language"]!).selectOption("ar");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");

    // ── Pay components: kind is a radio of two; the new component is the one compensation will name ──────────
    const code = `E2E-PAY-${tag}`;
    await press(page, page.getByRole("button", { name: say("hr.payComponent.new"), exact: true }));
    const create = page.getByRole("form", { name: say("hr.payComponent.new") });
    await expect(create.getByLabel(say("hr.payComponent.code"))).toBeFocused();
    await expect(create.getByRole("radio")).toHaveCount(2);
    await create.getByLabel(say("hr.payComponent.code")).fill(code);
    await create.getByLabel(say("staff.nameEn")).fill(`Browser basic ${locale}`);
    await press(page, create.getByRole("button", { name: say("staff.save"), exact: true }));
    const componentCell = page.getByRole("cell", { name: code, exact: true });
    await expect(componentCell).toBeVisible();
    const headers = await page
      .getByRole("table", { name: say("hr.payComponent.title"), exact: true })
      .locator("th")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
    expect(locale === "ar" ? headers[0]! > headers[2]! : headers[0]! < headers[2]!).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`pay-components-${locale}.png`),
      fullPage: true,
    });

    // ── The employee's HR record, opened from the 6C directory ──────────────────────────────────────────────
    await page.getByRole("link", { name: say("app.nav.staff") }).click();
    const employeeCell = page.getByRole("cell", { name: E2E_HR_EMPLOYEE, exact: true });
    await expect(employeeCell).toBeVisible();
    await employeeCell.focus();
    await page.keyboard.press("Enter");
    await press(page, page.getByRole("link", { name: say("hr.record.open") }));
    await expect(
      page.getByRole("heading", { name: say("hr.record.heading", { number: E2E_HR_EMPLOYEE }) }),
    ).toBeVisible();

    const identity = page.getByRole("form", { name: say("hr.sensitive.title") });
    await identity.getByLabel(say("hr.sensitive.field.nationalId")).fill(`SYNTHETIC-ID-${tag}`);
    await identity.getByLabel(say("hr.sensitive.field.bankAccount")).fill(`SYNTHETIC-ACC-${tag}`);
    const sensitiveSaved = page.waitForResponse(
      (response) => response.url().endsWith("/sensitive") && response.request().method() === "PUT",
    );
    await press(page, identity.getByRole("button", { name: say("hr.sensitive.save") }));
    expect((await sensitiveSaved).status()).toBe(200);
    await expect(identity.getByText(say("hr.saved"))).toBeVisible();
    await expect(identity.getByLabel(say("hr.sensitive.field.nationalId"))).toHaveValue(
      `SYNTHETIC-ID-${tag}`,
    );

    await press(page, page.getByRole("button", { name: say("hr.profile.new") }));
    const profile = page.getByRole("form", { name: say("hr.profile.new") });
    await expect(profile.getByLabel(say("hr.effectiveFrom"))).toBeFocused();
    await profile
      .getByLabel(say("hr.effectiveFrom"))
      .fill(locale === "en" ? "2026-01-01" : "2026-02-01");
    await profile.getByLabel(say("hr.profile.maritalStatus")).fill(`synthetic-${locale}`);
    await press(page, profile.getByRole("button", { name: say("hr.profile.save") }));
    await expect(profile).toHaveCount(0);
    await expect(
      page.getByRole("cell", { name: `synthetic-${locale}`, exact: true }),
    ).toBeVisible();

    await press(page, page.getByRole("button", { name: say("hr.compensation.new") }));
    const line = page.getByRole("form", { name: say("hr.compensation.new") });
    await expect(line.getByText(say("hr.compensation.closesHint"))).toBeVisible();
    await line.getByLabel(say("hr.compensation.component")).selectOption({
      label: `${code} — Browser basic ${locale}`,
    });
    await line.getByLabel(say("hr.effectiveFrom")).fill("2026-03-01");
    await line.getByLabel(say("hr.compensation.amountIn", { currency: "MYR" })).fill("2500");
    const lineSaved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/compensation-lines") && response.request().method() === "POST",
    );
    await press(page, line.getByRole("button", { name: say("hr.compensation.save") }));
    const posted = await lineSaved;
    expect(posted.status()).toBe(201);
    expect(posted.request().postDataJSON()).toMatchObject({
      effectiveFrom: "2026-03-01",
      amount: { amount: "2500.0000", currency: "MYR" },
    });
    await expect(line).toHaveCount(0);
    const compensation = page.getByRole("table", {
      name: say("hr.compensation.title"),
      exact: true,
    });
    await expect(compensation.getByText(code, { exact: false })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`hr-record-${locale}.png`), fullPage: true });

    // ── Statutory tables: verify what someone else loaded; be refused, with the rule named, on your own ─────
    await page.getByRole("link", { name: say("app.nav.statutoryTables") }).click();
    const schemeCell = page.getByRole("cell", { name: "SYNTH", exact: true });
    await expect(schemeCell).toBeVisible();
    await schemeCell.focus();
    await page.keyboard.press("Enter");
    const tables = page.getByRole("table", { name: say("hr.rateTable.title"), exact: true });
    const theirs = locale === "en" ? 1 : 2;
    const versionCell = tables.getByRole("cell", { name: String(theirs), exact: true });
    await versionCell.focus();
    await page.keyboard.press("Enter");
    const verify = page.getByRole("button", { name: say("hr.rateTable.verify") });
    await expect(verify).toBeEnabled();
    const definition = JSON.parse(
      (await page.getByTestId("rate-table-definition").textContent())!,
    ) as Record<string, unknown>;
    const verified = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/rate-tables/${theirs}/verify`) &&
        response.request().method() === "POST",
    );
    await press(page, verify);
    expect((await verified).status()).toBe(200);
    // Verified: the button is gone and the version's row says so.
    await expect(verify).toHaveCount(0);
    await expect(
      tables
        .getByRole("row")
        .filter({ has: page.getByRole("cell", { name: String(theirs), exact: true }) })
        .getByRole("cell", { name: say("hr.rateTable.verified"), exact: true }),
    ).toBeVisible();

    const mine = locale === "en" ? 3 : 4;
    const area = page.getByLabel(say("hr.rateTable.definitionField"));
    await area.fill(JSON.stringify({ ...definition, version: mine }));
    await area.focus();
    await page.keyboard.press("Control+Enter");
    await expect(
      page.getByRole("heading", {
        name: say("hr.rateTable.detailHeading", { version: String(mine) }),
      }),
    ).toBeVisible();
    const own = page.getByRole("button", { name: say("hr.rateTable.verify") });
    await expect(own).toBeDisabled();
    await expect(page.getByText(say("hr.rateTable.ownLoad"))).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`statutory-tables-${locale}.png`),
      fullPage: true,
    });

    // ── HR settings (⚠️ OD-23): the rule, the pay day and a synthetic registration ───────────────────────────
    await page.getByRole("link", { name: say("app.nav.hrSettings") }).click();
    const settings = page.getByRole("form", { name: say("hr.settings.title") });
    await settings.getByLabel(say("hr.settings.prorationRule")).selectOption("working_days");
    await settings.getByLabel(say("hr.settings.payDay")).fill("25");
    await settings
      .getByLabel(say("hr.settings.registrationFor", { code: "SYNTH" }))
      .fill(`SYNTHETIC-REG-${tag}`);
    const stored = page.waitForResponse(
      (response) =>
        response.url().endsWith("/hr-settings") && response.request().method() === "PUT",
    );
    await press(page, settings.getByRole("button", { name: say("staff.save"), exact: true }));
    const answer = await stored;
    expect(answer.status()).toBe(200);
    expect(await answer.json()).toMatchObject({
      prorationRule: "working_days",
      payDay: 25,
      // 8B T15 seeds the payroll corpus's EPF scheme beside SYNTH; its registration stays unsupplied.
      employerRegistrations: expect.arrayContaining([
        { schemeId: expect.any(String), schemeCode: "SYNTH", registration: `SYNTHETIC-REG-${tag}` },
      ]),
    });
    await expect(settings.getByText(say("hr.saved"))).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`hr-settings-${locale}.png`),
      fullPage: true,
    });
  });
}
