import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD, LATIN_NAME, MIXED_EMAIL, MIXED_NAME } from "./support/people";

/**
 * **Acceptance test 23 (spec:2441).** "Every screen and generated PDF renders correctly in Arabic
 * and English, including numerals, Hijri/Gregorian dates and column order." This file owns the
 * screen half; the PDF half is 2C/7A/8D's, re-run through the same harness.
 *
 * Every unit test in this slice asserts `dir="rtl"` and Arabic strings in jsdom, which has no layout
 * engine and therefore cannot tell anyone that a column ended up on the wrong side. So **the
 * assertions that carry this file's weight** read bounding boxes, computed styles and `Range`
 * rectangles — the browser's own answer to "where did this actually go".
 *
 * Some assertions here are not geometry and do not pretend to be: `dir` and `lang` are checked as
 * preconditions of the measurement that follows them, and the last three specs compare content and
 * counts. A jsdom render could make those, and they are not what discharges DoD row 0.12. They earn
 * their place by running against the *built bundle* and *live API data* instead of a mocked tree —
 * which is integration value, not layout value. Do not read this header as a claim that every line
 * below is a pixel measurement.
 *
 * **Hijri is not exercised and is not claimed.** `FormatContext.calendar` in `@dulja/i18n` offers
 * `islamic-umalqura`, and `packages/i18n/test/format.test.ts` covers it, but no Phase 0 screen
 * selects it: `UsersRoute` calls `formatTimestamp(u.createdAt, { locale })`, which takes the
 * `gregory` default in both locales. There is nothing on screen to measure, so this file measures
 * the Gregorian rendering in both locales and says so rather than inventing a pass.
 */

const CATALOGUES = new URL("../../packages/i18n/catalogues/", import.meta.url);

const catalogue = (name: string): Readonly<Record<string, string>> =>
  JSON.parse(readFileSync(new URL(name, CATALOGUES), "utf8")) as Record<string, string>;

const EN = catalogue("en.json");
const AR = catalogue("ar.json");

/** The catalogue's own string, and a loud failure rather than `undefined` if a key was renamed. */
const say = (of: Readonly<Record<string, string>>, key: string): string => {
  const found = of[key];
  if (found === undefined) throw new Error(`no catalogue key "${key}"`);
  return found;
};

/** The screen's five columns, in the order `UsersRoute` builds them. */
const COLUMN_KEYS = [
  "admin.users.column.email",
  "admin.users.column.name",
  "admin.users.column.roles",
  "admin.users.column.status",
  "admin.users.column.invitedOn",
] as const;

const columnsOf = (of: Readonly<Record<string, string>>): string[] =>
  COLUMN_KEYS.map((key) => say(of, key));

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const boxOf = async (locator: Locator): Promise<Box> => {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("the element has no layout box");
  return found;
};

/** Header texts in the order the browser paints them across the viewport, left to right. */
const paintedColumnOrder = async (page: Page): Promise<string[]> => {
  const headers = page.getByRole("columnheader");
  const count = await headers.count();
  const seen: { text: string; x: number }[] = [];
  for (let index = 0; index < count; index++) {
    const header = headers.nth(index);
    seen.push({ text: (await header.innerText()).trim(), x: (await boxOf(header)).x });
  }
  return seen.toSorted((left, right) => left.x - right.x).map((item) => item.text);
};

/** Which physical edge a logical `border-inline-end` landed on, in pixels. */
const borderWidths = (locator: Locator): Promise<{ left: number; right: number }> =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      left: Number.parseFloat(style.borderLeftWidth),
      right: Number.parseFloat(style.borderRightWidth),
    };
  });

/**
 * How far the element's own glyphs sit from each of its physical edges. `text-align: start` is a
 * declaration; this is where the text went — the difference jsdom cannot report and a physical
 * `text-left` slipping into a component would show up in.
 */
