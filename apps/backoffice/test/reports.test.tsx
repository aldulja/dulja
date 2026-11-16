import {
  CreateReportRunBody,
  PartySchema,
  ReportDefinitionList,
  ReportRunSchema,
  SavedViewList,
} from "@dulja/contracts";
import type { Locale } from "@dulja/i18n";
import { PHYSICAL_PROPERTY_PATTERNS } from "@dulja/ui";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOKUP_MAX_PAGES } from "../src/lib/report-api";
import { ReportsRoute } from "../src/routes/reports/index";
import { ReportRunRoute } from "../src/routes/reports/$code";
import {
  ACTOR,
  calls,
  CODE,
  COMPANY,
  CORE,
  COPY,
  definitionRow,
  fetchMock,
  json,
  mountWith,
  PERIOD,
  problem,
  RUN,
  sayIn,
  stubDownloads,
  VIEW,
  type Handler,
} from "./support/reports";

const LOAD = { timeout: 5000 };
const POLL = { timeout: 6000 };
const list = (...rows: ReturnType<typeof definitionRow>[]) => ({ items: rows, next_cursor: null });
const runRow = (status: "queued" | "running" | "done" | "failed", overrides = {}) =>
  ReportRunSchema.parse({
    id: RUN,
    companyId: COMPANY,
    reportDefinitionId: CORE,
    savedViewId: null,
    parameters: { fiscalPeriodId: PERIOD, isMatched: "false" },
    format: "csv",
    lang: "en",
    status,
    requestedBy: ACTOR,
    sha256: status === "done" ? "b".repeat(64) : null,
    finishedAt: status === "done" || status === "failed" ? "2026-11-06T01:00:00Z" : null,
    error: status === "failed" ? "ERR_VALIDATION_FAILED: the period is closed" : null,
    createdAt: "2026-11-06T00:00:00Z",
    ...overrides,
  });
const view = {
  id: VIEW,
  companyId: COMPANY,
  reportDefinitionId: CORE,
  nameEn: "Month end",
  nameAr: "نهاية الشهر",
  parameters: { fiscalPeriodId: PERIOD, isMatched: "true", currency: "MYR" },
  ownerPrincipalId: ACTOR,
  shared: false,
  archivedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
};

