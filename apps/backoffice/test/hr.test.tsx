import type { Locale } from "@dulja/i18n";
import { PHYSICAL_PROPERTY_PATTERNS } from "@dulja/ui";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { firstOfNextMonth, quantityToWire } from "../src/features/hr/shared";
import { EmployeeRecordRoute } from "../src/routes/hr/employee-record";
import { HrSettingsRoute } from "../src/routes/hr/hr-settings";
import { PayComponentsRoute } from "../src/routes/hr/pay-components";
import { StatutoryTablesRoute } from "../src/routes/hr/statutory-tables";
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

const BRANCH = "0192bbbb-0001-7000-8000-000000000001";
const EMPLOYEE = "0192aaaa-0001-7000-8000-000000000001";
const ME = "0192dddd-0001-7000-8000-000000000001";
const OTHER = "0192dddd-0002-7000-8000-000000000002";
const BASIC = "0192c0c0-0001-7000-8000-000000000001";
const RETIRED = "0192c0c0-0002-7000-8000-000000000002";
const SCHEME = "0192c1c1-0001-7000-8000-000000000001";
const LOAD = { timeout: 5000 };

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
const employee = {
  id: EMPLOYEE,
  partyId: EMPLOYEE,
  employeeNumber: "E-1001",
  homeBranchId: BRANCH,
  principalId: null,
  hiredOn: "2026-01-01",
  terminatedOn: null,
  createdAt: "2026-01-01T00:00:00Z",
  position: "Cashier",
  employmentType: "full_time",
  archivedAt: null,
};
const sensitive = {
  employeeId: EMPLOYEE,
  nationalId: "SYNTHETIC-ID-1",
  passport: null,
  dateOfBirth: null,
  residencyCategory: null,
  bankAccount: "SYNTHETIC-ACC-1",
  epfNumber: null,
  socsoNumber: null,
  taxNumber: null,
  workPermitExpiry: null,
  keyVersion: 1,
  updatedBy: OTHER,
  updatedAt: "2026-02-01T00:00:00Z",
};
const component = (id: string, code: string, archivedAt: string | null = null) => ({
  id,
  code,
  nameEn: `${code} name`,
  nameAr: null,
  kind: "earning",
  expenseAccountId: null,
  payableAccountId: null,
  quantityBased: false,
  schemeIds: [],
  archivedAt,
});
const line = (id: string, effectiveFrom: string, effectiveTo: string | null, amount: string) => ({
  id,
  employeeId: EMPLOYEE,
  componentId: BASIC,
  effectiveFrom,
  effectiveTo,
  amount: { amount, currency: "MYR" },
  quantity: null,
  enteredBy: OTHER,
});
const scheme = {
  id: SCHEME,
  code: "SYNTH",
  nameEn: "SYNTH (synthetic)",
  nameAr: null,
  payableAccountId: null,
  employerExpenseAccountId: null,
  authorityPartyId: null,
  employerRegistration: null,
  roundingMode: "HALF_AWAY_FROM_ZERO",
};
const table = (version: number, loadedBy: string, verifiedAt: string | null = null) => ({
  id: `0192c2c2-000${version}-7000-8000-00000000000${version}`,
  schemeId: SCHEME,
  schemeCode: "SYNTH",
  version,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  definition: { scheme: "SYNTH", version, source: { authority: "Dulja test fixture" } },
  source: "Dulja test fixture / synthetic",
  loadedBy,
  verifiedBy: verifiedAt === null ? null : OTHER,
  verifiedAt,
});
const list = (items: unknown[]) => json({ items, next_cursor: null });
/** A promise the test settles by hand. */
function held(): { promise: Promise<void>; release: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, release: () => settle?.() };
}

