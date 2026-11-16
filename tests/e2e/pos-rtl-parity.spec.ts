import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { CATALOGUES, formatMoney, type Locale, type TranslationKey } from "@dulja/i18n";
import { browserWindowOptions } from "../../apps/desktop/src/window-options";
import { buildTill, CASHIER, ITEM, openTill, serveTill, type ServedTill } from "./support/till";

/**
 * **Acceptance test 23's POS half (6B T11 Step 6, spec:2441).** "Every screen … renders correctly in Arabic
 * and English, including numerals, Hijri/Gregorian dates and column order", re-run for the till with the
 * checks `rtl-parity.spec.ts` makes of the back office.
 *
 * jsdom has no layout engine, so `apps/pos/test/renderer.test.tsx` can say `dir="rtl"` and nothing about
 * where anything went. This file asks Chromium. It visits these views, in each language:
 *
 * - an unenrolled till's enrol form, and the same form after a refused enrolment;
 * - sign-in, opening the shift, selling (an item scanned), the return mode with an original ticket loaded,
 *   the open supervisor approval, payment, the receipt, price check (a hit listed), customer, the shift, the
 *   close's review of the count, and the closed shift's summary.
 *
 * On every one of them it checks four things. No painted box lies outside the viewport, on either side. The
 * page uses one numbering system. No string is left in the other language. And, with the till switched to the
 * other language on the same state and back, the view shows the same things and the same figures (a
 * timestamp excepted, which must instead be written each language's own way). It reads the receipt's column
 * order and the order of a date's year digits off the screen. It completes a sale with the keyboard alone
 * (spec:2254), using the keys `docs/ui/od-24-phase-6b-screens.md` records: Enter, F8, Tab, Space, F2, F4, F10
 * and Escape.
 *
 * **Not claimed.** These views are not every state the till has. A several-hit scan list, a customer search's
 * hits, an on-account sale or return, a completed return, a void and a cancellation are not visited; the
 * new-customer form is measured empty and never submitted; and no refusal but the enrolment's is shown. Hijri
 * is not exercised: `formatTimestamp` takes the `gregory` default in both locales and no till screen selects
 * another calendar, so the dates measured are Gregorian, as in the back office's file.
 *
 * Two deliberate departures from the plan's sample, both forced by the tree rather than chosen: the till moves
 * between state views, not `#/…` routes, so a view is reached by its key, as a cashier reaches it; and the
 * page is the built renderer in Playwright's Chromium against the built main-process bundle
 * (`support/till.ts`), not `pos.exe` under `_electron`, because the packaged till is Windows-only and unenrolled
 * on first start. The packaged run is CI's Windows `desktop` job.
 */

/** The till's window: `main-pos.ts` opens 1280×800 and goes full screen only when packaged. */
const { width, height } = browserWindowOptions("");
test.use({ viewport: { width: width!, height: height! } });

let served: ServedTill | undefined;

const LOCALES = ["en", "ar"] as const;
const otherThan = (locale: Locale): Locale => (locale === "en" ? "ar" : "en");

/** The catalogue's own string, and a loud failure rather than `undefined` if a key was renamed. */
const say = (locale: Locale, key: TranslationKey): string => {
  const found = CATALOGUES[locale][key];
  if (found === undefined) throw new Error(`no ${locale} catalogue key "${key}"`);
  return found;
};

/**
 * Every string of the other catalogue that this one translates differently. Comparing against the catalogue,
 * as `rtl-parity.spec.ts` does, catches a key that fell back by name, and never mistakes data (an item code, a
 * ticket reference) for chrome. The endonyms are left out: each language is named in its own script in both.
 */
const untranslated = (locale: Locale): ReadonlySet<string> => {
  const here = CATALOGUES[locale];
  const there = CATALOGUES[otherThan(locale)];
  return new Set(
    (Object.keys(there) as TranslationKey[])
      .filter((key) => !key.startsWith("app.endonym.") && there[key] !== here[key])
      .map((key) => say(otherThan(locale), key)),
  );
};

/** The Unicode numbering systems the given text draws its digits from (`rtl-parity.spec.ts`'s). */
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

test.beforeAll(async () => {
  // Two builds, the same two `apps/desktop`'s `build:pos` begins with; each takes seconds, not minutes.
  test.setTimeout(180_000);
  await buildTill();
  served = await serveTill();
});

test.afterAll(async () => {
  await served?.close();
});

/**
 * Every painted box that pokes out of the viewport sideways, plus the page's own scroll width. Both are
 * needed: in a right-to-left document an overflow past the *right* edge is unreachable, so it is clipped
 * rather than scrolled and never shows in `scrollWidth`; only the boxes catch that side.
 */
