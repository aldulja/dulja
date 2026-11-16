import { ShiftList } from "@dulja/contracts/pos/shift";
import { SalesByCashierList, ZReportList } from "@dulja/contracts/pos/reports";
import {
  CATALOGUES,
  formatMoney,
  formatTimestamp,
  type Locale,
  type TranslationKey,
} from "@dulja/i18n";
import { PHYSICAL_PROPERTY_PATTERNS } from "@dulja/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/lib/i18n-provider";
import { SHIFT_TIME_ZONE, todayIn } from "../src/lib/shift-api";
import { ShiftsRoute } from "../src/routes/pos/shifts";

const COMPANY = "0192cccc-0001-7000-8000-000000000001";
const OTHER_COMPANY = "0192cccc-0002-7000-8000-000000000002";
const BRANCH = "0192aaaa-0001-7000-8000-000000000001";
const TERMINAL = "0192eeee-0001-7000-8000-000000000001";
const CASHIER = "0192dddd-0001-7000-8000-000000000001";
const SHORT = "01930000-0000-7000-8000-000000000001";
const OVER = "01930000-0000-7000-8000-000000000002";
const EXACT = "01930000-0000-7000-8000-000000000003";
const OPEN = "01930000-0000-7000-8000-000000000004";
const OPENED_AT = "2026-01-15T01:00:00.000Z";
const CLOSED_AT = "2026-01-15T13:00:00.000Z";

const myr = (amount: string) => ({ amount, currency: "MYR" });
/** One `ShiftSchema` row; `overShort: null` with `closedAt: null` is a shift still open. */
const shift = (shiftId: string, terminalCode: string, overShort: string | null) => {
  const closed = overShort !== null;
  return {
    shiftId,
    branchId: BRANCH,
    terminalId: TERMINAL,
    terminalCode,
    openedAt: OPENED_AT,
    closedAt: closed ? CLOSED_AT : null,
    openedPrincipalId: CASHIER,
    closedPrincipalId: closed ? CASHIER : null,
    currency: "MYR",
    openingFloat: myr("200.0000"),
    countedCash: closed ? myr("386.0000") : null,
    expectedCash: closed ? myr("387.5000") : null,
    overShort: closed ? myr(overShort) : null,
    overShortDocumentId: null,
  };
};
const zReport = (row: ReturnType<typeof shift>) => ({
  ...row,
  ticketCount: 8,
  returnCount: 1,
  tenders: [{ method: "cash", accountCode: "1110", amount: myr("187.5000") }],
  cashControl: [],
  tillEvents: [{ kind: "no_sale", count: 1 }],
});
const salesRow = {
  cashierPrincipalId: CASHIER,
  cashierName: "Aminah",
  branchId: BRANCH,
  ticketCount: 8,
  returnCount: 1,
  netSales: myr("1234.5000"),
  discount: myr("-3.2500"),
  cashRounding: myr("0.0200"),
  overShort: myr("-1.5000"),
};