interface Options {
  sensitive?: () => Response;
  tables?: unknown[];
  /** The employee's statutory profiles (GET); none by default. */
  profiles?: unknown[];
  /** Answers the pay-component list (GET) instead of the default two components. */
  components?: () => Response | Promise<Response>;
}
function hrApi(options: Options = {}) {
  const handler: Handler = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path === "/v1/staff-context") return json(context);
    if (path === "/v1/session")
      return json({
        principalId: ME,
        tenantId: COMPANY,
        principalKind: "human",
        aal: "aal2",
        displayName: "Me",
        email: null,
      });
    if (path.endsWith(`/employees/${EMPLOYEE}/sensitive`))
      return method === "PUT"
        ? json({ ...sensitive, ...JSON.parse(String(init!.body)) })
        : (options.sensitive?.() ?? json(sensitive));
    if (path.endsWith(`/employees/${EMPLOYEE}/statutory-profiles`))
      return method === "POST"
        ? json(
            {
              ...JSON.parse(String(init!.body)),
              id: "0192c4c4-0009-7000-8000-000000000009",
              employeeId: EMPLOYEE,
              effectiveTo: null,
              enteredBy: ME,
              createdAt: "2026-11-07T00:00:00Z",
            },
            201,
          )
        : list(options.profiles ?? []);
    if (path.endsWith(`/employees/${EMPLOYEE}/compensation-lines`))
      return method === "POST"
        ? json(line("0192c3c3-0009-7000-8000-000000000009", "2026-03-01", null, "2500.0000"), 201)
        : list([
            line("0192c3c3-0001-7000-8000-000000000001", "2026-01-01", "2026-01-31", "1000.0000"),
            line("0192c3c3-0002-7000-8000-000000000002", "2026-02-01", null, "1200.0000"),
          ]);
    if (path.endsWith(`/employees/${EMPLOYEE}`)) return json(employee);
    if (path.endsWith("/pay-components") && method === "POST")
      return json({ ...component(BASIC, "NEW"), ...JSON.parse(String(init!.body)) }, 201);
    if (path.endsWith("/pay-components"))
      return options.components
        ? options.components()
        : list([component(BASIC, "BASIC"), component(RETIRED, "OLD", "2026-01-15T00:00:00Z")]);
    if (path.endsWith("/statutory-schemes")) return list([scheme]);
    if (path.endsWith("/rate-tables") && method === "GET")
      return list(options.tables ?? [table(2, ME), table(1, OTHER)]);
    if (/\/rate-tables\/\d+\/verify$/.test(path))
      return json(table(1, OTHER, "2026-11-07T00:00:00Z"));
    if (path.endsWith("/hr-settings"))
      return method === "PUT"
        ? json({
            companyId: COMPANY,
            ...JSON.parse(String(init!.body)),
            employerRegistrations: [{ schemeId: SCHEME, schemeCode: "SYNTH", registration: "R-1" }],
          })
        : json({
            companyId: COMPANY,
            prorationRule: "calendar_days",
            payDay: null,
            employerRegistrations: [{ schemeId: SCHEME, schemeCode: "SYNTH", registration: null }],
          });
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
const bodyOf = (api: ReturnType<typeof hrApi>, method: string, path: RegExp) =>
  JSON.parse(String(calls(api, method, path)[0]![1]!.body)) as Record<string, unknown>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("8A T13 — helpers", () => {
  it("defaults a new effective date to the first of next month, across a year end, in UTC", () => {
    expect(firstOfNextMonth(new Date("2026-11-07T12:00:00Z"))).toBe("2026-12-01");
    expect(firstOfNextMonth(new Date("2026-12-31T23:59:00Z"))).toBe("2027-01-01");
    expect(firstOfNextMonth(new Date("2026-01-31T00:00:00Z"))).toBe("2026-02-01");
  });
  it("writes a quantity at the wire's six places, never through a float", () => {
    expect(quantityToWire("3")).toBe("3.000000");
    expect(quantityToWire("1.5")).toBe("1.500000");
    expect(() => quantityToWire("-1")).toThrow();
    expect(() => quantityToWire("1.1234567")).toThrow();
  });
});