const measure = (page: Page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    const clientWidth = root.clientWidth;
    const offenders = [...document.body.querySelectorAll("*")].flatMap((element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return [];
      if (box.left >= -0.5 && box.right <= clientWidth + 0.5) return [];
      const text = (element.textContent ?? "").trim().slice(0, 40);
      return [
        `${element.tagName.toLowerCase()} [${Math.round(box.left)}, ${Math.round(box.right)}] ${text}`,
      ];
    });
    return { scrollWidth: root.scrollWidth, clientWidth, offenders };
  });

/**
 * Every string the page shows or announces: each text node, an `<option>`'s and a closed disclosure's
 * included, and each accessible-name or hint attribute.
 */
const shownText = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (text !== "") found.push(text);
    }
    for (const element of document.body.querySelectorAll("[aria-label], [placeholder], [title]"))
      for (const name of ["aria-label", "placeholder", "title"]) {
        const value = element.getAttribute(name)?.trim();
        if (value) found.push(value);
      }
    return found;
  });

/**
 * What a view tells the cashier, whatever language it says it in: how many of each kind of thing it shows,
 * every figure, and its timestamps. A text node with a year and a time in it is a timestamp; it is kept apart
 * because English and Arabic write the same instant with different digits (a month name against a month
 * number), and its count is what has to match.
 */
const signature = (page: Page) =>
  page.locator(".pos-app").evaluate((root) => {
    const kinds = [
      "h1",
      "h2",
      "p",
      "button",
      "input",
      "select",
      "option",
      "label",
      "legend",
      "summary",
      "table",
      "th",
      "td",
      "dt",
      "dd",
      "li",
      "[role='alert']",
      "[role='status']",
    ];
    const counts = Object.fromEntries(
      kinds.map((kind) => [kind, root.querySelectorAll(kind).length]),
    );
    const timestamps: string[] = [];
    const figures: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (/20\d\d/.test(text) && /\d:\d\d/.test(text)) timestamps.push(text.trim());
      else figures.push(...(text.match(/\d+(?:[.,]\d+)*/g) ?? []));
    }
    return { counts, timestamps, figures: figures.toSorted() };
  });

/**
 * Where one slice of a run of characters inside the element was painted (`rtl-parity.spec.ts`'s `runBox`).
 * The run is found once and sliced inside, so two halves are beside each other rather than one inside the
 * other.
 */
const sliceBox = (
  locator: Locator,
  run: string,
  slice: { from: number; length: number },
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
    { needle: run, from: slice.from, length: slice.length },
  );

/**
 * Tab (or Shift+Tab) until `target` has focus — the keyboard's own route to a control, never a click or a
 * programmatic `focus()`. Bounded, so a control the Tab order cannot reach fails here rather than hanging.
 */