/** `Intl` separates a currency code with a no-break space; jest-dom compares collapsed whitespace. */
const text = (value: string) => value.replace(/\s+/g, " ");
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function mount(locale: Locale, rows: ReturnType<typeof shift>[], options: { at?: string } = {}) {
  // Every stubbed body is first checked against the wire schema the screen parses it with, so a
  // fixture that drifts from the contract fails here rather than as a puzzling empty screen.
  const shifts = ShiftList.parse({ items: rows, next_cursor: null });
  const reports = new Map(rows.map((row) => [row.shiftId, zReport(row)]));
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const url = new URL(String(input));
    if (url.pathname.endsWith("staff-context"))
      return json({
        companies: [
          {
            id: COMPANY,
            code: "MY",
            name: "Company",
            baseCurrency: "MYR",
            branches: [{ id: BRANCH, code: "HQ", nameEn: "Head office", nameAr: "المقر الرئيسي" }],
          },
        ],
      });
    if (url.pathname.endsWith("/till-events")) return json({ items: [], next_cursor: null });
    if (url.pathname.endsWith("/shifts")) return json(shifts);
    if (url.pathname.endsWith("/reports/pos.z_report")) {
      const report = reports.get(url.searchParams.get("shiftId") ?? "");
      return json(ZReportList.parse({ items: report ? [report] : [], next_cursor: null }));
    }
    if (url.pathname.endsWith("/reports/pos.sales_by_cashier"))
      return json(SalesByCashierList.parse({ items: [salesRow], next_cursor: null }));
    throw new Error(`unexpected request ${url.pathname}`);
  });
  const api = { baseUrl: "https://example.test", accessToken: () => "staff", fetchImpl };
  // The two paths the app registers (router.tsx), without the shell's session guards: the report's
  // route renders nothing of its own, so the register above it stays mounted, as in the app.
  const root = createRootRoute();
  const register = createRoute({
    getParentRoute: () => root,
    path: "/pos/shifts",
    component: () => (
      <I18nProvider store={{ read: () => locale, write: () => undefined }}>
        <ShiftsRoute api={api} />
      </I18nProvider>
    ),
  });
  const report = createRoute({
    getParentRoute: () => register,
    path: "$shiftId/z-report",
    validateSearch: (search: Record<string, unknown>): { company?: string } =>
      typeof search["company"] === "string" ? { company: search["company"] } : {},
  });
  const router = createRouter({
    routeTree: root.addChildren([register.addChildren([report])]),
    history: createMemoryHistory({ initialEntries: [options.at ?? "/pos/shifts"] }),
  });
  render(
    <StrictMode>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
  const say = (key: TranslationKey) => CATALOGUES[locale][key]!;
  return { user: userEvent.setup(), router, say, fetchImpl };
}
const register = async (say: (key: TranslationKey) => string) =>
  screen.findByRole("table", { name: say("shift.title") });
const row = (table: HTMLElement, terminal: string) =>
  within(table).getByRole("button", { name: terminal }).closest("tr")!;