const textGaps = (
  locator: Locator,
): Promise<{ left: number; right: number; textAlign: string; direction: string }> =>
  locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: text.left - box.left,
      right: box.right - text.right,
      textAlign: style.textAlign,
      direction: style.direction,
    };
  });

/**
 * Where one run of characters inside the element was painted. The text node is found by walking,
 * never by naming the wrapper that holds it: a spec that selected `bdi` would report a missing
 * *element* — after a 60-second locator timeout — where the fact worth reporting is that the glyphs
 * moved. The point of the check is the ordering, so the ordering is what has to fail.
 */
const runBox = (
  locator: Locator,
  run: string,
  /**
   * A slice *within* the located occurrence. Two separate `runBox` calls for `"2026"` and `"20"`
   * would both resolve through `indexOf` to ranges that start at the same offset, so the second
   * would be a sub-range of the first — and a sub-range's rectangle is inside its parent's under
   * every possible painting, reversed digits included. Naming the occurrence once and slicing
   * inside it is what makes two halves comparable rather than nested.
   */
  slice?: { from: number; length: number },
): Promise<{ left: number; right: number }> =>
  locator.evaluate(
    (element, { needle, from, length }) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode() as Text | null;
      while (text !== null && !text.data.includes(needle)) text = walker.nextNode() as Text | null;
      if (text === null) throw new Error(`"${needle}" is not in "${element.textContent ?? ""}"`);
      const at = text.data.indexOf(needle) + from;
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + length);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    },
    { needle: run, from: slice?.from ?? 0, length: slice?.length ?? run.length },
  );

/** The Unicode numbering systems the given text draws its digits from. */
const numberingSystems = (text: string): string[] => {
  const systems = new Set<string>();
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x30 && code <= 0x39) systems.add("latn");
    else if (code >= 0x660 && code <= 0x669) systems.add("arab");
    else if (code >= 0x6f0 && code <= 0x6f9) systems.add("arabext");
  }
  return [...systems].toSorted();
};

const signIn = async (page: Page): Promise<void> => {
  await page.goto("/login");
  await page.getByLabel(say(EN, "auth.login.email")).fill(E2E_EMAIL);
  await page.getByLabel(say(EN, "auth.login.password")).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: say(EN, "auth.login.submit") }).click();
  await page.getByRole("link", { name: say(EN, "app.nav.users") }).click();
  // Rows, not merely chrome: every measurement below is of something the data drew. Waiting on the
  // heading alone would measure a grid that still says "Loading…" and pass for the wrong reason.
  await expect(page.getByRole("cell", { name: LATIN_NAME })).toBeVisible();
};

/**
 * Switches the shell's own language control and waits for the catalogue to have *landed* — not just
 * for `dir` to have flipped. `changeLanguage` is a promise, so the two are separate commits, and a
 * spec that raced them would measure Arabic direction around English text.
 */
