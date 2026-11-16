import type { Locale } from "@dulja/i18n";
import { PHYSICAL_PROPERTY_PATTERNS } from "@dulja/ui";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monthOf } from "../src/routes/hr/payroll-runs";
import { PayrollRunRoute } from "../src/routes/hr/payroll-run";
import { PayrollRunsRoute } from "../src/routes/hr/payroll-runs";
import {
  calls,
  COMPANY,
  fetchMock,
  json,
  mountWith,
  problem,
  sayIn,
  type Handler,
} from "./support/reports";

// 8B Task 15 — the payroll screens on the OD-24 default baseline. Figures are SYNTH's (hazard 1).
const BRANCH = "0192bbbb-0001-7000-8000-000000000001";
const RUN = "0192abab-0b0b-7000-8000-000000000001";
const EMPLOYEE_A = "0192aaaa-0001-7000-8000-000000000001";
const EMPLOYEE_B = "0192aaaa-0002-7000-8000-000000000002";
const SCHEME = "0192c1c1-0001-7000-8000-000000000001";
const BASIC = "0192c0c0-0001-7000-8000-000000000001";
const OFFICER = "0192dddd-0002-7000-8000-000000000002";
const L = (n: number) => `0192e0e0-000${n}-7000-8000-00000000000${n}`;
const LOAD = { timeout: 5000 };
const MYR = (amount: string) => ({ amount, currency: "MYR" });

const context = {
  companies: [
    {
      id: COMPANY,
      code: "C1",
      name: "Company one",
      baseCurrency: "MYR",
      branches: [{ id: BRANCH, code: "HQ", nameEn: "Head office", nameAr: "المقر" }],
    },
  ],
};
const line = (
  n: number,
  employeeId: string,
  employeeNumber: string,
  rest: Partial<Record<string, unknown>>,
) => ({
  documentLineId: L(n),
  employeeId,
  employeeNumber,
  componentId: null,
  componentCode: null,
  schemeId: null,
  schemeCode: null,
  share: null,
  quantity: null,
  amount: MYR("0.0000"),
  rateTableVersion: null,
  overrideReason: null,
  ...rest,
});
const runOf = (status: string) => ({
  documentId: RUN,
  number: status === "posted" ? "7" : null,
  series: "PAY",
  status,
  kind: "regular",
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  payDate: "2026-02-05",
  pinnedTables: [{ schemeId: SCHEME, version: 1 }],
  lines: [
    line(1, EMPLOYEE_A, "E-0001", {
      componentId: BASIC,
      componentCode: "BASIC",
      amount: MYR("2000.0000"),
    }),
    line(2, EMPLOYEE_A, "E-0001", {
      schemeId: SCHEME,
      schemeCode: "EPF",
      share: "employee",
      amount: MYR("77.0000"),
      rateTableVersion: 1,
      overrideReason: "authority letter 2026-01-02",
    }),
    line(3, EMPLOYEE_A, "E-0001", {
      schemeId: SCHEME,
      schemeCode: "EPF",
      share: "employer",
      amount: MYR("100.0000"),
      rateTableVersion: 1,
    }),
    line(4, EMPLOYEE_A, "E-0001", { amount: MYR("1923.0000") }),
    line(5, EMPLOYEE_B, "E-0002", {
      schemeId: SCHEME,
      schemeCode: "EPF",
      share: "employee",
      amount: MYR("50.0000"),
      rateTableVersion: 1,
    }),
  ],
  overrides: [
    {
      documentLineId: L(2),
      employeeId: EMPLOYEE_A,
      employeeNumber: "E-0001",
      schemeId: SCHEME,
      schemeCode: "EPF",
      share: "employee",
      amount: MYR("77.0000"),
      reason: "authority letter 2026-01-02",
      enteredBy: OFFICER,
      enteredByName: "Payroll officer",
      enteredAt: "2026-01-28T09:00:00.000Z",
    },
  ],
  compensationChangedBy: [
    {
      principalId: OFFICER,
      displayName: "Nadia (HR)",
      employeeNumber: "E-0001",
      effectiveFrom: "2026-01-15",
    },
  ],
});
const listItem = (status: string) => {
  const { lines: _l, overrides: _o, compensationChangedBy: _c, ...head } = runOf(status);
  return head;
};
const employee = (id: string, employeeNumber: string) => ({
  id,
  partyId: id,
  employeeNumber,
  homeBranchId: BRANCH,
  principalId: null,
  hiredOn: "2020-01-01",
  terminatedOn: null,
  createdAt: "2020-01-01T00:00:00Z",
  position: null,
  employmentType: null,
  archivedAt: null,
});