describe("8A T13 — the employee HR record", () => {
  const mount = (api: ReturnType<typeof hrApi>, locale: Locale = "en") => {
    const user = mountWith(api, locale, (options) => (
      <EmployeeRecordRoute api={options} companyId={COMPANY} employeeId={EMPLOYEE} />
    ));
    return { user, say: sayIn(locale) };
  };

  it.each(["en", "ar"] as const)(
    "a principal without the sensitive code is TOLD so — never shown blank fields — and still sees the rest, in %s",
    async (locale) => {
      const api = hrApi({ sensitive: () => problem(403, "ERR_RBAC_FORBIDDEN") });
      const { say } = mount(api, locale);
      expect(await screen.findByText(say("hr.sensitive.denied"), {}, LOAD)).toBeVisible();
      const panel = screen.getByRole("region", { name: say("hr.sensitive.title") });
      expect(within(panel).queryAllByRole("textbox")).toHaveLength(0);
      expect(within(panel).queryByLabelText(say("hr.sensitive.field.nationalId"))).toBeNull();
      // The other two panels have their own fetches and are unaffected.
      expect(
        await screen.findByRole("table", { name: say("hr.compensation.title") }, LOAD),
      ).toBeVisible();
      expect(screen.getByRole("table", { name: say("hr.profile.title") })).toBeVisible();
      expect(screen.getByText("E-1001", { selector: "bdi" })).toBeVisible();
      await waitFor(() =>
        expect(document.documentElement).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr"),
      );
      physicalClassesAbsent();
    },
  );

  it("saves only the identity fields that changed, a cleared one as an explicit null", async () => {
    const api = hrApi();
    const { user, say } = mount(api);
    const national = await screen.findByLabelText(say("hr.sensitive.field.nationalId"), {}, LOAD);
    await waitFor(() => expect(national).toHaveValue("SYNTHETIC-ID-1"));
    await user.clear(screen.getByLabelText(say("hr.sensitive.field.bankAccount")));
    await user.type(screen.getByLabelText(say("hr.sensitive.field.passport")), "SYNTHETIC-PP-9");
    await user.click(screen.getByRole("button", { name: say("hr.sensitive.save") }));
    await waitFor(() => expect(calls(api, "PUT", /\/sensitive$/)).toHaveLength(1));
    expect(bodyOf(api, "PUT", /\/sensitive$/)).toEqual({
      passport: "SYNTHETIC-PP-9",
      bankAccount: null,
    });
    const init = calls(api, "PUT", /\/sensitive$/)[0]![1]!;
    expect(new Headers(init.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(say("hr.saved"))).toBeVisible();
  });

  it("an employee with nothing recorded gets an empty form that says so (404 is not a refusal)", async () => {
    const api = hrApi({ sensitive: () => problem(404, "ERR_NOT_FOUND") });
    const { say } = mount(api);
    expect(await screen.findByText(say("hr.sensitive.none"), {}, LOAD)).toBeVisible();
    expect(screen.getByLabelText(say("hr.sensitive.field.nationalId"))).toHaveValue("");
  });

  it("compensation shows closed lines greyed with their end date, and a new line CLOSES rather than edits", async () => {
    const api = hrApi();
    const { user, say } = mount(api);
    const grid = await screen.findByRole("table", { name: say("hr.compensation.title") }, LOAD);
    await within(grid).findByText(say("hr.closed"));
    expect(within(grid).getByText(say("hr.closed"))).toHaveClass("text-text-muted");
    expect(within(grid).getByText(say("hr.current"))).not.toHaveClass("text-text-muted");
    await user.click(screen.getByRole("button", { name: say("hr.compensation.new") }));
    const form = await screen.findByRole("form", { name: say("hr.compensation.new") });
    expect(within(form).getByText(say("hr.compensation.closesHint"))).toBeVisible();
    expect(within(form).getByLabelText(say("hr.effectiveFrom"))).toHaveValue(firstOfNextMonth());
    // Only LIVE components are offered: the archived one is not.
    const options = within(form)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["BASIC — BASIC name"]);
    await user.clear(within(form).getByLabelText(say("hr.effectiveFrom")));
    await user.type(within(form).getByLabelText(say("hr.effectiveFrom")), "2026-03-01");
    await user.type(
      within(form).getByLabelText(say("hr.compensation.amountIn", { currency: "MYR" })),
      "2500",
    );
    await user.click(within(form).getByRole("button", { name: say("hr.compensation.save") }));
    await waitFor(() => expect(calls(api, "POST", /\/compensation-lines$/)).toHaveLength(1));
    expect(bodyOf(api, "POST", /\/compensation-lines$/)).toEqual({
      componentId: BASIC,
      effectiveFrom: "2026-03-01",
      amount: { amount: "2500.0000", currency: "MYR" },
    });
  });

  // UI-18: the form opened before the components arrived must still send the component its select shows.
  it("sends the shown component when New was pressed before the components loaded", async () => {
    const { promise: arrived, release } = held();
    const api = hrApi({
      components: async () => {
        await arrived;
        return list([component(BASIC, "BASIC")]);
      },
    });
    const { user, say } = mount(api);
    await user.click(await screen.findByRole("button", { name: say("hr.compensation.new") }, LOAD));
    release();
    const form = await screen.findByRole("form", { name: say("hr.compensation.new") });
    const select = within(form).getByLabelText(say("hr.compensation.component"));
    expect(select).toHaveValue(BASIC);
    await user.type(
      within(form).getByLabelText(say("hr.compensation.amountIn", { currency: "MYR" })),
      "2500",
    );
    await user.click(within(form).getByRole("button", { name: say("hr.compensation.save") }));
    await waitFor(() => expect(calls(api, "POST", /\/compensation-lines$/)).toHaveLength(1));
    expect(bodyOf(api, "POST", /\/compensation-lines$/)).toMatchObject({ componentId: BASIC });
  });

  it("shows a failed component lookup as the failure, not as 'no components'", async () => {
    const api = hrApi({ components: () => problem(404, "ERR_NOT_FOUND") });
    const { user, say } = mount(api);
    await user.click(await screen.findByRole("button", { name: say("hr.compensation.new") }, LOAD));
    await waitFor(() => expect(calls(api, "GET", /\/pay-components$/).length).toBeGreaterThan(0));
    const alert = await screen.findByRole("alert", {}, LOAD);
    expect(alert).toHaveTextContent("server detail for ERR_NOT_FOUND");
    expect(screen.queryByText(say("hr.compensation.noComponents"))).not.toBeInTheDocument();
  });

  // PRD-23: recording a third child must not clear marital status, spouse status or the OD-28 references.
  it.each(["en", "ar"] as const)(
    "a new statutory profile starts from the current one and keeps what was not changed, in %s",
    async (locale) => {
      const profile = (id: string, from: string, to: string | null, children: number) => ({
        id,
        employeeId: EMPLOYEE,
        effectiveFrom: from,
        effectiveTo: to,
        maritalStatus: "married",
        spouseWorking: false,
        childReliefCount: children,
        residencyCategory: "resident",
        extra: { "scheme_reference:SYNTH": "S-123" },
        enteredBy: OTHER,
        createdAt: "2026-01-01T00:00:00Z",
      });
      const api = hrApi({
        profiles: [
          profile("0192c4c4-0001-7000-8000-000000000001", "2025-01-01", "2025-12-31", 1),
          profile("0192c4c4-0002-7000-8000-000000000002", "2026-01-01", null, 2),
        ],
      });
      const { user, say } = mount(api, locale);
      await screen.findByRole("table", { name: say("hr.profile.title") }, LOAD);
      await user.click(await screen.findByRole("button", { name: say("hr.profile.new") }, LOAD));
      const form = await screen.findByRole("form", { name: say("hr.profile.new") });
      expect(within(form).getByLabelText(say("hr.profile.maritalStatus"))).toHaveValue("married");
      expect(within(form).getByLabelText(say("hr.profile.spouseWorking"))).toHaveValue("no");
      const children = within(form).getByLabelText(say("hr.profile.childReliefCount"));
      expect(children).toHaveValue("2");
      expect(within(form).getByLabelText(say("hr.profile.residencyCategory"))).toHaveValue(
        "resident",
      );
      await user.clear(children);
      await user.type(children, "3{Enter}");
      await waitFor(() => expect(calls(api, "POST", /\/statutory-profiles$/)).toHaveLength(1));
      expect(bodyOf(api, "POST", /\/statutory-profiles$/)).toEqual({
        effectiveFrom: firstOfNextMonth(),
        maritalStatus: "married",
        spouseWorking: false,
        childReliefCount: 3,
        residencyCategory: "resident",
        extra: { "scheme_reference:SYNTH": "S-123" },
      });
    },
  );

  it("refuses a malformed amount on the client, sending nothing", async () => {
    const api = hrApi();
    const { user, say } = mount(api);
    await user.click(await screen.findByRole("button", { name: say("hr.compensation.new") }, LOAD));
    const form = await screen.findByRole("form", { name: say("hr.compensation.new") });
    await user.type(
      within(form).getByLabelText(say("hr.compensation.amountIn", { currency: "MYR" })),
      "12.34567",
    );
    await user.click(within(form).getByRole("button", { name: say("hr.compensation.save") }));
    expect(await within(form).findByText(say("hr.compensation.invalid"))).toBeVisible();
    expect(calls(api, "POST", /\/compensation-lines$/)).toHaveLength(0);
  });
});

