import { ZReportList } from "@dulja/contracts/pos/reports";
import {
  CATALOGUES,
  formatMoney,
  formatTimestamp,
  type Locale,
  type TranslationKey,
} from "@dulja/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/lib/i18n-provider";
import { ZReportRoute } from "../src/routes/pos/z-report";
import { RouterAround } from "./support/router";

const COMPANY = "0192cccc-0001-7000-8000-000000000001";
const SHIFT = "01930000-0000-7000-8000-000000000001";
const DOCUMENT = "01930000-0000-7000-8000-0000000000aa";
const OPENED_AT = "2026-01-15T01:00:00.000Z";
const myr = (amount: string) => ({ amount, currency: "MYR" });

type Report = ReturnType<typeof ZReportList.parse>["items"][number];
/** A closed, short shift whose TILL_OVER_SHORT posted — the paper report an auditor traces. */
const SHORT: Report = {
  shiftId: SHIFT,
  branchId: "0192aaaa-0001-7000-8000-000000000001",
  terminalId: "0192eeee-0001-7000-8000-000000000001",
  terminalCode: "KL01",
  openedAt: OPENED_AT,
  closedAt: "2026-01-15T13:00:00.000Z",
  openedPrincipalId: "0192dddd-0001-7000-8000-000000000001",
  closedPrincipalId: "0192dddd-0001-7000-8000-000000000001",
  currency: "MYR",
  openingFloat: myr("200.0000"),
  countedCash: myr("386.0000"),
  expectedCash: myr("387.5000"),
  overShort: myr("-1.5000"),
  overShortDocumentId: DOCUMENT,
  ticketCount: 8,
  returnCount: 1,
  tenders: [{ method: "cash", accountCode: "1110", amount: myr("187.5000") }],
  cashControl: [{ documentTypeCode: "TILL_OVER_SHORT", amount: myr("-1.5000") }],
  tillEvents: [
    { kind: "no_sale", count: 2 },
    { kind: "void", count: 1 },
  ],
};
/** An exact count: nothing posted, so nothing moved in cash control and no document to name. */
const EXACT: Report = {
  ...SHORT,
  countedCash: myr("387.5000"),
  overShort: myr("0.0000"),
  overShortDocumentId: null,
  cashControl: [],
  tillEvents: [],
};

/** `Intl` separates a currency code with a no-break space; jest-dom compares collapsed whitespace. */
const text = (value: string) => value.replace(/\s+/g, " ");
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function mount(locale: Locale, report: Report) {
  const body = ZReportList.parse({ items: [report], next_cursor: null });
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const url = new URL(String(input));
    if (url.pathname.endsWith("/reports/pos.z_report")) return json(body);
    if (url.pathname.endsWith("/till-events")) return json({ items: [], next_cursor: null });
    throw new Error(`unexpected request ${url.pathname}`);
  });
  render(
    <StrictMode>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterAround>
          <I18nProvider store={{ read: () => locale, write: () => undefined }}>
            <ZReportRoute
              api={{ baseUrl: "https://example.test", accessToken: () => "staff", fetchImpl }}
              companyId={COMPANY}
              shiftId={SHIFT}
            />
          </I18nProvider>
        </RouterAround>
      </QueryClientProvider>
    </StrictMode>,
  );
  return { say: (key: TranslationKey) => CATALOGUES[locale][key]! };
}
const article = (say: (key: TranslationKey) => string) =>
  screen.findByRole("article", { name: say("shift.zReport") });
/** The `<dd>` beside a `<dt>` of the drawer section. */
const figure = (report: HTMLElement, label: string) =>
  within(report).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
const printed = (element: Element) => element.closest('[data-print="hide"]') === null;

