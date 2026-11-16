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

/**
 * Acceptance test 23 on 8B Task 15's payroll screens (⚠️ OD-24, the owner-authorized default baseline of
 * 2026-11-07): a run ANOTHER principal prepared and submitted is opened from the register, its compensation-change
 * list read, approved and posted through 2B's shared transitions; then the operator calculates a supplementary run
 * of its own, records a manual statutory override with a reason (flagged and listed), submits it — and is refused
 * approving it by R1, the database's answer. All by keyboard, in English LTR and Arabic RTL. Figures are SYNTH's.
 */
for (const locale of ["en", "ar"] as const) {
  test(`payroll: approve and post, then prepare, override and be refused self-approval in ${locale}`, async ({
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

    // ── The register: the seeded run of this locale's month, opened by keyboard ─────────────────────────────
    const register = page.getByRole("table", { name: say("payroll.list"), exact: true });
    const seeded = locale === "en" ? "2026-01-01" : "2026-02-01";
    const seededCell = register.getByRole("cell", {
      name: new RegExp(formatDate(seeded, { locale }).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    });
    await expect(seededCell).toBeVisible();
    const headers = await register
      .locator("th")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
    expect(locale === "ar" ? headers[0]! > headers[2]! : headers[0]! < headers[2]!).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`payroll-runs-${locale}.png`),
      fullPage: true,
    });
    await seededCell.focus();
    await page.keyboard.press("Enter");

    const approval = page.getByTestId("payroll-approval");
    await expect(approval).toBeVisible();
    await expect(page.getByTestId("payroll-status")).toHaveText(say("payroll.status.submitted"));
    // spec:2174 R3 — who changed compensation in the period, shown to an approver: the fixture's lines (January),
    // the seeded change to E-0002 (February).
    const changes = page.getByTestId("compensation-changed-by");
    await expect(changes.getByText(locale === "en" ? /E-0001/ : /E-0002/)).toBeVisible();
    await expect(
      page.getByText(say("payroll.pinnedVersion", { scheme: "EPF", version: "1" })),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`payroll-approval-${locale}.png`),
      fullPage: true,
    });

    const approved = page.waitForResponse(
      (r) => r.url().endsWith("/transitions") && r.request().method() === "POST",
    );
    await press(page, page.getByRole("button", { name: say("payroll.approve"), exact: true }));
    expect((await approved).status()).toBe(200);
    await expect(page.getByTestId("payroll-status")).toHaveText(say("payroll.status.approved"));
    const posted = page.waitForResponse(
      (r) => r.url().endsWith("/transitions") && r.request().method() === "POST",
    );
    await press(page, page.getByRole("button", { name: say("payroll.post"), exact: true }));
    const postAnswer = await posted;
    expect(postAnswer.status()).toBe(200);
    expect(
      ((await postAnswer.json()) as { ledgerEntryIds: string[] }).ledgerEntryIds.length,
    ).toBeGreaterThan(0);
    await expect(page.getByTestId("payroll-status")).toHaveText(say("payroll.status.posted"));
    await expect(page.getByText(say("payroll.postedHint"))).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);

    // ── A run of the operator's own: calculate, override with a reason, submit, be refused approving it ────
    await press(page, page.getByRole("link", { name: say("payroll.back") }));
    await press(page, page.getByRole("button", { name: say("payroll.new"), exact: true }));
    const create = page.getByRole("form", { name: say("payroll.new") });
    const kind = create.getByRole("combobox", { name: say("payroll.kind"), exact: true });
    await expect(kind).toBeFocused();
    await kind.selectOption("supplementary");
    const [start, end, pay] =
      locale === "en"
        ? ["2026-03-01", "2026-03-31", "2026-04-05"]
        : ["2026-04-01", "2026-04-30", "2026-05-05"];
    await create.getByLabel(say("payroll.periodStart")).fill(start);
    await create.getByLabel(say("payroll.periodEnd")).fill(end);
    await create.getByLabel(say("payroll.payDate")).fill(pay);
    await create.getByLabel(say("payroll.effectiveDate")).fill(end);
    const employee = create.getByLabel("E-0001", { exact: true });
    await employee.focus();
    await page.keyboard.press("Space");
    await expect(employee).toBeChecked();
    const created = page.waitForResponse(
      (r) => r.url().endsWith("/payroll-runs") && r.request().method() === "POST",
    );
    await press(page, create.getByRole("button", { name: say("payroll.calculate") }));
    const createAnswer = await created;
    expect(createAnswer.status()).toBe(201);
    expect(createAnswer.request().postDataJSON()).toMatchObject({
      kind: "supplementary",
      periodStart: start,
    });
    await expect(page.getByTestId("payroll-status")).toHaveText(say("payroll.status.draft"));

    await press(page, page.getByRole("button", { name: say("payroll.override.new") }));
    const override = page.getByRole("form", { name: say("payroll.override.new") });
    await expect(
      override.getByRole("combobox", { name: say("payroll.override.employee"), exact: true }),
    ).toBeFocused();
    await override.getByLabel(say("payroll.override.amountIn", { currency: "MYR" })).fill("77");
    await override.getByLabel(say("payroll.override.reason")).fill(`authority letter ${locale}`);
    const overridden = page.waitForResponse(
      (r) => r.url().endsWith("/overrides") && r.request().method() === "POST",
    );
    await press(page, override.getByRole("button", { name: say("payroll.override.save") }));
    expect((await overridden).status()).toBe(200);
    const flagged = page.locator("[data-testid^='override-']");
    await expect(flagged).toHaveCount(1);
    await expect(flagged).toContainText(`authority letter ${locale}`);
    await expect(flagged).toContainText("E-0001");
    await page.screenshot({
      path: testInfo.outputPath(`payroll-override-${locale}.png`),
      fullPage: true,
    });

    await press(page, page.getByRole("button", { name: say("payroll.submit"), exact: true }));
    await expect(page.getByTestId("payroll-status")).toHaveText(say("payroll.status.submitted"));
    const refused = page.waitForResponse(
      (r) => r.url().endsWith("/transitions") && r.request().method() === "POST",
    );
    await press(page, page.getByRole("button", { name: say("payroll.approve"), exact: true }));
    const refusal = await refused;
    expect(refusal.status()).toBe(409);
    expect(((await refusal.json()) as { code: string }).code).toBe("ERR_SOD_MAKER_IS_CHECKER");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("payroll-status")).toHaveText(say("payroll.status.submitted"));
    await page.screenshot({
      path: testInfo.outputPath(`payroll-self-approval-${locale}.png`),
      fullPage: true,
    });
  });
}