const switchToArabic = async (page: Page): Promise<void> => {
  await page.getByLabel(say(EN, "app.language")).selectOption("ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByLabel(say(AR, "app.language"))).toBeVisible();
};

test.describe("acceptance test 23 — RTL/LTR parity", () => {
  test("English paints the columns in their logical order, left to right", async ({ page }) => {
    await signIn(page);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    expect(await page.getByRole("columnheader").allInnerTexts()).toEqual(columnsOf(EN));
    expect(await paintedColumnOrder(page)).toEqual(columnsOf(EN));

    // The leading column sits at the leading edge of the table, and the last at the trailing one.
    const table = await boxOf(page.getByRole("table"));
    const first = await boxOf(page.getByRole("columnheader").first());
    const last = await boxOf(page.getByRole("columnheader").last());
    expect(Math.abs(first.x - table.x)).toBeLessThan(2);
    expect(Math.abs(last.x + last.width - (table.x + table.width))).toBeLessThan(2);
  });

  test("Arabic paints the same columns in mirror order", async ({ page }) => {
    await signIn(page);
    const beforeSwitch = await boxOf(page.getByRole("columnheader").first());
    await switchToArabic(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");

    // The DOM order does not change — only the painting does. Asserting both is what separates
    // "the table was mirrored" from "somebody reversed the columns array for Arabic".
    expect(await page.getByRole("columnheader").allInnerTexts()).toEqual(columnsOf(AR));
    expect(await paintedColumnOrder(page)).toEqual(columnsOf(AR).toReversed());

    const table = await boxOf(page.getByRole("table"));
    const first = await boxOf(page.getByRole("columnheader").first());
    const last = await boxOf(page.getByRole("columnheader").last());
    // The leading column is now against the *right* edge of the table, and the last against the left.
    expect(Math.abs(first.x + first.width - (table.x + table.width))).toBeLessThan(2);
    expect(Math.abs(last.x - table.x)).toBeLessThan(2);
    /*
     * And it travelled rightwards to get there — the before/after fact, which the two edge
     * assertions above do not state on their own.
     *
     * Deliberately not `beforeSwitch.x + table.width / 2`, which is what this line used to say.
     * That threshold holds only while the e-mail column is narrower than half the table (about
     * 399px against a measured 265px here), and a column's width is a pure function of the font
     * and of the seeded strings — so it would have gone red on the Linux CI runner, whose fonts
     * are not this machine's, for a reason that has nothing to do with direction. The edge
     * assertions above are strictly stronger *and* metric-independent; this one only has to be
     * true whenever a column is narrower than its own table.
     */
    expect(first.x).toBeGreaterThan(beforeSwitch.x);
  });

  test("the shell chrome mirrors too, border included", async ({ page }) => {
    await signIn(page);
    const navLtr = await boxOf(page.getByRole("navigation"));
    const mainLtr = await boxOf(page.locator("main"));
    expect(navLtr.x).toBeLessThan(mainLtr.x);
    // `border-e` is a logical property; this is the physical edge it resolved to.
    expect(await borderWidths(page.getByRole("navigation"))).toEqual({ left: 0, right: 1 });

    await switchToArabic(page);
    const navRtl = await boxOf(page.getByRole("navigation"));
    const mainRtl = await boxOf(page.locator("main"));
    expect(navRtl.x).toBeGreaterThan(mainRtl.x);
    expect(await borderWidths(page.getByRole("navigation"))).toEqual({ left: 1, right: 0 });
  });

  test("text hugs the side the reader starts from, in both directions", async ({ page }) => {
    await signIn(page);
    const headingLtr = await textGaps(
      page.getByRole("heading", { name: say(EN, "admin.users.title") }),
    );
    // The declaration — a physical `text-left` reaching a component would show here…
    expect(headingLtr.textAlign).toBe("start");
    // …and this is where the glyphs went, which is the half jsdom cannot answer.
    expect(headingLtr.left).toBeLessThan(2);
    expect(headingLtr.right).toBeGreaterThan(headingLtr.left + 50);

    await switchToArabic(page);
    const headingRtl = await textGaps(
      page.getByRole("heading", { name: say(AR, "admin.users.title") }),
    );
    expect(headingRtl.textAlign).toBe("start");
    expect(headingRtl.direction).toBe("rtl");
    expect(headingRtl.right).toBeLessThan(2);
    expect(headingRtl.left).toBeGreaterThan(headingRtl.right + 50);
  });

  test("the keyboard drives the grid, and forward is the reader's own forward", async ({
    page,
  }) => {
    await signIn(page);

    // The OD-24 model's "/" from anywhere on the screen.
    await page.keyboard.press("/");
    await expect(page.getByLabel(say(EN, "admin.users.search"))).toBeFocused();
    /*
     * One Tab, not two: `UsersRoute` renders search → the grid → the role picker and the Assign
     * button, so the grid's single roving tab stop is the very next stop. (The brief's own comment
     * described a tab order Task 8 did not ship; the DOM is the authority.)
     */
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-cell="0:0"]')).toBeFocused();

    const startLtr = await boxOf(page.locator('[data-cell="0:0"]'));
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-cell="0:1"]')).toBeFocused();
    // Not only "the next cell" — the next cell was physically to the right.
    expect((await boxOf(page.locator('[data-cell="0:1"]'))).x).toBeGreaterThan(startLtr.x);

    await switchToArabic(page);
    await page.locator('[data-cell="0:0"]').focus();
    const startRtl = await boxOf(page.locator('[data-cell="0:0"]'));
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator('[data-cell="0:1"]')).toBeFocused();
    // In Arabic the advancing side is the left one, and the focus moved that way on screen.
    expect((await boxOf(page.locator('[data-cell="0:1"]'))).x).toBeLessThan(startRtl.x);
    // …and the mirrored key goes back, rather than both keys meaning "forward".
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-cell="0:0"]')).toBeFocused();
  });

  test("a mixed-script cell reads the same whichever way the page runs", async ({ page }) => {
    await signIn(page);
    const cell = page.getByRole("cell", { name: MIXED_NAME });

    const ltr = {
      arabic: await runBox(cell, "مبيعات"),
      letters: await runBox(cell, "ABC"),
      digits: await runBox(cell, "123"),
    };
    await switchToArabic(page);
    const rtl = {
      arabic: await runBox(cell, "مبيعات"),
      letters: await runBox(cell, "ABC"),
      digits: await runBox(cell, "123"),
    };

    for (const [direction, runs] of [
      ["English", ltr],
      ["Arabic", rtl],
    ] as const) {
      // `<bdi>` isolates the cell: its own first strong character is Arabic, so its runs order
      // right-to-left — the Arabic word to the right of the Latin one — no matter which way the
      // page around it runs. Take the isolation away and the English page reverses this.
      expect(
        runs.arabic.left,
        `${direction}: the Arabic run must sit after the Latin one`,
      ).toBeGreaterThan(runs.letters.right);
      // And the Latin run is still read left to right, digits and all (spec:2253, "numerals").
      expect(runs.letters.left, `${direction}: ABC must precede 123 on screen`).toBeLessThan(
        runs.digits.left,
      );
    }
  });

  test("dates and numerals are the locale's own, and never two systems at once", async ({
    page,
  }) => {
    await signIn(page);
    const dateCell = page
      .getByRole("row")
      .filter({ hasText: MIXED_EMAIL })
      .locator('[data-cell$=":4"]');

    const dateEn = await dateCell.innerText();
    expect(dateEn).toMatch(/20\d\d/);

    await switchToArabic(page);
    const dateAr = await dateCell.innerText();
    expect(dateAr).toMatch(/20\d\d/);
    // The same instant, written the way each locale writes it. Identical strings would mean the
    // locale never reached `Intl` and English was simply left on screen.
    expect(dateAr).not.toBe(dateEn);

    /*
     * The year's own digits still read left to right inside a right-to-left line — the half of
     * spec:2253 that says "numerals". The year is read off the cell rather than written down here:
     * `createdAt` is `now()` at seed time, so a literal "2026" would turn this suite red on
     * 1 January for no product reason. Its two halves are measured as slices of the one located
     * occurrence, so they sit beside each other rather than one inside the other.
     */
    const year = /20\d\d/.exec(dateAr)?.[0] ?? "";
    expect(year).toHaveLength(4);
    const firstHalf = await runBox(dateCell, year, { from: 0, length: 2 });
    const secondHalf = await runBox(dateCell, year, { from: 2, length: 2 });
    expect(firstHalf.right, `"${year}" is painted back to front`).toBeLessThanOrEqual(
      secondHalf.left + 0.5,
    );

    /*
     * One screen, one numbering system. Only the app's own formatted output is counted — the count
     * line, the roles column and the dates — because a display name is the operator's data and may
     * legitimately carry whatever digits they typed. A future change that moved ICU's `#` to
     * Arabic-Indic while `formatNumber`'s pinned `nu-latn` stayed Western would put two systems
     * side by side on one line, which is the regression spec:2253 names.
     */
    const formatted = [
      await page.getByRole("status").first().innerText(),
      ...(await page.locator('[data-cell$=":2"]').allInnerTexts()),
      ...(await page.locator('[data-cell$=":4"]').allInnerTexts()),
    ].join(" ");
    expect(numberingSystems(formatted)).toHaveLength(1);
  });

  test("no English string survives on the Arabic screen", async ({ page }) => {
    await signIn(page);
    await switchToArabic(page);

    /*
     * Every English string the catalogue has an Arabic translation for. Comparing against the
     * catalogue rather than against a "looks Latin" regular expression is what makes this sharp: a
     * key that quietly fell back to English is caught by name, and seeded data (e-mail addresses,
     * the role's own `name_en`) is not mistaken for untranslated chrome. The endonyms are excluded
     * because "English" is the English language's name in Arabic too.
     */
    const untranslated = new Set(
      Object.keys(EN)
        .filter((key) => !key.startsWith("app.endonym.") && say(EN, key) !== say(AR, key))
        .map((key) => say(EN, key)),
    );

    // `header span` is the application's own name, which is translated too (`app.name`) and has no
    // other element type to be caught by.
    const chrome = await page
      .locator(
        "h1, th, caption, label, button, nav a, header span, [role='status'], [role='alert']",
      )
      .allInnerTexts();
    // Non-vacuous by construction: an empty screen would otherwise pass this test silently.
    expect(chrome.length).toBeGreaterThan(8);
    expect(chrome).toContain(say(AR, "admin.users.title"));
    expect(chrome).toContain(say(AR, "admin.users.search"));
    for (const column of columnsOf(AR)) expect(chrome).toContain(column);

    for (const text of chrome)
      expect(untranslated.has(text.trim()), `"${text.trim()}" is untranslated`).toBe(false);
  });

  test("the unauthenticated login screen mirrors as well", async ({ page }) => {
    await page.goto("/login");
    const switcherLtr = await boxOf(page.getByLabel(say(EN, "app.language")));
    const mainLtr = await boxOf(page.locator("main"));

    await page.getByLabel(say(EN, "app.language")).selectOption("ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: say(AR, "auth.login.title") })).toBeVisible();

    // The switcher is placed with `justify-end`, a logical alignment: it crosses the screen.
    const switcherRtl = await boxOf(page.getByLabel(say(AR, "app.language")));
    expect(switcherLtr.x).toBeGreaterThan(mainLtr.x + mainLtr.width / 2);
    expect(switcherRtl.x).toBeLessThan(mainLtr.x + mainLtr.width / 2);

    const label = page.locator("label").filter({ hasText: say(AR, "auth.login.email") });
    const labelGaps = await textGaps(label);
    expect(labelGaps.right).toBeLessThan(2);

    /*
     * An e-mail address is Latin text in every locale, and Task 6 puts an explicit `dir="ltr"` on
     * the field for exactly that reason. The chrome around it turned; the field did not.
     */
    const email = page.getByLabel(say(AR, "auth.login.email"));
    expect(await email.evaluate((element) => getComputedStyle(element).direction)).toBe("ltr");
  });

  test("both directions show the same information, not a reduced Arabic screen", async ({
    page,
  }) => {
    await signIn(page);
    const emailsLtr = await page.locator('[data-cell$=":0"]').allInnerTexts();
    const rowsLtr = await page.getByRole("row").count();
    const columnsLtr = await page.getByRole("columnheader").count();

    await switchToArabic(page);
    expect(await page.locator('[data-cell$=":0"]').allInnerTexts()).toEqual(emailsLtr);
    expect(await page.getByRole("row").count()).toBe(rowsLtr);
    expect(await page.getByRole("columnheader").count()).toBe(columnsLtr);
    expect(columnsLtr).toBe(COLUMN_KEYS.length);
  });
});