describe("8A T13 — the pay-component catalogue", () => {
  it.each(["en", "ar"] as const)(
    "offers kind as a radio of exactly two values and posts the strict body, in %s",
    async (locale) => {
      const api = hrApi();
      const user = mountWith(api, locale, (options) => <PayComponentsRoute api={options} />);
      const say = sayIn(locale);
      const grid = await screen.findByRole("table", { name: say("hr.payComponent.title") }, LOAD);
      expect(await within(grid).findByText(say("hr.archived"))).toBeVisible();
      await user.click(screen.getByRole("button", { name: say("hr.payComponent.new") }));
      const form = await screen.findByRole("form", { name: say("hr.payComponent.new") });
      const radios = within(form).getAllByRole("radio");
      expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(["earning", "deduction"]);
      expect(within(form).queryAllByRole("combobox")).toHaveLength(0);
      await user.type(within(form).getByLabelText(say("hr.payComponent.code")), "ALLOW2");
      await user.type(within(form).getByLabelText(say("staff.nameEn")), "Second allowance");
      await user.click(within(form).getByLabelText(say("hr.kind.deduction")));
      await user.click(within(form).getByRole("button", { name: say("staff.save") }));
      await waitFor(() => expect(calls(api, "POST", /\/pay-components$/)).toHaveLength(1));
      expect(bodyOf(api, "POST", /\/pay-components$/)).toEqual({
        code: "ALLOW2",
        nameEn: "Second allowance",
        kind: "deduction",
        quantityBased: false,
      });
      physicalClassesAbsent();
    },
  );
});