const tabTo = async (page: Page, target: Locator, key: "Tab" | "Shift+Tab" = "Tab") => {
  await expect(target).toBeVisible();
  for (let presses = 0; presses < 60; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
};

/** The checks every view gets, in `locale`, on `page`. */
const screens = (page: Page, locale: Locale, testInfo: TestInfo) => {
  const t = (key: TranslationKey) => say(locale, key);
  const leftovers = untranslated(locale);
  /** The shell's language toggle as it reads in `shown`: labelled with the language it switches to. */
  const toggle = (shown: Locale) =>
    page.getByRole("button", {
      name: say(shown, shown === "en" ? "app.endonym.ar" : "app.endonym.en"),
      exact: true,
    });
  /**
   * Presses the toggle, which has the focus, and waits for the catalogue to have landed, not only for `dir`:
   * the catalogue loads after the locale changes, so the two are separate commits.
   */
  const pressToggle = async (to: Locale) => {
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("dir", to === "ar" ? "rtl" : "ltr");
    await expect(page.locator("html")).toHaveAttribute("lang", to);
    await expect(
      page.getByRole("heading", { level: 1, name: say(to, "pos.title"), exact: true }),
    ).toBeVisible();
  };
  return {
    t,
    leftovers,
    field: (key: TranslationKey) => page.getByLabel(t(key), { exact: true }),
    button: (key: TranslationKey) => page.getByRole("button", { name: t(key), exact: true }),
    /** The till opens in English; reach the toggle by keyboard and switch, when this run is Arabic. */
    async enter(): Promise<void> {
      if (locale === "ar") {
        await tabTo(page, toggle("en"), "Shift+Tab");
        await pressToggle("ar");
      }
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
    },
    /**
     * One view: its labelled control is showing; nothing is painted outside the viewport; one numbering
     * system; nothing in the other language; and a picture.
     */
    async view(name: string, control: Locator): Promise<void> {
      await expect(control).toBeVisible();
      const measured = await measure(page);
      expect(measured.offenders, `${name} paints outside the viewport in ${locale}`).toEqual([]);
      expect(measured.scrollWidth, `${name} scrolls horizontally in ${locale}`).toBeLessThanOrEqual(
        measured.clientWidth,
      );
      const text = await shownText(page);
      // Non-vacuous by construction: the walk saw the till's own heading in this language.
      expect(text).toContain(t("pos.title"));
      // One screen, one numbering system — spec:2253's "numerals". Every view has digits to count: the status
      // line always shows the catalogue revision and the pending count.
      expect(
        numberingSystems(text.join(" ")),
        `${name} mixes numbering systems in ${locale}`,
      ).toHaveLength(1);
      expect(
        text.filter((shown) => leftovers.has(shown)),
        `${name} shows untranslated text in ${locale}`,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`till-${name}-${locale}.png`),
        fullPage: true,
      });
    },
    /**
     * The same view in the other language, on the same state: switched by keyboard and back, then Tab to
     * `back`, the control the next step starts from. Both languages must show the same number of each kind of
     * thing and the same figures, and each must write a timestamp its own way. Returns both readings.
     */
    async parity(name: string, back: Locator) {
      const there = otherThan(locale);
      const here = await signature(page);
      await tabTo(page, toggle(locale), "Shift+Tab");
      await pressToggle(there);
      const mirrored = await signature(page);
      await pressToggle(locale);
      expect(mirrored.counts, `${name} shows a different set of things in ${there}`).toEqual(
        here.counts,
      );
      expect(mirrored.figures, `${name} shows different figures in ${there}`).toEqual(here.figures);
      expect(
        mirrored.timestamps,
        `${name} shows a different number of times in ${there}`,
      ).toHaveLength(here.timestamps.length);
      mirrored.timestamps.forEach((stamp, index) =>
        expect(stamp, `${name}'s time is not written the ${there} way`).not.toBe(
          here.timestamps[index],
        ),
      );
      await tabTo(page, back);
      return { here, mirrored };
    },
  };
};

/** An exception the page throws, in its own words rather than as a later "element not found". */
const watchErrors = (page: Page): string[] => {
  const thrown: string[] = [];
  page.on("pageerror", (error) => thrown.push(`${error.name}: ${error.message}`));
  return thrown;
};