/** The report routes, with every lookup the run screen makes. */
function reportApi(
  options: {
    definitions?: ReturnType<typeof definitionRow>[];
    statuses?: ("queued" | "running" | "done" | "failed")[];
    run?: () => Response;
    parties?: (url: URL) => Response;
    /** Answers the run's status URL instead of the queued/done sequence. */
    status?: () => Response;
  } = {},
) {
  const statuses = [...(options.statuses ?? ["queued", "done"])];
  const handler: Handler = (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path.endsWith("/report-definitions"))
      return json(list(...(options.definitions ?? [definitionRow(CORE)])));
    if (path.endsWith("/fiscal-periods"))
      return json({
        items: [
          {
            id: PERIOD,
            startsOn: "2026-01-01",
            endsOn: "2026-01-31",
            status: "open",
            closedBy: null,
            closedAt: null,
            reopenReason: null,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        next_cursor: null,
      });
    if (path.endsWith("/parties"))
      return options.parties ? options.parties(url) : problem(403, "ERR_RBAC_FORBIDDEN");
    if (path.endsWith("/saved-views") && method === "POST")
      return json({ ...view, id: "0192ffff-0002-7000-8000-000000000002", nameEn: "Mine" }, 201);
    if (path.endsWith("/saved-views")) return json({ items: [view], next_cursor: null });
    if (path.endsWith(`/reports/${CODE}/runs`))
      return options.run
        ? options.run()
        : json(
            {
              runId: RUN,
              jobId: "job-1",
              statusUrl: `/v1/companies/${COMPANY}/report-runs/${RUN}`,
            },
            202,
          );
    if (path.endsWith(`/report-runs/${RUN}/content`))
      return new Response("Account,Debit\n1200,10.0000\n", {
        headers: { "content-type": "text/csv" },
      });
    if (path.endsWith(`/report-runs/${RUN}`))
      return options.status ? options.status() : json(runRow(statuses.shift() ?? "done"));
    if (path.endsWith("/report-runs")) return json({ items: [], next_cursor: null });
    return problem(404, "ERR_NOT_FOUND");
  };
  return fetchMock(handler);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("7A T15 — the report list", () => {
  it("uses the real wire schemas for its fixtures", () => {
    expect(ReportDefinitionList.safeParse(list(definitionRow(CORE))).success).toBe(true);
    expect(SavedViewList.safeParse({ items: [view], next_cursor: null }).success).toBe(true);
  });

  it.each(["en", "ar"] as const)(
    "lists every live definition row with its name, code, version and kind in %s",
    async (locale: Locale) => {
      const say = sayIn(locale);
      const api = reportApi({
        definitions: [
          definitionRow(CORE),
          definitionRow(COPY, { isCore: false, clonedFrom: CORE }),
        ],
      });
      const navigation = { run: vi.fn(), design: vi.fn() };
      mountWith(api, locale, (options) => (
        <ReportsRoute api={options} companyId={COMPANY} navigation={navigation} />
      ));
      const table = await screen.findByRole("table", { name: say("report.list") }, LOAD);
      await within(table).findAllByText(locale === "ar" ? "ميزان المراجعة" : "Trial balance");
      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(2);
      expect(within(rows[0]!).getByText(say("report.kind.core"))).toBeVisible();
      expect(within(rows[1]!).getByText(say("report.kind.copy"))).toBeVisible();
      expect(within(rows[0]!).getByText(CODE)).toHaveAttribute("dir", "ltr");
      expect(String(api.mock.calls[0]![0])).toBe(
        `https://example.test/v1/companies/${COMPANY}/report-definitions?limit=1000`,
      );
      expect(document.documentElement).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      const classes = [...document.body.querySelectorAll("[class]")]
        .map((e) => e.getAttribute("class"))
        .join(" ");
      for (const pattern of PHYSICAL_PROPERTY_PATTERNS)
        expect(classes).not.toMatch(new RegExp(pattern));
    },
  );

  it("runs a row with Enter, designs one with Shift+Enter or its button, and focuses the filter with /", async () => {
    const say = sayIn("en");
    const navigation = { run: vi.fn(), design: vi.fn() };
    const user = mountWith(reportApi(), "en", (options) => (
      <ReportsRoute api={options} companyId={COMPANY} navigation={navigation} />
    ));
    const table = await screen.findByRole("table", { name: say("report.list") }, LOAD);
    await within(table).findByText("Trial balance");
    const cell = within(table).getAllByRole("cell")[0]!;
    cell.focus();
    await user.keyboard("{Enter}");
    expect(navigation.run).toHaveBeenCalledWith(CODE, CORE);
    await user.click(within(table).getByRole("button", { name: say("report.design") }));
    expect(navigation.design).toHaveBeenCalledWith(CODE, CORE);
    // Shift+Enter designs the row the cursor is on; it never also runs it.
    within(table).getAllByRole("cell")[1]!.focus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(navigation.design).toHaveBeenCalledTimes(2);
    expect(navigation.run).toHaveBeenCalledTimes(1);
    cell.focus();
    await user.keyboard("/");
    expect(screen.getByLabelText(say("report.filter"))).toHaveFocus();
    await user.keyboard("inventory");
    expect(within(table).queryByText(CODE)).not.toBeInTheDocument();
  });

  it("renders the problem's remedy when the list is refused", async () => {
    mountWith(
      fetchMock(() => problem(403, "ERR_RBAC_FORBIDDEN")),
      "ar",
      (options) => (
        <ReportsRoute
          api={options}
          companyId={COMPANY}
          navigation={{ run: vi.fn(), design: vi.fn() }}
        />
      ),
    );
    const alert = await screen.findByRole("alert", {}, LOAD);
    expect(alert).toHaveTextContent(sayIn("ar")("problem.ERR_RBAC_FORBIDDEN.title"));
  });
});

function mountRun(
  api: ReturnType<typeof reportApi>,
  locale: Locale = "en",
  definitionId: string | null = null,
) {
  const props = { onBack: vi.fn(), onDesign: vi.fn(), onSelect: vi.fn() };
  const user = mountWith(api, locale, (options) => (
    <ReportRunRoute
      api={options}
      companyId={COMPANY}
      code={CODE}
      definitionId={definitionId}
      {...props}
    />
  ));
  return { user, props, say: sayIn(locale) };
}

describe("7A T15 — the run screen", () => {
  it.each(["en", "ar"] as const)(
    "generates the parameter form from the definition, by kind, in %s",
    async (locale) => {
      const { say } = mountRun(reportApi(), locale);
      const period = await screen.findByLabelText(
        say("report.param.required", { label: say("report.param.name.fiscalPeriodId") }),
        {},
        LOAD,
      );
      expect(period.tagName).toBe("SELECT");
      await within(period).findByRole("option", { name: /2026/ });
      // A required enum starts on its first declared option.
      const matched = screen.getByLabelText(
        say("report.param.required", { label: say("report.param.name.isMatched") }),
      );
      expect(matched).toHaveValue("false");
      expect(
        within(matched).getByRole("option", { name: say("report.param.option.true") }),
      ).toBeInTheDocument();
      // A list the operator may not read becomes a typed id, never a hidden parameter.
      const party = await screen.findByLabelText(say("report.param.name.partyId"));
      expect(party.tagName).toBe("INPUT");
      expect(party).toHaveAttribute("dir", "ltr");
      expect(screen.getByText(say("report.param.idHint"))).toBeVisible();
      expect(screen.getByLabelText(say("report.param.name.currency")).tagName).toBe("INPUT");
      // The three format buttons, each with its shortcut.
      for (const [index, format] of (["pdf", "xlsx", "csv"] as const).entries())
        expect(
          screen.getByRole("button", {
            name: say("report.run.as", {
              format: say(`report.format.${format}`),
              key: String(index + 1),
            }),
          }),
        ).toHaveAttribute("aria-keyshortcuts", `Alt+${index + 1}`);
    },
  );

  it.each(["en", "ar"] as const)(
    "runs as CSV, polls the status URL until done, and downloads the file, in %s",
    async (locale) => {
      const downloads = stubDownloads();
      const api = reportApi();
      const { user, say } = mountRun(api, locale);
      const period = await screen.findByLabelText(
        say("report.param.required", { label: say("report.param.name.fiscalPeriodId") }),
        {},
        LOAD,
      );
      await within(period).findByRole("option", { name: /2026/ });
      await user.selectOptions(period, PERIOD);
      await user.keyboard("{Alt>}3{/Alt}");
      await waitFor(() => expect(calls(api, "POST", /\/runs$/)).toHaveLength(1));
      const body = JSON.parse(String(calls(api, "POST", /\/runs$/)[0]![1]!.body));
      expect(CreateReportRunBody.safeParse(body).success).toBe(true);
      expect(body).toEqual({
        reportDefinitionId: CORE,
        parameters: { fiscalPeriodId: PERIOD, isMatched: "false" },
        format: "csv",
        lang: locale,
      });
      expect(await screen.findByText(say("report.status.queued"))).toBeVisible();
      const download = await screen.findByRole(
        "button",
        { name: say("report.run.downloadAs", { format: say("report.format.csv") }) },
        POLL,
      );
      expect(download).toHaveFocus();
      expect(screen.getByText("b".repeat(64))).toHaveAttribute("dir", "ltr");
      // Polled the run's own resource, never a job path.
      expect(calls(api, "GET", new RegExp(`/report-runs/${RUN}$`)).length).toBeGreaterThanOrEqual(
        2,
      );
      await user.click(download);
      await waitFor(() => expect(downloads.clicks).toEqual([`${CODE}-${RUN}.csv`]));
    },
  );

  it("shows a failed run's error and lets the operator run again", async () => {
    const api = reportApi({ statuses: ["failed"] });
    const { user, say } = mountRun(api);
    await screen.findByLabelText(
      say("report.param.required", { label: say("report.param.name.fiscalPeriodId") }),
      {},
      LOAD,
    );
    await user.keyboard("{Alt>}1{/Alt}");
    expect(
      await screen.findByText("ERR_VALIDATION_FAILED: the period is closed", {}, POLL),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: say("report.run.as", { format: say("report.format.pdf"), key: "1" }),
      }),
    );
    await waitFor(() => expect(calls(api, "POST", /\/runs$/)).toHaveLength(2));
  });

  // UI-20: a refused status URL is the server's settled answer; asking again every second changes nothing.
  it("stops polling the run's status once the status URL is refused", async () => {
    const api = reportApi({ status: () => problem(403, "ERR_RBAC_FORBIDDEN") });
    const { user, say } = mountRun(api);
    await screen.findByLabelText(
      say("report.param.required", { label: say("report.param.name.fiscalPeriodId") }),
      {},
      LOAD,
    );
    await user.keyboard("{Alt>}1{/Alt}");
    const statusCalls = () => calls(api, "GET", new RegExp(`/report-runs/${RUN}$`)).length;
    expect(await screen.findByRole("alert", {}, POLL)).toHaveTextContent(
      say("problem.ERR_RBAC_FORBIDDEN.title"),
    );
    const seen = statusCalls();
    expect(seen).toBeGreaterThanOrEqual(1);
    // Two and a half poll intervals: a poller still running would have asked at least twice more.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(statusCalls()).toBe(seen);
  });

  it("shows the API's parameter errors against their fields", async () => {
    const api = reportApi({
      run: () =>
        problem(400, "ERR_VALIDATION_FAILED", [
          { path: "/parameters/fiscalPeriodId", message: "required parameter is missing" },
        ]),
    });
    const { user, say } = mountRun(api);
    const period = await screen.findByLabelText(
      say("report.param.required", { label: say("report.param.name.fiscalPeriodId") }),
      {},
      LOAD,
    );
    await user.keyboard("{Alt>}2{/Alt}");
    await screen.findByText("required parameter is missing");
    expect(period).toHaveAttribute("aria-invalid", "true");
    expect(period.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      screen
        .getAllByRole("alert")
        .some((alert) => alert.textContent?.includes(say("problem.ERR_VALIDATION_FAILED.title"))),
    ).toBe(true);
  });

  it("loads a saved view's parameters, records it on the run, and saves a new one with Ctrl+S", async () => {
    const api = reportApi();
    const { user, say } = mountRun(api);
    const choose = await screen.findByLabelText(say("report.view.choose"), {}, LOAD);
    await within(choose).findByRole("option", { name: "Month end" });
    await user.selectOptions(choose, VIEW);
    expect(screen.getByLabelText(say("report.param.name.currency"))).toHaveValue("MYR");
    await user.keyboard("{Alt>}3{/Alt}");
    await waitFor(() => expect(calls(api, "POST", /\/runs$/)).toHaveLength(1));
    expect(JSON.parse(String(calls(api, "POST", /\/runs$/)[0]![1]!.body))).toMatchObject({
      savedViewId: VIEW,
      parameters: view.parameters,
    });
    await user.click(screen.getByLabelText(say("report.view.nameEn")));
    await user.keyboard("Mine");
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(calls(api, "POST", /\/saved-views$/)).toHaveLength(1));
    expect(JSON.parse(String(calls(api, "POST", /\/saved-views$/)[0]![1]!.body))).toEqual({
      reportDefinitionId: CORE,
      nameEn: "Mine",
      parameters: view.parameters,
      shared: false,
    });
  });

  it("goes back to the list with Esc", async () => {
    const { user, props, say } = mountRun(reportApi());
    await user.click(await screen.findByLabelText(say("report.param.name.currency"), {}, LOAD));
    await user.keyboard("{Escape}");
    expect(props.onBack).toHaveBeenCalled();
  });
});