describe("8A T13 — statutory tables", () => {
  it.each(["en", "ar"] as const)(
    "the loader's verify button is DISABLED with the rule named; another's table verifies, in %s",
    async (locale) => {
      const api = hrApi();
      const user = mountWith(api, locale, (options) => <StatutoryTablesRoute api={options} />);
      const say = sayIn(locale);
      const schemes = await screen.findByRole("table", { name: say("hr.scheme.list") }, LOAD);
      expect(await within(schemes).findByText(say("hr.scheme.unregistered"))).toBeVisible();
      within(schemes).getAllByRole("cell")[0]!.focus();
      await user.keyboard("{Enter}");
      const tables = await screen.findByRole("table", { name: say("hr.rateTable.title") });
      await within(tables).findAllByText(say("hr.rateTable.unverified"));
      // Version 2 is the caller's own load.
      within(tables).getAllByRole("cell")[0]!.focus();
      await user.keyboard("{Enter}");
      const own = await screen.findByRole("button", { name: say("hr.rateTable.verify") });
      await waitFor(() => expect(own).toBeDisabled());
      expect(screen.getByText(say("hr.rateTable.ownLoad"))).toBeVisible();
      expect(own).toHaveAccessibleDescription(say("hr.rateTable.ownLoad"));
      expect(screen.getByTestId("rate-table-definition")).toHaveAttribute("dir", "ltr");
      // Version 1 was loaded by someone else.
      within(tables).getAllByRole("row")[2]!.querySelector("td")!.focus();
      await user.keyboard("{Enter}");
      const theirs = await screen.findByRole("button", { name: say("hr.rateTable.verify") });
      await waitFor(() => expect(theirs).toBeEnabled());
      await user.click(theirs);
      await waitFor(() => expect(calls(api, "POST", /\/rate-tables\/1\/verify$/)).toHaveLength(1));
      physicalClassesAbsent();
    },
  );

  it("a malformed definition is refused on the client and nothing is posted", async () => {
    const api = hrApi({ tables: [] });
    const user = mountWith(api, "en", (options) => <StatutoryTablesRoute api={options} />);
    const say = sayIn("en");
    const schemes = await screen.findByRole("table", { name: say("hr.scheme.list") }, LOAD);
    await within(schemes).findByText("SYNTH");
    within(schemes).getAllByRole("cell")[0]!.focus();
    await user.keyboard("{Enter}");
    const area = await screen.findByLabelText(say("hr.rateTable.definitionField"));
    await user.click(area);
    await user.paste("{not json");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText(say("hr.rateTable.malformed"))).toBeVisible();
    expect(calls(api, "POST", /\/rate-tables$/)).toHaveLength(0);
  });
});