for (const locale of LOCALES) {
  test(`an unenrolled till's enrol form lays out in ${locale}`, async ({ page }, testInfo) => {
    const { field, t, enter, view, parity } = screens(page, locale, testInfo);
    const thrown = watchErrors(page);
    const till = await openTill(page, served!.origin, { enrolled: false });
    try {
      await page.goto(served!.url);
      expect(thrown, "the till threw while loading").toEqual([]);
      // `pos.exe`'s first screen: the one-time code, focused, in English whichever language this run ends in.
      await expect(page.getByLabel(say("en", "pos.enrolCode"), { exact: true })).toBeFocused();
      await enter();
      const code = field("pos.enrolCode");
      await tabTo(page, code);
      await view("enrol", code);
      await parity("enrol", code);

      // A well-formed code with no server to answer it: refused, and said in the till's language.
      await page.keyboard.type("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
      await page.keyboard.press("Enter");
      const refused = page.getByRole("alert");
      await expect(refused).toContainText(t("pos.error"));
      await view("enrol-refused", refused);
      await parity("enrol-refused", code);
      expect(thrown, "the till threw").toEqual([]);
    } finally {
      await till.close();
    }
  });

  test(`the till's screens lay out in ${locale} and a sale completes by keyboard`, async ({
    page,
  }, testInfo) => {
    const { t, field, button, leftovers, enter, view, parity } = screens(page, locale, testInfo);
    const money = (amount: string) => formatMoney({ amount, currency: "MYR" }, { locale });
    const itemName = locale === "ar" ? ITEM.nameAr : ITEM.nameEn;

    const thrown = watchErrors(page);
    const till = await openTill(page, served!.origin);
    try {
      await page.goto(served!.url);
      expect(thrown, "the till threw while loading").toEqual([]);
      // The till opens in English with the employee number focused, whichever language this run ends in.
      await expect(page.getByLabel(say("en", "pos.employeeNumber"), { exact: true })).toBeFocused();
      const employee = field("pos.employeeNumber");
      // The language toggle is the shell's, labelled in the language it switches to; it is reached and
      // pressed by keyboard like everything else here.
      await enter();
      await tabTo(page, employee);
      // The page runs under `pos.exe`'s own policy, proved by its effect as `posture.spec.ts` proves it: an
      // inline script is refused. Without it, a bundle that evaluates strings would pass here and open blank.
      const inlineScriptRan = await page.evaluate(
        () =>
          new Promise<boolean>((settle) => {
            const probe = globalThis as unknown as Record<string, unknown>;
            probe["duljaTillCspProbe"] = false;
            const element = document.createElement("script");
            element.textContent = "window.duljaTillCspProbe = true;";
            document.head.append(element);
            setTimeout(() => settle(probe["duljaTillCspProbe"] === true), 100);
          }),
      );
      expect(inlineScriptRan, "the till's CSP is not in force").toBe(false);
      // An enrolled till with no network: the status line says so in the till's language.
      await expect(page.getByText(t("pos.offline"), { exact: true })).toBeVisible();
      await view("login", employee);
      await parity("login", employee);

      // Sign in and open the shift: type, Tab, Enter.
      await page.keyboard.type(CASHIER.employeeNumber);
      await page.keyboard.press("Tab");
      await expect(field("pos.pin")).toBeFocused();
      await page.keyboard.type(CASHIER.pin);
      await page.keyboard.press("Enter");
      const float = field("pos.openingFloat");
      await expect(float).toBeFocused();
      await view("open-shift", float);
      await parity("open-shift", float);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("100");
      await page.keyboard.press("Enter");

      // Sell: the scanner's keystrokes, then Enter, put the item on the ticket.
      const barcode = field("pos.barcode");
      await expect(barcode).toBeFocused();
      await page.keyboard.type(ITEM.barcode);
      await page.keyboard.press("Enter");
      await expect(field("pos.quantity")).toBeVisible();
      await expect(button("pos.submit")).toBeEnabled();
      await view("sell", barcode);
      await parity("sell", barcode);
      // The hint at the foot names the keys as the keyboard prints them, in both languages: a cashier who
      // reads "key 2" presses 2, which types a digit into the scan field.
      const shortcuts = page.locator(".shortcuts");
      for (const key of ["F2", "F4", "F8", "F10"]) await expect(shortcuts).toContainText(key);

      // F8 reviews the ticket. Payment opens on the amount, pre-filled with the cash total rounded to the
      // branch's 0.05 (3.33 → 3.35); the customer hands over 5.
      await page.keyboard.press("F8");
      const amount = field("pos.amount");
      await expect(amount).toBeFocused();
      await expect(amount).toHaveValue("3.3500");
      await view("tender", amount);
      await parity("tender", amount);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("5");
      await expect(amount).toHaveValue("5");
      await tabTo(page, button("pos.complete"));
      await page.keyboard.press("Enter");

      const receipt = page.getByRole("article", { name: t("pos.receipt") });
      await expect(receipt).toBeVisible();
      await expect(receipt).toContainText(itemName);
      await expect(receipt.getByText(money("1.6500"), { exact: true })).toBeVisible();
      // Column order follows the reading direction: the item column is painted on the reader's start side.
      const columns = await receipt
        .getByRole("columnheader")
        .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().x));
      expect(columns).toHaveLength(5);
      expect(columns[0]! < columns[1]!, `receipt columns in ${locale}`).toBe(locale === "en");
      // The sale's date, Gregorian in both locales, keeps its year's digits in reading order inside a
      // right-to-left line: the half of spec:2253 that says "numerals".
      const soldAt = receipt.locator("dd").nth(1);
      const year = /20\d\d/.exec(await soldAt.innerText())?.[0] ?? "";
      expect(year, "the receipt's date has no year").toHaveLength(4);
      const century = await sliceBox(soldAt, year, { from: 0, length: 2 });
      const decade = await sliceBox(soldAt, year, { from: 2, length: 2 });
      expect(century.right, `"${year}" is painted back to front`).toBeLessThanOrEqual(
        decade.left + 0.5,
      );
      await view("receipt", receipt);
      const read = await parity("receipt", button("pos.nextSale"));
      // The receipt's own time is among those written each language's way.
      expect(read.here.timestamps).toContain((await soldAt.innerText()).trim());
      const reference = (await receipt.locator("dd").first().innerText()).trim();
      await page.keyboard.press("Enter");
      await expect(barcode).toBeFocused();

      // Return mode, by keyboard: Space ticks it, the original's reference loads its line back.
      const returning = page.getByRole("checkbox", { name: t("pos.return"), exact: true });
      await tabTo(page, returning);
      await page.keyboard.press("Space");
      await expect(returning).toBeChecked();
      const original = field("pos.original");
      await tabTo(page, original);
      await page.keyboard.type(reference);
      await tabTo(page, button("pos.loadOriginal"));
      await page.keyboard.press("Enter");
      await expect(field("pos.quantity")).toBeVisible();
      await expect(page.locator("legend")).toContainText(itemName);
      await view("return", original);
      // Back out of it: remove the loaded line, then untick the return.
      await parity("return", button("pos.remove"));
      await page.keyboard.press("Enter");
      await expect(field("pos.quantity")).toHaveCount(0);
      await tabTo(page, returning, "Shift+Tab");
      await page.keyboard.press("Space");
      await expect(returning).not.toBeChecked();

      // The supervisor approval is a disclosure: Enter on its summary opens it, and again closes it.
      const approval = page.locator("summary").filter({ hasText: t("pos.approval") });
      await tabTo(page, approval);
      await page.keyboard.press("Enter");
      const supervisor = field("pos.supervisor");
      await expect(supervisor).toBeVisible();
      await view("approval", supervisor);
      await parity("approval", approval);
      await page.keyboard.press("Enter");
      await expect(supervisor).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(barcode).toBeFocused();

      // The three function-key views, price check and customer each closed with Escape back to the scan field.
      await page.keyboard.press("F2");
      const query = field("pos.priceCheckQuery");
      await expect(query).toBeFocused();
      await page.keyboard.type(ITEM.barcode);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("listitem").filter({ hasText: itemName })).toBeVisible();
      await view("price-check", query);
      await parity("price-check", query);
      await page.keyboard.press("Escape");
      await expect(barcode).toBeFocused();

      await page.keyboard.press("F4");
      const customer = field("pos.customerQuery");
      await expect(customer).toBeFocused();
      await view("customer", customer);
      await parity("customer", customer);
      await page.keyboard.press("Escape");
      await expect(barcode).toBeFocused();

      await page.keyboard.press("F10");
      const counted = field("pos.countedCash");
      await expect(counted).toBeFocused();
      await view("shift", counted);
      await parity("shift", counted);

      // Close it: the count at a person's pace (a scanner's speed is refused as a scan, UI-02), then Enter shows
      // it for review beside the float and the till's own totals, with the cursor on Change count; Tab and Enter
      // confirm. The till lists what it settled by method — the sale's 3.35 in cash; the server works out the
      // expected cash and over/short after sync — and offers the next shift.
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("103.35", { delay: 80 });
      await page.keyboard.press("Enter");
      const review = page.getByRole("region", { name: t("pos.confirmClose") });
      await expect(review).toContainText(money("103.3500"));
      await expect(review).toContainText(money("100.0000"));
      const changeCount = button("pos.changeCount");
      await expect(changeCount).toBeFocused();
      await view("shift-review", changeCount);
      await parity("shift-review", changeCount);
      await page.keyboard.press("Tab");
      await expect(button("pos.confirmClose")).toBeFocused();
      await page.keyboard.press("Enter");
      const settled = page.getByRole("listitem").filter({ hasText: t("pos.cash") });
      await expect(settled).toContainText(money("3.3500"));
      await expect(float).toBeVisible();
      await view("shift-closed", settled);
      await parity("shift-closed", float);

      // Positive controls, so the empty findings above are measurements and not checks that cannot fail: a box
      // wider than the window is reported on whichever side this direction pushes it, a string of the other
      // catalogue is caught, and one Arabic-Indic digit beside the till's Western ones makes two systems.
      const stray = say(otherThan(locale), "pos.title");
      await page.evaluate((text) => {
        const wide = document.createElement("div");
        wide.id = "overflow-probe";
        wide.textContent = text;
        const digit = document.createElement("span");
        digit.textContent = "\u0663";
        wide.append(digit);
        // CSSOM, not a `style` attribute: the till's CSP refuses inline style, as `pos.exe`'s does.
        wide.style.inlineSize = "3000px";
        document.querySelector(".pos-app")!.append(wide);
      }, stray);
      const probed = await measure(page);
      expect(
        probed.offenders.some((offender) => offender.startsWith("div [")),
        `the overflow probe went unreported in ${locale}`,
      ).toBe(true);
      const probedText = await shownText(page);
      expect(probedText.filter((shown) => leftovers.has(shown))).toEqual([stray]);
      expect(numberingSystems(probedText.join(" "))).toEqual(["arab", "latn"]);
      await page.evaluate(() => document.getElementById("overflow-probe")!.remove());
      expect(thrown, "the till threw").toEqual([]);
    } finally {
      await till.close();
    }
  });
}