describe("the Z-report (6D Task 12)", () => {
  it.each(["en", "ar"] as const)(
    "names the TILL_OVER_SHORT document beside the over/short, on paper, in %s",
    async (locale) => {
      const { say } = mount(locale, SHORT);
      const report = await article(say);
      const overShort = figure(report, say("shift.difference"));
      expect(overShort).toHaveTextContent(text(formatMoney(myr("-1.5000"), { locale })));
      expect(overShort).toHaveTextContent(say("shift.overShortDocument"));
      const id = within(overShort).getByText(DOCUMENT);
      expect(id.tagName).toBe("BDI");
      expect(printed(id)).toBe(true);
    },
  );

  it("names no document when the count was exact", async () => {
    const { say } = mount("en", EXACT);
    const report = await article(say);
    expect(within(report).queryByText(say("shift.overShortDocument"), { exact: false })).toBeNull();
    expect(figure(report, say("shift.difference")).querySelector("[data-tone]")).toHaveAttribute(
      "data-tone",
      "none",
    );
  });

  it.each(["en", "ar"] as const)(
    "tones the over/short and nothing else on the report, in %s",
    async (locale) => {
      const { say } = mount(locale, SHORT);
      const report = await article(say);
      const toned = [...report.querySelectorAll("[data-tone]")].filter(
        (e) => e.getAttribute("data-tone") !== "none",
      );
      expect(toned).toHaveLength(1);
      expect(toned[0]).toHaveAttribute("data-tone", "short");
      expect(toned[0]).toHaveClass("text-danger");
      expect(report.querySelectorAll(".text-danger, .text-success")).toHaveLength(1);
    },
  );

  it.each(["en", "ar"] as const)(
    "renders the cash-control section empty, not absent, when nothing moved, in %s",
    async (locale) => {
      const { say } = mount(locale, EXACT);
      await article(say);
      const control = screen.getByRole("table", { name: say("shift.control") });
      expect(within(control).getByText(say("app.empty"))).toBeInTheDocument();
      expect(printed(control)).toBe(true);
    },
  );

  it.each(["en", "ar"] as const)(
    "translates the cash-control document type and shows each tender's account, in %s",
    async (locale) => {
      const { say } = mount(locale, SHORT);
      const report = await article(say);
      const control = screen.getByRole("table", { name: say("shift.control") });
      expect(
        within(control).getByRole("cell", { name: say("documentType.TILL_OVER_SHORT") }),
      ).toBeInTheDocument();
      expect(report.textContent).not.toContain("TILL_OVER_SHORT");
      const tenders = screen.getByRole("table", { name: say("shift.tenders") });
      const headers = within(tenders)
        .getAllByRole("columnheader")
        .map((h) => h.textContent);
      expect(headers).toEqual([say("shift.method"), say("shift.account"), say("shift.amount")]);
      expect(within(tenders).getByRole("cell", { name: "1110" })).toBeInTheDocument();
    },
  );

  it.each(["en", "ar"] as const)("prints the per-kind till-event counts, in %s", async (locale) => {
    const { say } = mount(locale, SHORT);
    await article(say);
    const counts = screen.getByRole("list", { name: say("shift.eventCounts") });
    const items = within(counts)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items).toEqual([`${say("shift.no_sale")}: 2`, `${say("shift.void")}: 1`]);
    expect(printed(counts)).toBe(true);
  });

  it.each(["en", "ar"] as const)(
    "formats money in its currency and times in the company's zone, in %s",
    async (locale) => {
      const { say } = mount(locale, SHORT);
      const report = await article(say);
      expect(figure(report, say("shift.opening"))).toHaveTextContent(
        text(formatMoney(myr("200.0000"), { locale })),
      );
      expect(report.textContent).not.toContain("200.0000");
      expect(report.querySelector("header")).toHaveTextContent(
        text(formatTimestamp(OPENED_AT, { locale })),
      );
      // The terminal code and both times are isolated, or right-to-left Arabic reorders them.
      expect(
        [...report.querySelectorAll("header p:first-of-type bdi")].map((b) => b.textContent),
      ).toEqual([
        "KL01",
        formatTimestamp(OPENED_AT, { locale }),
        formatTimestamp(SHORT.closedAt!, { locale }),
      ]);
    },
  );

  it("is a single 80 mm column that fills the page when printed", async () => {
    const { say } = mount("en", SHORT);
    const report = await article(say);
    expect(report).toHaveClass("w-[80mm]", "print:w-full");
    // The print rule (in `app.css`) keeps exactly what holds or sits inside this mark. It is never an inline
    // `<style>`: backoffice.exe's `style-src 'self'` refuses one, and the whole page would print.
    expect(report).toHaveAttribute("data-z-report");
    expect(document.querySelector("style")).toBeNull();
  });
});