/** A party row on the wire; `n` makes the id and the code. */
const partyRow = (n: number) =>
  PartySchema.parse({
    id: `0192bbbb-0001-7000-8000-${String(n).padStart(12, "0")}`,
    kind: "customer",
    code: `C${String(n).padStart(5, "0")}`,
    nameEn: `Customer ${n}`,
    nameAr: null,
    receivableAccountId: null,
    payableAccountId: null,
    currency: null,
    taxRegistration: null,
    email: null,
    phone: null,
    address: {},
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    creditLimit: null,
    paymentTermId: null,
    creditHold: false,
    priceListId: null,
  });

describe("7 review — a reference parameter's choices span every page", () => {
  it("follows next_cursor to the last page, so a party past the first page can be chosen", async () => {
    // Two pages: the API answers at most 1,000 rows a page, so the 1,001st party is on the second.
    const pages: Record<
      string,
      { items: ReturnType<typeof partyRow>[]; next_cursor: string | null }
    > = {
      first: { items: [partyRow(1), partyRow(2)], next_cursor: "page2" },
      page2: { items: [partyRow(1001)], next_cursor: null },
    };
    const api = reportApi({
      parties: (url) =>
        json(pages[url.searchParams.get("cursor") ?? "first"] ?? { items: [], next_cursor: null }),
    });
    const { user, say } = mountRun(api);
    const period = await screen.findByLabelText(
      say("report.param.required", { label: say("report.param.name.fiscalPeriodId") }),
      {},
      LOAD,
    );
    await within(period).findByRole("option", { name: /2026/ });
    await user.selectOptions(period, PERIOD);
    const party = await screen.findByLabelText(say("report.param.name.partyId"), {}, LOAD);
    expect(party.tagName).toBe("SELECT");
    await within(party).findByRole("option", { name: "C01001 — Customer 1001" }, LOAD);
    expect(within(party).getAllByRole("option")).toHaveLength(4); // "Any" plus all three parties
    const partyCalls = calls(api, "GET", /\/parties$/).map(([input]) => new URL(String(input)));
    expect(partyCalls.map((u) => u.searchParams.get("cursor"))).toEqual([null, "page2"]);
    expect(partyCalls.every((u) => u.searchParams.get("limit") === "1000")).toBe(true);
    await user.selectOptions(party, partyRow(1001).id);
    await user.keyboard("{Alt>}3{/Alt}");
    await waitFor(() => expect(calls(api, "POST", /\/runs$/)).toHaveLength(1));
    expect(JSON.parse(String(calls(api, "POST", /\/runs$/)[0]![1]!.body)).parameters).toEqual({
      fiscalPeriodId: PERIOD,
      isMatched: "false",
      partyId: partyRow(1001).id,
    });
  });

  it.each(["en", "ar"] as const)(
    "stops at the page cap and also accepts a typed id for a record past it, in %s",
    async (locale) => {
      let served = 0;
      const api = reportApi({
        parties: () => {
          served += 1;
          return json({ items: [partyRow(served)], next_cursor: `page${served + 1}` });
        },
      });
      const { user, say } = mountRun(api, locale);
      const party = await screen.findByLabelText(say("report.param.name.partyId"), {}, LOAD);
      await within(party).findByRole("option", { name: /C00001/ }, LOAD);
      expect(calls(api, "GET", /\/parties$/)).toHaveLength(LOOKUP_MAX_PAGES);
      expect(
        screen.getByText(say("report.param.listTruncated", { count: String(LOOKUP_MAX_PAGES) })),
      ).toBeVisible();
      const typed = screen.getByLabelText(
        say("report.param.typedId", { label: say("report.param.name.partyId") }),
      );
      expect(typed.tagName).toBe("INPUT");
      expect(typed).toHaveAttribute("dir", "ltr");
      const beyond = partyRow(99_999).id;
      await user.click(typed);
      await user.paste(beyond);
      // The dropdown shows the typed id as its choice, rather than claiming nothing is chosen.
      expect(party).toHaveValue(beyond);
      const period = screen.getByLabelText(
        say("report.param.required", { label: say("report.param.name.fiscalPeriodId") }),
      );
      await user.selectOptions(period, PERIOD);
      await user.keyboard("{Alt>}3{/Alt}");
      await waitFor(() => expect(calls(api, "POST", /\/runs$/)).toHaveLength(1));
      expect(
        JSON.parse(String(calls(api, "POST", /\/runs$/)[0]![1]!.body)).parameters.partyId,
      ).toBe(beyond);
    },
  );
});