describe("the shift register (6D Task 12)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters on the company's today, not the UTC day, by default", async () => {
    // 17:41 UTC on 23 October is 01:41 on 24 October in Kuala Lumpur: a shift opened since midnight
    // there is on the 24th, the date the API filters `opened_at` by (in the company's zone).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T17:41:00.000Z"));
    const { say, fetchImpl } = mount("en", [shift(SHORT, "KL01", "-1.5000")]);
    await register(say);
    expect(screen.getByLabelText(say("shift.from"))).toHaveValue("2026-10-24");
    expect(screen.getByLabelText(say("shift.to"))).toHaveValue("2026-10-24");
    const request = fetchImpl.mock.calls
      .map(([url]) => new URL(String(url)))
      .find((url) => url.pathname.endsWith("/shifts"))!;
    expect(request.searchParams.get("filter[openedAt][gte]")).toBe("2026-10-24");
    expect(request.searchParams.get("filter[openedAt][lte]")).toBe("2026-10-24");
  });

  it("reads today in the given zone on either side of its midnight", () => {
    expect(SHIFT_TIME_ZONE).toBe("Asia/Kuala_Lumpur");
    expect(todayIn(SHIFT_TIME_ZONE, new Date("2026-10-23T15:59:59.000Z"))).toBe("2026-10-23");
    expect(todayIn(SHIFT_TIME_ZONE, new Date("2026-10-23T16:00:00.000Z"))).toBe("2026-10-24");
    expect(todayIn("UTC", new Date("2026-12-31T23:59:59.000Z"))).toBe("2026-12-31");
  });

  it.each(["en", "ar"] as const)(
    "tones a short drawer red and an over drawer green, and an exact one not at all, in %s",
    async (locale) => {
      const { say } = mount(locale, [
        shift(SHORT, "KL01", "-1.5000"),
        shift(OVER, "KL02", "2.0000"),
        shift(EXACT, "KL03", "0.0000"),
      ]);
      const table = await register(say);
      const toned = [...table.querySelectorAll("[data-tone]")];
      expect(toned.map((e) => e.getAttribute("data-tone"))).toEqual(["short", "over", "none"]);
      expect(toned[0]).toHaveClass("text-danger");
      expect(toned[1]).toHaveClass("text-success");
      expect(toned[2]).not.toHaveAttribute("class");
      // The figure itself goes through the currency's display rounding, never the raw wire string.
      expect(toned[0]).toHaveTextContent(text(formatMoney(myr("-1.5000"), { locale })));
      expect(table.textContent).not.toContain("1.5000");
    },
  );

  it.each(["en", "ar"] as const)(
    "shows an open shift's three close figures as em dashes, never a zero, in %s",
    async (locale) => {
      const { say } = mount(locale, [shift(OPEN, "KL01", null)]);
      const table = await register(say);
      const headers = within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent);
      expect(headers).toEqual([
        say("shift.terminal"),
        say("shift.opened"),
        say("shift.closedAt"),
        say("shift.cashier"),
        say("shift.counted"),
        say("shift.difference"),
      ]);
      const cells = within(row(table, "KL01")).getAllByRole("cell");
      // closedAt, countedCash and overShort: "not counted yet" must not read as "counted at nothing".
      expect(cells.filter((cell) => cell.textContent === "—")).toHaveLength(3);
      expect(table.textContent).not.toMatch(/0\.00/);
      expect(table.querySelector("[data-tone]")).toHaveAttribute("data-tone", "none");
      // The opening time is the company's zone (formatTimestamp's), not the test host's.
      expect(cells[1]).toHaveTextContent(text(formatTimestamp(OPENED_AT, { locale })));
      expect(cells[3]).toHaveTextContent(CASHIER);
    },
  );

  it("shows a closed shift's close time and counted cash, formatted", async () => {
    const { say } = mount("en", [shift(SHORT, "KL01", "-1.5000")]);
    const cells = within(row(await register(say), "KL01")).getAllByRole("cell");
    expect(cells[2]).toHaveTextContent(text(formatTimestamp(CLOSED_AT, { locale: "en" })));
    expect(cells[4]).toHaveTextContent(text(formatMoney(myr("386.0000"), { locale: "en" })));
  });

  it.each(["en", "ar"] as const)(
    "sends '/' to the branch filter, but not from inside a date being typed, in %s",
    async (locale) => {
      const { user, say } = mount(locale, [shift(SHORT, "KL01", "-1.5000")]);
      const table = await register(say);
      const cell = within(row(table, "KL01")).getAllByRole("cell")[0]!;
      cell.focus();
      await user.keyboard("/");
      expect(screen.getByLabelText(say("staff.branch"))).toHaveFocus();
      const from = screen.getByLabelText(say("shift.from"));
      from.focus();
      await user.keyboard("/");
      expect(from).toHaveFocus();
    },
  );

  it.each(["en", "ar"] as const)(
    "opens the Z-report with Enter at its own address and closes it with Esc, focus restored, in %s",
    async (locale) => {
      const { user, router, say } = mount(locale, [
        shift(SHORT, "KL01", "-1.5000"),
        shift(OVER, "KL02", "2.0000"),
      ]);
      const table = await register(say);
      const cell = within(row(table, "KL02")).getAllByRole("cell")[2]!;
      cell.focus();
      await user.keyboard("{Enter}");
      const report = await screen.findByRole("article", { name: say("shift.zReport") });
      expect(within(report).getByText(/KL02/)).toBeInTheDocument();
      expect(router.state.location.pathname).toBe(`/pos/shifts/${OVER}/z-report`);
      expect(router.state.location.search).toEqual({ company: COMPANY });
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("article", { name: say("shift.zReport") })).toBeNull(),
      );
      expect(router.state.location.pathname).toBe("/pos/shifts");
      expect(cell).toHaveFocus();
    },
  );

  it("returns focus to the terminal button that opened the report, and back closes it", async () => {
    const { user, router, say } = mount("en", [shift(SHORT, "KL01", "-1.5000")]);
    const table = await register(say);
    const terminal = within(table).getByRole("button", { name: "KL01" });
    await user.click(terminal);
    await screen.findByRole("article", { name: say("shift.zReport") });
    await user.keyboard("{Escape}");
    // The grid keeps its one tab stop on the cell, so focus lands on the cell holding the button.
    await waitFor(() => expect(terminal.closest("td")).toHaveFocus());
    expect(screen.queryByRole("article", { name: say("shift.zReport") })).toBeNull();
    // The browser's back, too, closes a report the operator opened.
    await user.click(terminal);
    await screen.findByRole("article", { name: say("shift.zReport") });
    router.history.back();
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: say("shift.zReport") })).toBeNull(),
    );
    expect(screen.getByRole("table", { name: say("shift.title") })).toBeInTheDocument();
  });

  it("pops the report's history entry on Esc, so back does not reopen a report just closed", async () => {
    const { user, router, say } = mount("en", [
      shift(SHORT, "KL01", "-1.5000"),
      shift(OVER, "KL02", "2.0000"),
    ]);
    const table = await register(say);
    // A manager scanning drawers: Enter on one, Enter on the next, then Esc back to the list.
    within(row(table, "KL01")).getAllByRole("cell")[0]!.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("article", { name: say("shift.zReport") });
    within(row(table, "KL02")).getAllByRole("cell")[0]!.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/pos/shifts/${OVER}/z-report`),
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: say("shift.zReport") })).toBeNull(),
    );
    expect(router.state.location.pathname).toBe("/pos/shifts");
    // The register's own entry is the current one again: nothing behind it reopens a report.
    expect(router.history.canGoBack()).toBe(false);
    router.history.back();
    await waitFor(() => expect(router.state.location.pathname).toBe("/pos/shifts"));
    expect(screen.queryByRole("article", { name: say("shift.zReport") })).toBeNull();
  });

  it("closes a linked Z-report on Esc in place, without adding a history entry", async () => {
    const { user, router, say } = mount("en", [shift(SHORT, "KL01", "-1.5000")], {
      at: `/pos/shifts/${SHORT}/z-report?company=${COMPANY}`,
    });
    await screen.findByRole("article", { name: say("shift.zReport") });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: say("shift.zReport") })).toBeNull(),
    );
    expect(router.state.location.pathname).toBe("/pos/shifts");
    expect(router.history.length).toBe(1);
    expect(router.history.canGoBack()).toBe(false);
  });

  it("opens a linked Z-report, and not under a company it was not opened from", async () => {
    const { say } = mount("en", [shift(SHORT, "KL01", "-1.5000")], {
      at: `/pos/shifts/${SHORT}/z-report?company=${COMPANY}`,
    });
    expect(await screen.findByRole("article", { name: say("shift.zReport") })).toBeInTheDocument();
  });

  it("keeps a report opened from another company closed", async () => {
    const { say, fetchImpl } = mount("en", [shift(SHORT, "KL01", "-1.5000")], {
      at: `/pos/shifts/${SHORT}/z-report?company=${OTHER_COMPANY}`,
    });
    await register(say);
    expect(screen.queryByRole("article", { name: say("shift.zReport") })).toBeNull();
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContainEqual(
      expect.stringContaining("pos.z_report"),
    );
  });

  it.each(["en", "ar"] as const)(
    "shows sales by cashier with every amount in its currency, the over/short toned, in %s",
    async (locale) => {
      const { user, say } = mount(locale, [shift(SHORT, "KL01", "-1.5000")]);
      await register(say);
      await user.selectOptions(screen.getByLabelText(say("shift.view")), "sales");
      const table = await screen.findByRole("table", { name: say("shift.sales") });
      const headers = within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent);
      const cells = within(table).getAllByRole("cell");
      const under = (key: TranslationKey) => cells[headers.indexOf(say(key))]?.textContent;
      const money = (amount: string) => formatMoney(myr(amount), { locale });
      expect(under("shift.net")).toBe(money("1234.5000"));
      expect(under("pos.discount")).toBe(money("-3.2500"));
      expect(under("pos.rounding")).toBe(money("0.0200"));
      expect(under("shift.difference")).toBe(money("-1.5000"));
      expect(table.querySelector("[data-tone]")).toHaveAttribute("data-tone", "short");
    },
  );

  it.each(["en", "ar"] as const)("renders no physical-property class in %s", async (locale) => {
    const { user, say } = mount(locale, [shift(SHORT, "KL01", "-1.5000")]);
    await user.click(within(await register(say)).getByRole("button", { name: "KL01" }));
    await screen.findByRole("article", { name: say("shift.zReport") });
    const classes = [...document.body.querySelectorAll("[class]")]
      .map((e) => e.getAttribute("class"))
      .join(" ");
    for (const pattern of PHYSICAL_PROPERTY_PATTERNS)
      expect(classes).not.toMatch(new RegExp(pattern));
  });
});