function payrollMock(options: { status?: string; approve?: () => Response } = {}) {
  let status = options.status ?? "submitted";
  const handler: Handler = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path === "/v1/staff-context") return json(context);
    if (path.endsWith("/employees"))
      return json({
        items: [employee(EMPLOYEE_A, "E-0001"), employee(EMPLOYEE_B, "E-0002")],
        next_cursor: null,
      });
    if (path.endsWith(`/documents/${RUN}/transitions`)) {
      const body = JSON.parse(String(init!.body)) as { to: string };
      if (body.to === "approved" && options.approve) return options.approve();
      const from = status;
      status = body.to;
      return json({
        documentId: RUN,
        from,
        to: body.to,
        eventId: L(9),
        status: body.to,
        number: null,
        series: "PAY",
        fiscalPeriodId: null,
        ledgerEntryIds: [],
      });
    }
    if (path.endsWith(`/payroll-runs/${RUN}/recalculate`)) {
      status = "draft";
      return json(runOf(status));
    }
    if (path.endsWith(`/payroll-runs/${RUN}/overrides`)) return json(runOf(status));
    if (path.endsWith(`/payroll-runs/${RUN}`)) return json(runOf(status));
    if (path.endsWith("/payroll-runs") && method === "POST") return json(runOf("draft"), 201);
    if (path.endsWith("/payroll-runs"))
      return json({ items: [listItem("submitted"), { ...listItem("posted") }], next_cursor: null });
    return problem(404, "ERR_NOT_FOUND");
  };
  return fetchMock(handler);
}

const physicalClassesAbsent = () => {
  const classes = [...document.body.querySelectorAll("[class]")]
    .map((e) => e.getAttribute("class"))
    .join(" ");
  for (const pattern of PHYSICAL_PROPERTY_PATTERNS)
    expect(classes).not.toMatch(new RegExp(pattern));
};
const bodyOf = (api: ReturnType<typeof payrollMock>, method: string, path: RegExp) =>
  JSON.parse(String(calls(api, method, path).at(-1)![1]!.body)) as Record<string, unknown>;
