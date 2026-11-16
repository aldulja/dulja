import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_EMAIL,
  E2E_INVITEE_EMAIL,
  E2E_RECOVERY_CODE,
  E2E_THROTTLED_EMAIL,
  E2E_TOTP_CODE,
  LATIN_NAME,
} from "./support/people";

/**
 * PRD-01 / OPS-08 (ADR 0096): a first or forgotten password, set from the sign-in screen by a
 * one-time code the identity provider e-mails, without leaving the app and without a deep link.
 * Driven by keyboard only, in English LTR and Arabic RTL, against the local auth stub — the code is
 * the stub's, so a run against real Supabase (`PLAYWRIGHT_BASE_URL`) skips this file.
 */

const CATALOGUES = new URL("../../packages/i18n/catalogues/", import.meta.url);
const catalogue = (name: string): Readonly<Record<string, string>> =>
  JSON.parse(readFileSync(new URL(name, CATALOGUES), "utf8")) as Record<string, string>;
const EN = catalogue("en.json");
const AR = catalogue("ar.json");
const say = (of: Readonly<Record<string, string>>, key: string): string => {
  const found = of[key];
  if (found === undefined) throw new Error(`no catalogue key "${key}"`);
  return found;
};

const PASSWORD = "a long and unguessable passphrase";

/** Tab forward from wherever focus is until `name`'s button has it — keyboard only, no click. */
const tabTo = async (page: Page, name: string): Promise<void> => {
  const target = page.getByRole("button", { name });
  for (let presses = 0; presses < 12; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
};

/** From a fresh sign-in screen to the password step, keyboard only. */
const throughTheCode = async (
  page: Page,
  of: Readonly<Record<string, string>>,
  email: string,
): Promise<void> => {
  await tabTo(page, say(of, "auth.reset.start"));
  await page.keyboard.press("Enter");
  const emailField = page.getByLabel(say(of, "auth.login.email"), { exact: true });
  await expect(emailField).toBeFocused();
  await emailField.fill("");
  await page.keyboard.type(email);
  await page.keyboard.press("Enter");

  await expect(page.getByRole("status")).toHaveText(say(of, "auth.reset.sent"));
  await expect(page.getByLabel(say(of, "auth.reset.code"), { exact: true })).toBeFocused();
  await page.keyboard.type(E2E_RECOVERY_CODE);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel(say(of, "auth.reset.newPassword"), { exact: true })).toBeFocused();
};

test.describe("set a first or forgotten password by e-mailed code (ADR 0096)", () => {
  test.skip(
    process.env["PLAYWRIGHT_BASE_URL"] !== undefined,
    "the recovery code is the local auth stub's; real Supabase e-mails its own",
  );

  test("an invitee sets a first password and is handed to enrolment, in English LTR", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByLabel(say(EN, "auth.login.email"), { exact: true })).toBeFocused();
    await throughTheCode(page, EN, E2E_INVITEE_EMAIL);

    // Never enrolled, so no authenticator field.
    await expect(page.getByLabel(say(EN, "auth.mfa.code"), { exact: true })).toHaveCount(0);
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press("Tab");
    await expect(
      page.getByLabel(say(EN, "auth.reset.confirmPassword"), { exact: true }),
    ).toBeFocused();
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press("Enter");

    await expect(page.getByRole("status")).toHaveText(say(EN, "auth.reset.saved"));
    // aal1 with no factor: exactly where a password sign-in lands a first-time user.
    await expect(page.getByRole("heading", { name: say(EN, "auth.login.title") })).toBeFocused();
    await expect(page.getByRole("link", { name: say(EN, "auth.mfa.title") })).toBeVisible();
  });

  test("the same step in Arabic RTL, with the digits and address still typed left-to-right", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel(say(EN, "app.language"), { exact: true }).selectOption("ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByLabel(say(AR, "app.language"), { exact: true })).toBeVisible();
    await page.getByLabel(say(AR, "auth.login.email"), { exact: true }).focus();
    await throughTheCode(page, AR, E2E_INVITEE_EMAIL);

    const form = page.locator("form");
    expect(await form.evaluate((element) => getComputedStyle(element).direction)).toBe("rtl");
    // The heading starts at the form's trailing edge in RTL — the right-hand side.
    const formBox = await form.boundingBox();
    const heading = page.getByRole("heading", { name: say(AR, "auth.reset.title") });
    const textRight = await heading.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().right;
    });
    expect(formBox).not.toBeNull();
    expect(Math.abs(textRight - ((formBox?.x ?? 0) + (formBox?.width ?? 0)))).toBeLessThan(2);
    await expect(
      page.getByLabel(say(AR, "auth.reset.newPassword"), { exact: true }),
    ).toHaveAttribute("dir", "ltr");

    await page.keyboard.type(PASSWORD);
    await page.keyboard.press("Tab");
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText(say(AR, "auth.reset.saved"));
    await expect(page.getByRole("link", { name: say(AR, "auth.mfa.title") })).toBeVisible();
  });

  test("an enrolled owner passes the TOTP challenge before the password changes, then reaches the back office", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page.getByLabel(say(EN, "auth.login.email"), { exact: true })).toBeFocused();
    await throughTheCode(page, EN, E2E_EMAIL);

    await page.keyboard.type(PASSWORD);
    await page.keyboard.press("Tab");
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press("Tab");
    await expect(page.getByLabel(say(EN, "auth.mfa.code"), { exact: true })).toBeFocused();
    await page.keyboard.type(E2E_TOTP_CODE);
    await page.keyboard.press("Enter");

    await expect(page.getByRole("status")).toHaveText(say(EN, "auth.reset.saved"));
    const users = page.getByRole("link", { name: say(EN, "app.nav.users") });
    await users.focus();
    await page.keyboard.press("Enter");
    // An aal2 session the real API honours: the grid's rows arrive.
    await expect(page.getByRole("cell", { name: LATIN_NAME })).toBeVisible();
  });

  test("a wrong code is refused in the catalogue's words and the password step never opens", async ({
    page,
  }) => {
    await page.goto("/login");
    await tabTo(page, say(EN, "auth.reset.start"));
    await page.keyboard.press("Enter");
    await page.keyboard.type(E2E_INVITEE_EMAIL);
    await page.keyboard.press("Enter");
    await expect(page.getByLabel(say(EN, "auth.reset.code"), { exact: true })).toBeFocused();
    await page.keyboard.type("111111");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(say(EN, "auth.reset.codeFailed"));
    await expect(page.getByLabel(say(EN, "auth.reset.newPassword"), { exact: true })).toHaveCount(
      0,
    );
  });

  test("a rate-limited request says to wait", async ({ page }) => {
    await page.goto("/login");
    await tabTo(page, say(EN, "auth.reset.start"));
    await page.keyboard.press("Enter");
    await page.keyboard.type(E2E_THROTTLED_EMAIL);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(say(EN, "auth.reset.rateLimited"));
  });
});
