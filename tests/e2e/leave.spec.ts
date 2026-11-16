import { readFileSync } from "node:fs";
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

/** The operator's own employee (`tests/e2e/support/boot.ts`): R4 refuses the operator deciding its leave. */
const OWN_EMPLOYEE = "E2E-TILL";

/**
 * Acceptance test 23 on 8D Task 10's leave register (⚠️ OD-13 and OD-24, both answered build on 2026-11-07): a request
 * the stack recorded for ANOTHER employee is opened from its row by keyboard and approved; the operator adds a leave
 * type, records leave for its OWN employee and is refused deciding it — R4, the database's answer (test 31's leave
 * clause through the screen) and withdraws it (a self-rejection, which R4 allows); then sets an entitlement and a company-wide public holiday. All by keyboard, in English
 * LTR and Arabic RTL. Each locale uses its own employee, type and dates, because both run against one stack.
 */
for (const locale of ["en", "ar"] as const) {
  test(`leave: approve another's request, be refused one's own and withdraw it, keep types, entitlements and holidays in ${locale}`, async ({
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
    const mine =
      locale === "en"
        ? {
            other: "E-0001",
            type: "sick",
            typeName: "Sick leave",
            start: "2026-05-04",
            end: "2026-05-04",
            holiday: "2026-08-31",
            holidayName: "National day",
          }
        : {
            other: "E-0002",
            type: "unpaid",
            typeName: "Unpaid leave",
            start: "2026-05-11",
            end: "2026-05-11",
            holiday: "2026-09-16",
            holidayName: "Malaysia day",
          };
    await page.goto("/login");
    await page.getByLabel(en["auth.login.email"]!).fill(E2E_EMAIL);
    await page.getByLabel(en["auth.login.password"]!).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: en["auth.login.submit"]! }).click();
    await page.getByRole("link", { name: en["app.nav.users"]! }).click();
    await page.getByRole("link", { name: en["app.nav.leave"]! }).click();
    if (locale === "ar") await page.getByLabel(en["app.language"]!).selectOption("ar");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");

    // ── Another employee's request: Enter on its row, Approve has the cursor, Enter ───────────────────────
    const records = page.getByRole("table", { name: say("leave.list"), exact: true });
    const row = records.getByRole("cell", { name: mine.other, exact: true });
    await expect(row).toBeVisible();
    const headers = await records
      .locator("th")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
    expect(locale === "ar" ? headers[0]! > headers[2]! : headers[0]! < headers[2]!).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`leave-${locale}.png`), fullPage: true });
    await row.focus();
    await page.keyboard.press("Enter");
    const decision = page.getByRole("region", {
      name: say("leave.decideTitle", { employee: mine.other }),
    });
    const approve = decision.getByRole("button", { name: say("leave.approve"), exact: true });
    await expect(approve).toBeFocused();
    const approved = page.waitForResponse(
      (r) => r.url().endsWith("/decision") && r.request().method() === "POST",
    );
    await page.keyboard.press("Enter");
    const approval = await approved;
    expect(approval.status()).toBe(200);
    expect(((await approval.json()) as { status: string }).status).toBe("approved");
    await expect(
      page.getByText(
        say("leave.decided", { employee: mine.other, status: say("leave.status.approved") }),
      ),
    ).toBeVisible();
    await expect(records.getByRole("cell", { name: mine.other, exact: true })).toHaveCount(0);

    // ── A leave type of this locale's own ─────────────────────────────────────────────────────────────────
    await press(page, page.getByRole("button", { name: say("leave.typeNew"), exact: true }));
    const typeForm = page.getByRole("form", { name: say("leave.typeNew") });
    const kind = typeForm.getByLabel(say("leave.typeCode"));
    await expect(kind).toBeFocused();
    await kind.selectOption(mine.type);
    await typeForm.getByLabel(say("leave.nameEn")).fill(mine.typeName);
    const typed = page.waitForResponse(
      (r) => r.url().endsWith("/leave-records/types") && r.request().method() === "POST",
    );
    await press(page, typeForm.getByRole("button", { name: say("leave.save") }));
    expect((await typed).status()).toBe(201);
    // Saved: the form closes and the cursor returns to its opener before the next gesture.
    await expect(typeForm).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: say("leave.typeNew"), exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("table", { name: say("leave.typeList") }).getByText(mine.typeName),
    ).toBeVisible();

    // ── The operator's OWN leave: recorded, then refused deciding it (R4) ─────────────────────────────────
    await press(page, page.getByRole("button", { name: say("leave.new"), exact: true }));
    const request = page.getByRole("form", { name: say("leave.new") });
    const who = request.getByLabel(say("leave.employee"));
    await expect(who).toBeFocused();
    await who.selectOption({ label: OWN_EMPLOYEE });
    await request.getByLabel(say("leave.type")).selectOption({ label: mine.typeName });
    await request.getByLabel(say("leave.startsOn")).fill(mine.start);
    await request.getByLabel(say("leave.endsOn")).fill(mine.end);
    await request.getByLabel(say("leave.days")).fill("1");
    const requested = page.waitForResponse(
      (r) => r.url().endsWith("/leave-records") && r.request().method() === "POST",
    );
    await press(page, request.getByRole("button", { name: say("leave.save") }));
    const created = await requested;
    expect(created.status()).toBe(201);
    expect(created.request().postDataJSON()).toMatchObject({ days: "1.00", startsOn: mine.start });
    await expect(request).toHaveCount(0);
    const own = records.getByRole("cell", { name: OWN_EMPLOYEE, exact: true });
    await expect(own).toBeVisible();
    await own.focus();
    await page.keyboard.press("Enter");
    const ownDecision = page.getByRole("region", {
      name: say("leave.decideTitle", { employee: OWN_EMPLOYEE }),
    });
    await expect(
      ownDecision.getByRole("button", { name: say("leave.approve"), exact: true }),
    ).toBeFocused();
    const refused = page.waitForResponse(
      (r) => r.url().endsWith("/decision") && r.request().method() === "POST",
    );
    await page.keyboard.press("Enter");
    const refusal = await refused;
    expect(refusal.status()).toBe(409);
    expect(((await refusal.json()) as { code: string }).code).toBe("ERR_HR_SELF_PAY");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(own).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`leave-self-approval-${locale}.png`),
      fullPage: true,
    });
    // Withdrawing one's own request is a rejection, which R4 allows (only an approval needs a different person).
    await press(page, ownDecision.getByRole("button", { name: say("leave.reject"), exact: true }));
    const withdraw = page.getByRole("form", {
      name: say("leave.rejectTitle", { employee: OWN_EMPLOYEE }),
    });
    const why = withdraw.getByLabel(say("leave.rejectReason"));
    await expect(why).toBeFocused();
    await why.fill("withdrawn");
    const withdrawn = page.waitForResponse(
      (r) => r.url().endsWith("/decision") && r.request().method() === "POST",
    );
    await page.keyboard.press("Enter");
    const withdrawal = await withdrawn;
    expect(withdrawal.status()).toBe(200);
    expect(((await withdrawal.json()) as { status: string }).status).toBe("rejected");
    await expect(own).toHaveCount(0);

    // ── An entitlement for the other employee, and a company-wide holiday ─────────────────────────────────
    await press(page, page.getByRole("button", { name: say("leave.entitlementNew"), exact: true }));
    const entitlement = page.getByRole("form", { name: say("leave.entitlementNew") });
    await expect(entitlement.getByLabel(say("leave.employee"))).toBeFocused();
    await entitlement.getByLabel(say("leave.employee")).selectOption({ label: mine.other });
    await entitlement.getByLabel(say("leave.type")).selectOption({ label: mine.typeName });
    await entitlement.getByLabel(say("leave.year")).fill("2026");
    await entitlement.getByLabel(say("leave.days")).fill("14");
    const entitled = page.waitForResponse(
      (r) => r.url().endsWith("/entitlements") && r.request().method() === "PUT",
    );
    await press(page, entitlement.getByRole("button", { name: say("leave.save") }));
    const entitledAnswer = await entitled;
    expect(entitledAnswer.status()).toBe(200);
    expect(entitledAnswer.request().postDataJSON()).toMatchObject({ year: 2026, days: "14.00" });
    await expect(entitlement).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: say("leave.entitlementNew"), exact: true }),
    ).toBeFocused();

    await press(page, page.getByRole("button", { name: say("leave.holidayNew"), exact: true }));
    const holiday = page.getByRole("form", { name: say("leave.holidayNew") });
    await expect(holiday.getByLabel(say("leave.holidayOn"))).toBeFocused();
    await holiday.getByLabel(say("leave.holidayOn")).fill(mine.holiday);
    await holiday.getByLabel(say("leave.nameEn")).fill(mine.holidayName);
    const holidayed = page.waitForResponse(
      (r) => r.url().endsWith("/holidays") && r.request().method() === "POST",
    );
    await press(page, holiday.getByRole("button", { name: say("leave.save") }));
    const holidayAnswer = await holidayed;
    expect(holidayAnswer.status()).toBe(201);
    expect(holidayAnswer.request().postDataJSON()).toMatchObject({ branchId: null });
    await expect(
      page.getByRole("table", { name: say("leave.holidayList") }).getByText(mine.holidayName),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`leave-register-${locale}.png`),
      fullPage: true,
    });
  });
}