const mountRun = (api: ReturnType<typeof payrollMock>, locale: Locale = "en") => {
  const user = mountWith(api, locale, (options) => (
    <PayrollRunRoute api={options} companyId={COMPANY} documentId={RUN} />
  ));
  return { user, say: sayIn(locale) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("8B T15 — helpers", () => {
  it("defaults a new run to the calendar month, in UTC", () => {
    expect(monthOf(new Date("2026-02-10T12:00:00Z"))).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
    expect(monthOf(new Date("2028-02-29T23:00:00Z"))).toEqual({
      start: "2028-02-01",
      end: "2028-02-29",
    });
  });
});

describe("8B T15 — the payroll run register", () => {
  it.each(["en", "ar"] as const)(
    "lists runs with their period, kind and status, and filters by literal filter[…] keys, in %s",
    async (locale) => {
      const api = payrollMock();
      const user = mountWith(api, locale, (options) => <PayrollRunsRoute api={options} />);
      const say = sayIn(locale);
      const grid = await screen.findByRole("table", { name: say("payroll.list") }, LOAD);
      expect(await within(grid).findByText(say("payroll.status.submitted"))).toBeVisible();
      expect(within(grid).getByText(say("payroll.status.posted"))).toBeVisible();
      expect(within(grid).getByText("PAY-7")).toBeVisible();
      await user.selectOptions(screen.getByLabelText(say("payroll.filterStatus")), "posted");
      await waitFor(() =>
        expect(
          calls(api, "GET", /\/payroll-runs$/).some(([input]) =>
            String(input).includes("filter%5Bstatus%5D%5Beq%5D=posted"),
          ),
        ).toBe(true),
      );
      await waitFor(() =>
        expect(document.documentElement).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr"),
      );
      physicalClassesAbsent();
    },
  );

  it("a supplementary run names its employees; none chosen is refused before anything is sent", async () => {
    const api = payrollMock();
    const user = mountWith(api, "en", (options) => <PayrollRunsRoute api={options} />);
    const say = sayIn("en");
    await user.click(await screen.findByRole("button", { name: say("payroll.new") }, LOAD));
    const form = await screen.findByRole("form", { name: say("payroll.new") });
    // The form's first control has focus: keyboard entry starts at once.
    expect(within(form).getByLabelText(say("payroll.kind"))).toHaveFocus();
    await user.selectOptions(within(form).getByLabelText(say("payroll.kind")), "supplementary");
    await within(form).findByLabelText("E-0001");
    await user.clear(within(form).getByLabelText(say("payroll.periodStart")));
    await user.type(within(form).getByLabelText(say("payroll.periodStart")), "2026-01-01");
    await user.clear(within(form).getByLabelText(say("payroll.periodEnd")));
    await user.type(within(form).getByLabelText(say("payroll.periodEnd")), "2026-01-31");
    await user.clear(within(form).getByLabelText(say("payroll.payDate")));
    await user.type(within(form).getByLabelText(say("payroll.payDate")), "2026-02-05");
    await user.clear(within(form).getByLabelText(say("payroll.effectiveDate")));
    await user.type(within(form).getByLabelText(say("payroll.effectiveDate")), "2026-01-31");
    await user.click(within(form).getByRole("button", { name: say("payroll.calculate") }));
    expect(await within(form).findByText(say("payroll.employeesNone"))).toBeVisible();
    expect(calls(api, "POST", /\/payroll-runs$/)).toHaveLength(0);

    await user.click(within(form).getByLabelText("E-0001"));
    await user.click(within(form).getByRole("button", { name: say("payroll.calculate") }));
    await waitFor(() => expect(calls(api, "POST", /\/payroll-runs$/)).toHaveLength(1));
    expect(bodyOf(api, "POST", /\/payroll-runs$/)).toEqual({
      kind: "supplementary",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      payDate: "2026-02-05",
      effectiveDate: "2026-01-31",
      branchId: BRANCH,
      employeeIds: [EMPLOYEE_A],
    });
    const init = calls(api, "POST", /\/payroll-runs$/)[0]![1]!;
    expect(new Headers(init.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a regular run sends no employeeIds — it takes everyone employed in the period", async () => {
    const api = payrollMock();
    const user = mountWith(api, "en", (options) => <PayrollRunsRoute api={options} />);
    const say = sayIn("en");
    await user.click(await screen.findByRole("button", { name: say("payroll.new") }, LOAD));
    const form = await screen.findByRole("form", { name: say("payroll.new") });
    await user.click(within(form).getByRole("button", { name: say("payroll.calculate") }));
    await waitFor(() => expect(calls(api, "POST", /\/payroll-runs$/)).toHaveLength(1));
    const body = bodyOf(api, "POST", /\/payroll-runs$/);
    expect(body["kind"]).toBe("regular");
    expect(body).not.toHaveProperty("employeeIds");
    expect(calls(api, "GET", /\/employees$/)).toHaveLength(0);
  });
});

describe("8B T15 — the payroll approval screen", () => {
  it.each(["en", "ar"] as const)(
    "FLAGS every manual override with its reason and who entered it (spec:2087), in %s",
    async (locale) => {
      const api = payrollMock();
      const { say } = mountRun(api, locale);
      const flagged = await screen.findByTestId(`override-${L(2)}`, {}, LOAD);
      expect(flagged).toHaveTextContent("authority letter 2026-01-02");
      expect(flagged).toHaveTextContent("Payroll officer");
      expect(flagged).toHaveTextContent("E-0001");
      // The line itself carries the flag too, and the untouched share does not.
      const lines = screen.getByRole("table", { name: say("payroll.lines") });
      expect(within(lines).getAllByText(say("payroll.overridden"))).toHaveLength(1);
      expect(screen.getByTestId("payroll-approval")).toBeVisible();
      await waitFor(() =>
        expect(document.documentElement).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr"),
      );
      physicalClassesAbsent();
    },
  );

  it.each(["en", "ar"] as const)(
    "LISTS everyone who changed compensation in the period (spec:2174 R3) and the pinned versions, in %s",
    async (locale) => {
      const api = payrollMock();
      const { say } = mountRun(api, locale);
      const list = await screen.findByTestId("compensation-changed-by", {}, LOAD);
      await within(list).findByText(/Nadia \(HR\)/);
      expect(list).toHaveTextContent("E-0001");
      expect(
        screen.getByText(say("payroll.pinnedVersion", { scheme: "EPF", version: "1" })),
      ).toBeVisible();
      expect(screen.getByTestId("payroll-status")).toHaveTextContent(
        say("payroll.status.submitted"),
      );
    },
  );

  it("every action is reachable from the keyboard alone: Tab to Approve, Enter (spec:2254)", async () => {
    const api = payrollMock();
    const { user, say } = mountRun(api);
    const approve = await screen.findByRole("button", { name: say("payroll.approve") }, LOAD);
    for (let i = 0; i < 40 && document.activeElement !== approve; i += 1) await user.tab();
    expect(approve).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls(api, "POST", /\/transitions$/)).toHaveLength(1));
    expect(bodyOf(api, "POST", /\/transitions$/)).toEqual({ to: "approved" });
    expect(await screen.findByRole("button", { name: say("payroll.post") })).toBeVisible();
  });

  it("R1 is the database's answer, shown as the server words it: a maker's approval is refused", async () => {
    const api = payrollMock({ approve: () => problem(409, "ERR_SOD_MAKER_IS_CHECKER") });
    const { user, say } = mountRun(api);
    await user.click(await screen.findByRole("button", { name: say("payroll.approve") }, LOAD));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("server detail for ERR_SOD_MAKER_IS_CHECKER");
    expect(screen.getByTestId("payroll-status")).toHaveTextContent(say("payroll.status.submitted"));
  });

  it("returning a run to draft asks for the reason 2B's backward edge requires", async () => {
    const api = payrollMock({ status: "approved" });
    const { user, say } = mountRun(api);
    await user.click(
      await screen.findByRole("button", { name: say("payroll.returnToDraft") }, LOAD),
    );
    const form = await screen.findByRole("form", { name: say("payroll.returnToDraft") });
    const reason = within(form).getByLabelText(say("payroll.returnReason"));
    expect(reason).toHaveFocus();
    await user.type(reason, "wrong pay date");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls(api, "POST", /\/transitions$/)).toHaveLength(1));
    expect(bodyOf(api, "POST", /\/transitions$/)).toEqual({
      to: "draft",
      reason: "wrong pay date",
    });
  });

  it("a DRAFT run takes an override for ONE employee's share, with a reason; a bad figure is refused locally", async () => {
    const api = payrollMock({ status: "draft" });
    const { user, say } = mountRun(api);
    await user.click(
      await screen.findByRole("button", { name: say("payroll.override.new") }, LOAD),
    );
    const form = await screen.findByRole("form", { name: say("payroll.override.new") });
    expect(within(form).getByLabelText(say("payroll.override.employee"))).toHaveFocus();
    await user.selectOptions(
      within(form).getByLabelText(say("payroll.override.employee")),
      EMPLOYEE_B,
    );
    await user.type(
      within(form).getByLabelText(say("payroll.override.amountIn", { currency: "MYR" })),
      "-3",
    );
    await user.type(within(form).getByLabelText(say("payroll.override.reason")), "letter");
    await user.click(within(form).getByRole("button", { name: say("payroll.override.save") }));
    expect(await within(form).findByText(say("payroll.override.invalid"))).toBeVisible();
    expect(calls(api, "POST", /\/overrides$/)).toHaveLength(0);

    const amount = within(form).getByLabelText(
      say("payroll.override.amountIn", { currency: "MYR" }),
    );
    await user.clear(amount);
    await user.type(amount, "60.5");
    await user.click(within(form).getByRole("button", { name: say("payroll.override.save") }));
    await waitFor(() => expect(calls(api, "POST", /\/overrides$/)).toHaveLength(1));
    expect(bodyOf(api, "POST", /\/overrides$/)).toEqual({
      employeeId: EMPLOYEE_B,
      schemeId: SCHEME,
      share: "employee",
      amount: { amount: "60.5000", currency: "MYR" },
      reason: "letter",
    });
  });

  it("a POSTED run offers no action and says a correction is a supplementary run", async () => {
    const api = payrollMock({ status: "posted" });
    const { say } = mountRun(api);
    expect(await screen.findByText(say("payroll.postedHint"), {}, LOAD)).toBeVisible();
    const actions = screen.getByRole("region", { name: say("payroll.actions") });
    expect(within(actions).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: say("payroll.override.new") })).toBeNull();
  });

  it("a submitted run is recalculated from the keyboard and comes back as a draft", async () => {
    const api = payrollMock();
    const { user, say } = mountRun(api);
    const recalc = await screen.findByRole("button", { name: say("payroll.recalculate") }, LOAD);
    recalc.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls(api, "POST", /\/recalculate$/)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId("payroll-status")).toHaveTextContent(say("payroll.status.draft")),
    );
  });
});
