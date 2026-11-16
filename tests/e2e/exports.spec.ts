import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./support/people";

const catalogues = new URL("../../packages/i18n/catalogues/", import.meta.url);
const en = JSON.parse(readFileSync(new URL("en.json", catalogues), "utf8")) as Record<
  string,
  string
>;

/**
 * Acceptance test 23 on 7C Task 13's screen (spec:106, spec:2253): the tenant data export requested by keyboard,
 * followed through its status resource while the worker's own `admin.export.run` handler builds the archive, then
 * downloaded and checked against the SHA-256 the screen shows, with the tables the requester's gates kept out
 * listed by name and gate — in English LTR and Arabic RTL.
 */
for (const locale of ["en", "ar"] as const) {
  test(`tenant export: request, follow, verify and download in ${locale}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const messages = JSON.parse(
      readFileSync(new URL(`${locale}.json`, catalogues), "utf8"),
    ) as Record<string, string>;
    const say = (key: string) => messages[key]!;
    await page.goto("/login");
    await page.getByLabel(en["auth.login.email"]!).fill(E2E_EMAIL);
    await page.getByLabel(en["auth.login.password"]!).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: en["auth.login.submit"]! }).click();
    await page.getByRole("link", { name: en["app.nav.users"]! }).click();
    await page.getByRole("link", { name: en["app.nav.exports"]! }).click();
    if (locale === "ar") await page.getByLabel(en["app.language"]!).selectOption("ar");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(
      page.getByRole("heading", { name: say("admin.export.title"), exact: true }),
    ).toBeVisible();

    const form = page.getByRole("form", { name: say("admin.export.request") });
    const format = form.getByLabel(say("admin.export.format"));
    await expect(format).toHaveValue("both");
    await expect(format.locator("option")).toHaveCount(3);
    await expect(form.getByLabel(say("admin.export.includeAttachments"))).toBeChecked();
    const formatX = (await format.boundingBox())!.x;
    const submitX = (await form
      .getByRole("button", { name: say("admin.export.submit") })
      .boundingBox())!.x;
    expect(locale === "ar" ? formatX > submitX : formatX < submitX).toBe(true);

    await format.focus();
    await page.keyboard.press("Control+Enter");
    const download = page.getByRole("button", { name: say("admin.export.download") });
    await expect(download).toBeFocused({ timeout: 60_000 });
    const digest = (await page.getByTestId("export-sha256").textContent())!.trim();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // The tables this operator's gates kept out are named, each with the code it needs.
    const excluded = page.getByTestId("export-excluded").getByRole("listitem");
    expect(await excluded.count()).toBeGreaterThan(0);
    await expect(excluded.first()).toContainText(/[a-z_]+\.[a-z_]+\.[a-z_]+/);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`exports-${locale}.png`), fullPage: true });

    const saved = page.waitForEvent("download");
    await page.keyboard.press("Enter");
    const file = await saved;
    expect(file.suggestedFilename()).toMatch(/^dulja-export-[0-9a-f-]{36}\.tar\.gz$/);
    // The archive is the one the status resource describes, byte for byte.
    expect(
      createHash("sha256")
        .update(readFileSync(await file.path()))
        .digest("hex"),
    ).toBe(digest);

    const list = page.getByRole("table", { name: say("admin.export.list"), exact: true });
    await expect(list.getByText(say("admin.export.status.done")).first()).toBeVisible();
    const headers = await list
      .locator("th")
      .evaluateAll((elements) => elements.map((e) => e.getBoundingClientRect().x));
    expect(locale === "ar" ? headers[0]! > headers[2]! : headers[0]! < headers[2]!).toBe(true);
  });
}