describe("8A T13 — HR settings (⚠️ OD-23)", () => {
  it.each(["en", "ar"] as const)(
    "reads the default, then saves the rule, the pay day and a registration (blank = null), in %s",
    async (locale) => {
      const api = hrApi();
      const user = mountWith(api, locale, (options) => <HrSettingsRoute api={options} />);
      const say = sayIn(locale);
      const rule = await screen.findByLabelText(say("hr.settings.prorationRule"), {}, LOAD);
      expect(rule).toHaveValue("calendar_days");
      expect(within(rule).getAllByRole("option")).toHaveLength(2);
      await user.selectOptions(rule, "working_days");
      await user.type(screen.getByLabelText(say("hr.settings.payDay")), "25");
      await user.click(screen.getByRole("button", { name: say("staff.save") }));
      await waitFor(() => expect(calls(api, "PUT", /\/hr-settings$/)).toHaveLength(1));
      expect(bodyOf(api, "PUT", /\/hr-settings$/)).toEqual({
        prorationRule: "working_days",
        payDay: 25,
        employerRegistrations: [{ schemeId: SCHEME, registration: null }],
      });
      expect(await screen.findByText(say("hr.saved"))).toBeVisible();
      physicalClassesAbsent();
    },
  );

  it("a pay day outside 1..31 is refused before anything is sent", async () => {
    const api = hrApi();
    const user = mountWith(api, "en", (options) => <HrSettingsRoute api={options} />);
    const say = sayIn("en");
    await user.type(await screen.findByLabelText(say("hr.settings.payDay"), {}, LOAD), "32");
    await user.click(screen.getByRole("button", { name: say("staff.save") }));
    expect(await screen.findByText(say("hr.settings.payDayInvalid"))).toBeVisible();
    expect(calls(api, "PUT", /\/hr-settings$/)).toHaveLength(0);
  });
});
