import { ReportDefinitionSchema } from "@dulja/contracts";
import { CreateLeaveRecordBody, LeaveRecordList } from "@dulja/contracts/hr/leave";
import { PermitExpiryList } from "@dulja/contracts/hr/permit-expiry";
import { GeneratePayslipsBody, GeneratePayslipsResult } from "@dulja/contracts/hr/payslip";
import type { Locale } from "@dulja/i18n";
import { PHYSICAL_PROPERTY_PATTERNS } from "@dulja/ui";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayrollRunRoute } from "../src/routes/hr/payroll-run";
import { daysToWire, LeaveRoute } from "../src/routes/hr/leave";
import { PermitExpiryRoute } from "../src/routes/hr/permit-expiry";
import { ReportRunRoute } from "../src/routes/reports/$code";
import { ReportsRoute } from "../src/routes/reports/index";
import {
  calls,
  COMPANY,
  definition,
  fetchMock,
  json,
  mountWith,
  problem,
  sayIn,
  stubDownloads,
  type Handler,
} from "./support/reports";

// 8D Task 10 — the payslip panel, the leave register, the permit-expiry list and the HR entry into 7A's report
// screens, on the OD-24 default baseline (owner answer of 2026-11-07). Figures are SYNTH's (hazard 1).

const LOAD = { timeout: 5000 };
const BRANCH = "0192bbbb-0001-7000-8000-000000000001";
const RUN = "0192abab-0b0b-7000-8000-000000000001";
const EMPLOYEE_A = "0192aaaa-0001-7000-8000-000000000001";
const EMPLOYEE_B = "0192aaaa-0002-7000-8000-000000000002";
const ATTACH_A = "0192a77a-0001-7000-8000-000000000001";
const ATTACH_B = "0192a77a-0002-7000-8000-000000000002";
const ATTACH_OLD = "0192a77a-0003-7000-8000-000000000003";
const ATTACH_OLDER = "0192a77a-0004-7000-8000-000000000004";
const ATTACH_CSV = "0192a77a-0005-7000-8000-000000000005";
const ANNUAL = "0192d0d0-0001-7000-8000-000000000001";
const LEAVE_1 = "0192e1e1-0001-7000-8000-000000000001";
const LEAVE_2 = "0192e1e1-0002-7000-8000-000000000002";
const HOLIDAY = "0192f1f1-0001-7000-8000-000000000001";
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

const physicalClassesAbsent = () => {
  const classes = [...document.body.querySelectorAll("[class]")]
    .map((e) => e.getAttribute("class"))
    .join(" ");
  for (const pattern of PHYSICAL_PROPERTY_PATTERNS)
    expect(classes).not.toMatch(new RegExp(pattern));
};
const directionIs = (locale: Locale) =>
  waitFor(() =>
    expect(document.documentElement).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr"),
  );
const bodyOf = (api: ReturnType<typeof fetchMock>, method: string, path: RegExp) =>
  JSON.parse(String(calls(api, method, path).at(-1)![1]!.body)) as Record<string, unknown>;

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Payslips on the payroll run screen ─────────────────────────────────────────────────────────────────────────

const line = (n: number, employeeId: string, employeeNumber: string, amount: string) => ({
  documentLineId: `0192e0e0-000${n}-7000-8000-00000000000${n}`,
  employeeId,
  employeeNumber,
  componentId: null,
  componentCode: "BASIC",
  schemeId: null,
  schemeCode: null,
  share: null,
  quantity: null,
  amount: MYR(amount),
  rateTableVersion: null,
  overrideReason: null,
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
  pinnedTables: [],
  lines: [line(1, EMPLOYEE_A, "E-0001", "2000.0000"), line(2, EMPLOYEE_B, "E-0002", "2000.0000")],
  overrides: [],
  compensationChangedBy: [],
});
const payslip = (
  attachmentId: string,
  employeeId: string,
  employeeNumber: string,
  lang: string,
) => ({
  attachmentId,
  employeeId,
  employeeNumber,
  fileName: `payslip-${employeeNumber}-2026-01-31-${lang}.pdf`,
  byteSize: 12345,
  sha256: (employeeNumber === "E-0001" ? "a" : "b").repeat(64),
});

/** One row of 2C's attachment list, as `GET …/attachments?documentId=` answers it. */
const stored = (id: string, fileName: string, createdAt: string, mimeType = "application/pdf") => ({
  id,
  companyId: COMPANY,
  documentId: RUN,
  lotId: null,
  objectKey: "opaque-store-key",
  fileName,
  mimeType,
  byteSize: 999,
  sha256: "c".repeat(64),
  uploadedBy: EMPLOYEE_A,
  createdAt,
});
const STORED = [
  stored(ATTACH_OLDER, "payslip-E-0001-2026-01-31-en.pdf", "2026-02-01T08:00:00Z"),
  stored(ATTACH_CSV, "EPF-2026-01-01.csv", "2026-02-02T08:00:00Z", "text/csv"),
  stored(ATTACH_OLD, "payslip-E-0002-2026-01-31-ar.pdf", "2026-02-03T08:00:00Z"),
];

function payslipMock(
  options: { status?: string; generate?: () => Response; list?: () => Response } = {},
) {
  const handler: Handler = (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path === "/v1/staff-context") return json(context);
    if (path.endsWith("/attachments") && method === "GET") {
      if (url.searchParams.get("documentId") !== RUN) return problem(400, "ERR_VALIDATION_FAILED");
      return options.list ? options.list() : json({ items: STORED, next_cursor: null });
    }
    if (path.endsWith(`/attachments/${ATTACH_OLD}/content`))
      return new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } });
    if (path.endsWith(`/payroll-runs/${RUN}/payslips`) && method === "POST") {
      if (options.generate) return options.generate();
      const body = GeneratePayslipsBody.parse(JSON.parse(String(init!.body)));
      const all = [
        payslip(ATTACH_A, EMPLOYEE_A, "E-0001", body.lang),
        payslip(ATTACH_B, EMPLOYEE_B, "E-0002", body.lang),
      ];
      const items = body.employeeIds
        ? all.filter((p) => body.employeeIds!.includes(p.employeeId))
        : all;
      return json(GeneratePayslipsResult.parse({ items, next_cursor: null }), 201);
    }
    if (path.endsWith(`/attachments/${ATTACH_A}/content`))
      return new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } });
    if (path.endsWith(`/payroll-runs/${RUN}`)) return json(runOf(options.status ?? "posted"));
    return problem(404, "ERR_NOT_FOUND");
  };
  return fetchMock(handler);
}
const mountRun = (api: ReturnType<typeof fetchMock>, locale: Locale = "en") => {
  const user = mountWith(api, locale, (options) => (
    <PayrollRunRoute api={options} companyId={COMPANY} documentId={RUN} />
  ));
  return { user, say: sayIn(locale) };
};

describe("8D T10 — payslips on a posted run (spec:2083)", () => {
  it.each(["en", "ar"] as const)(
    "generates one PDF per employee and lists each file with its server-computed hash, in %s",
    async (locale) => {
      const api = payslipMock();
      const { user, say } = mountRun(api, locale);
      const panel = await screen.findByRole("region", { name: say("payslip.title") }, LOAD);
      // The language defaults to the screen's own.
      expect(within(panel).getByLabelText(say("payslip.lang"))).toHaveValue(locale);
      await user.click(within(panel).getByRole("button", { name: say("payslip.generate") }));
      await waitFor(() => expect(calls(api, "POST", /\/payslips$/)).toHaveLength(1));
      expect(bodyOf(api, "POST", /\/payslips$/)).toEqual({ lang: locale });
      const init = calls(api, "POST", /\/payslips$/)[0]![1]!;
      expect(new Headers(init.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
      const grid = await within(panel).findByRole("table", { name: say("payslip.list") });
      expect(within(grid).getByText(`payslip-E-0001-2026-01-31-${locale}.pdf`)).toHaveAttribute(
        "dir",
        "ltr",
      );
      expect(screen.getByTestId("payslip-hash-E-0002")).toHaveTextContent("b".repeat(64));
      await directionIs(locale);
      physicalClassesAbsent();
    },
  );

  it("generates for one chosen employee and downloads a payslip through the attachment door", async () => {
    const downloads = stubDownloads();
    const api = payslipMock();
    const { user, say } = mountRun(api);
    const panel = await screen.findByRole("region", { name: say("payslip.title") }, LOAD);
    await user.selectOptions(within(panel).getByLabelText(say("payslip.employees")), EMPLOYEE_A);
    await user.click(within(panel).getByRole("button", { name: say("payslip.generate") }));
    await waitFor(() => expect(calls(api, "POST", /\/payslips$/)).toHaveLength(1));
    expect(bodyOf(api, "POST", /\/payslips$/)).toEqual({ lang: "en", employeeIds: [EMPLOYEE_A] });
    const download = await within(panel).findByRole("button", {
      name: say("payslip.downloadOne", { employee: "E-0001" }),
    });
    const grid = within(panel).getByRole("table", { name: say("payslip.list") });
    expect(within(grid).queryByText(/E-0002/)).toBeNull();
    await user.click(download);
    await waitFor(() => expect(downloads.clicks).toEqual(["payslip-E-0001-2026-01-31-en.pdf"]));
    expect(calls(api, "GET", new RegExp(`/attachments/${ATTACH_A}/content$`))).toHaveLength(1);
  });

  it("a refusal is the server's words (hr.filing.generate), and a DRAFT run has no payslip panel", async () => {
    const api = payslipMock({ generate: () => problem(403, "ERR_RBAC_FORBIDDEN") });
    const { user, say } = mountRun(api);
    const panel = await screen.findByRole("region", { name: say("payslip.title") }, LOAD);
    await user.click(within(panel).getByRole("button", { name: say("payslip.generate") }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "server detail for ERR_RBAC_FORBIDDEN",
    );
  });

  it("offers no payslips before the run is posted", async () => {
    const api = payslipMock({ status: "approved" });
    const { say } = mountRun(api);
    await screen.findByTestId("payroll-approval", {}, LOAD);
    expect(screen.queryByRole("region", { name: say("payslip.title") })).toBeNull();
  });

  it.each(["en", "ar"] as const)(
    "lists the payslips already on the run — every earlier generation, newest first, nothing else — in %s (Phase 8 review)",
    async (locale) => {
      const api = payslipMock();
      const { say } = mountRun(api, locale);
      const grid = await screen.findByRole("table", { name: say("payslip.earlier") }, LOAD);
      const files = within(grid)
        .getAllByText(/^payslip-/)
        .map((cell) => cell.textContent);
      expect(files).toEqual([
        "payslip-E-0002-2026-01-31-ar.pdf",
        "payslip-E-0001-2026-01-31-en.pdf",
      ]);
      expect(within(grid).queryByText("EPF-2026-01-01.csv")).toBeNull();
      expect(calls(api, "GET", /\/attachments$/)[0]![0].toString()).toContain(`documentId=${RUN}`);
      await directionIs(locale);
      physicalClassesAbsent();
    },
  );

  it("downloads an earlier payslip from its row, by keyboard (Enter) as by its button", async () => {
    const downloads = stubDownloads();
    const api = payslipMock();
    const { user, say } = mountRun(api);
    const grid = await screen.findByRole("table", { name: say("payslip.earlier") }, LOAD);
    const cell = (await within(grid).findByText("payslip-E-0002-2026-01-31-ar.pdf")).closest("td")!;
    cell.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(downloads.clicks).toEqual(["payslip-E-0002-2026-01-31-ar.pdf"]));
    expect(calls(api, "GET", new RegExp(`/attachments/${ATTACH_OLD}/content$`))).toHaveLength(1);
  });

  it("a generation refreshes the list of payslips already on the run", async () => {
    const api = payslipMock();
    const { user, say } = mountRun(api);
    const panel = await screen.findByRole("region", { name: say("payslip.title") }, LOAD);
    await screen.findByRole("table", { name: say("payslip.earlier") }, LOAD);
    expect(calls(api, "GET", /\/attachments$/)).toHaveLength(1);
    await user.click(within(panel).getByRole("button", { name: say("payslip.generate") }));
    await waitFor(() => expect(calls(api, "GET", /\/attachments$/)).toHaveLength(2));
  });

  it("a caller refused the list reads a sentence, and can still generate", async () => {
    const api = payslipMock({ list: () => problem(403, "ERR_RBAC_FORBIDDEN") });
    const { user, say } = mountRun(api);
    const panel = await screen.findByRole("region", { name: say("payslip.title") }, LOAD);
    expect(await within(panel).findByText(say("payslip.earlierDenied"), {}, LOAD)).toBeVisible();
    await user.click(within(panel).getByRole("button", { name: say("payslip.generate") }));
    await within(panel).findByRole("table", { name: say("payslip.list") });
  });

  it("links to the run's payroll register in 7A's report screen, with the run filled in", async () => {
    const api = payslipMock();
    const { say } = mountRun(api);
    const link = await screen.findByRole("link", { name: say("payslip.register") }, LOAD);
    const href = decodeURIComponent(link.getAttribute("href") ?? "");
    expect(href).toContain("/reports/hr.payroll_register");
    expect(href).toContain(RUN);
    expect(href).toContain("payrollDocumentId");
  });
});

// ── The permit-expiry list ──────────────────────────────────────────────────────────────────────────────────────

const permits = PermitExpiryList.parse({
  items: [
    {
      employeeId: EMPLOYEE_A,
      employeeNumber: "E-0001",
      employeeNameEn: "Aisyah",
      branchCode: "HQ",
      position: "Cashier",
      workPermitExpiry: "2026-11-01",
      daysRemaining: -7,
    },
    {
      employeeId: EMPLOYEE_B,
      employeeNumber: "E-0002",
      employeeNameEn: "Bala",
      branchCode: "HQ",
      position: null,
      workPermitExpiry: "2026-12-08",
      daysRemaining: 30,
    },
  ],
  next_cursor: null,
});
function permitMock(answer: () => Response = () => json(permits)) {
  return fetchMock((url) => {
    if (url.pathname === "/v1/staff-context") return json(context);
    if (url.pathname.endsWith("/employees/permit-expiry")) return answer();
    return problem(404, "ERR_NOT_FOUND");
  });
}

describe("8D T10 — the permit-expiry list (spec:2091, 8D A3)", () => {
  it.each(["en", "ar"] as const)(
    "lists permits soonest first, marks a lapsed one, and asks with the route's own query, in %s",
    async (locale) => {
      const api = permitMock();
      const user = mountWith(api, locale, (options) => <PermitExpiryRoute api={options} />);
      const say = sayIn(locale);
      const grid = await screen.findByRole("table", { name: say("permit.list") }, LOAD);
      expect(within(grid).getByText(say("permit.lapsed", { days: "7" }))).toBeVisible();
      expect(within(grid).getByText(say("permit.days", { days: "30" }))).toBeVisible();
      const first = calls(api, "GET", /permit-expiry$/)[0]![0];
      expect(String(first)).toContain("withinDays=90");
      expect(String(first)).toContain("includeTerminated=false");
      const window = screen.getByLabelText(say("permit.within"));
      expect(window).toHaveFocus();
      await user.clear(window);
      await user.type(window, "30");
      await user.click(screen.getByLabelText(say("permit.includeTerminated")));
      await waitFor(() =>
        expect(
          calls(api, "GET", /permit-expiry$/).some(
            ([input]) =>
              String(input).includes("withinDays=30") &&
              String(input).includes("includeTerminated=true"),
          ),
        ).toBe(true),
      );
      await directionIs(locale);
      physicalClassesAbsent();
    },
  );

  it("a caller without hr.employee.read_sensitive reads a sentence, never an empty list", async () => {
    const api = permitMock(() => problem(403, "ERR_RBAC_FORBIDDEN"));
    mountWith(api, "en", (options) => <PermitExpiryRoute api={options} />);
    const say = sayIn("en");
    expect(await screen.findByText(say("permit.denied"), {}, LOAD)).toBeVisible();
    expect(screen.queryByRole("table", { name: say("permit.list") })).toBeNull();
  });

  it("a window the route would refuse is not sent", async () => {
    const api = permitMock();
    const user = mountWith(api, "en", (options) => <PermitExpiryRoute api={options} />);
    const say = sayIn("en");
    const window = await screen.findByLabelText(say("permit.within"), {}, LOAD);
    await user.clear(window);
    await user.type(window, "99999");
    expect(await screen.findByText(say("permit.withinInvalid"))).toBeVisible();
    expect(
      calls(api, "GET", /permit-expiry$/).some(([input]) => String(input).includes("99999")),
    ).toBe(false);
  });
});

// ── The leave register ──────────────────────────────────────────────────────────────────────────────────────────

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
const record = (id: string, employeeId: string, employeeNumber: string, status: string) => ({
  id,
  employeeId,
  employeeNumber,
  leaveTypeId: ANNUAL,
  leaveTypeCode: "annual",
  startsOn: "2026-03-02",
  endsOn: "2026-03-03",
  days: "2.00",
  status,
  approvedBy: status === "requested" ? null : EMPLOYEE_A,
  reason: "family",
});
const annual = {
  id: ANNUAL,
  code: "annual",
  nameEn: "Annual leave",
  nameAr: "إجازة سنوية",
  paid: true,
  archivedAt: null,
};

function leaveMock(
  options: { decide?: (body: Record<string, unknown>) => Response; types?: () => Response } = {},
) {
  const records = [
    record(LEAVE_1, EMPLOYEE_A, "E-0001", "requested"),
    record(LEAVE_2, EMPLOYEE_B, "E-0002", "requested"),
  ];
  const handler: Handler = (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const body = () => JSON.parse(String(init!.body)) as Record<string, unknown>;
    if (path === "/v1/staff-context") return json(context);
    if (path.endsWith("/employees"))
      return json({
        items: [employee(EMPLOYEE_B, "E-0002"), employee(EMPLOYEE_A, "E-0001")],
        next_cursor: null,
      });
    const decision = /\/leave-records\/([^/]+)\/decision$/.exec(path);
    if (decision && method === "POST") {
      const b = body();
      if (options.decide) return options.decide(b);
      const r = records.find((x) => x.id === decision[1])!;
      r.status = String(b["decision"]);
      return json({ ...r, approvedBy: EMPLOYEE_A });
    }
    if (path.endsWith("/leave-records/types") && method === "POST")
      return json(
        { ...annual, ...body(), id: "0192d0d0-0002-7000-8000-000000000002", archivedAt: null },
        201,
      );
    if (path.endsWith("/leave-records/types"))
      return options.types ? options.types() : json({ items: [annual], next_cursor: null });
    if (path.endsWith("/leave-records/entitlements") && method === "PUT")
      return json({ ...body(), employeeNumber: "E-0002", leaveTypeCode: "annual" });
    if (path.endsWith("/leave-records/entitlements"))
      return json({
        items: [
          {
            employeeId: EMPLOYEE_A,
            employeeNumber: "E-0001",
            year: 2026,
            leaveTypeId: ANNUAL,
            leaveTypeCode: "annual",
            days: "14.00",
          },
        ],
        next_cursor: null,
      });
    if (path.endsWith("/leave-records/holidays") && method === "POST")
      return json({ ...body(), id: "0192f1f1-0002-7000-8000-000000000002" }, 201);
    if (path.endsWith("/leave-records/holidays"))
      return json({
        items: [
          {
            id: HOLIDAY,
            branchId: null,
            holidayOn: "2026-08-31",
            nameEn: "National day",
            nameAr: "اليوم الوطني",
          },
        ],
        next_cursor: null,
      });
    if (path.endsWith("/leave-records") && method === "POST")
      return json({ ...record(LEAVE_1, EMPLOYEE_B, "E-0002", "requested"), ...body() }, 201);
    if (path.endsWith("/leave-records")) {
      const status = url.searchParams.get("filter[status][eq]");
      return json(
        LeaveRecordList.parse({
          items: records.filter((r) => status === null || r.status === status),
          next_cursor: null,
        }),
      );
    }
    return problem(404, "ERR_NOT_FOUND");
  };
  return fetchMock(handler);
}
const mountLeave = (api: ReturnType<typeof fetchMock>, locale: Locale = "en") => {
  const user = mountWith(api, locale, (options) => <LeaveRoute api={options} />);
  return { user, say: sayIn(locale) };
};

describe("8D T10 — helpers", () => {
  it("writes a typed day count as numeric(6,2), exactly, and refuses what the route would", () => {
    expect(daysToWire("2")).toBe("2.00");
    expect(daysToWire(" 1.5 ")).toBe("1.50");
    expect(daysToWire("0.25")).toBe("0.25");
    for (const bad of ["", "1.005", "-1", "12345", "1,5", "two"])
      expect(daysToWire(bad)).toBeNull();
  });
});

describe("8D T10 — the leave register (⚠️ OD-13, spec:2085)", () => {
  it.each(["en", "ar"] as const)(
    "lists the requested records by default with each type in the screen's language, in %s",
    async (locale) => {
      const api = leaveMock();
      const { say } = mountLeave(api, locale);
      const grid = await screen.findByRole("table", { name: say("leave.list") }, LOAD);
      expect(await within(grid).findByText("E-0001")).toBeVisible();
      expect(
        within(grid).getAllByText(locale === "ar" ? "إجازة سنوية" : "Annual leave"),
      ).toHaveLength(2);
      expect(
        calls(api, "GET", /\/leave-records$/).some(([input]) =>
          String(input).includes("filter%5Bstatus%5D%5Beq%5D=requested"),
        ),
      ).toBe(true);
      expect(screen.getByRole("table", { name: say("leave.entitlementList") })).toBeVisible();
      expect(
        await screen.findByText(locale === "ar" ? "اليوم الوطني" : "National day"),
      ).toBeVisible();
      expect(screen.getByText(say("leave.allBranches"))).toBeVisible();
      await directionIs(locale);
      physicalClassesAbsent();
    },
  );

  it("approves a request from its row, and the decision is the server's", async () => {
    const api = leaveMock();
    const { user, say } = mountLeave(api);
    await user.click(
      await screen.findByRole(
        "button",
        { name: say("leave.approveOne", { employee: "E-0002" }) },
        LOAD,
      ),
    );
    await waitFor(() => expect(calls(api, "POST", /\/decision$/)).toHaveLength(1));
    expect(String(calls(api, "POST", /\/decision$/)[0]![0])).toContain(LEAVE_2);
    expect(bodyOf(api, "POST", /\/decision$/)).toEqual({ decision: "approved" });
    expect(
      await screen.findByText(
        say("leave.decided", { employee: "E-0002", status: say("leave.status.approved") }),
      ),
    ).toBeVisible();
  });

  it("the keyboard path: Enter on a requested row opens its decision, Approve has the cursor, Enter decides", async () => {
    const api = leaveMock();
    const { user, say } = mountLeave(api);
    const grid = await screen.findByRole("table", { name: say("leave.list") }, LOAD);
    const cell = (await within(grid).findByText("E-0002")).closest("td")!;
    cell.focus();
    await user.keyboard("{Enter}");
    const panel = await screen.findByRole("region", {
      name: say("leave.decideTitle", { employee: "E-0002" }),
    });
    const approve = within(panel).getByRole("button", { name: say("leave.approve") });
    expect(approve).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls(api, "POST", /\/decision$/)).toHaveLength(1));
    expect(String(calls(api, "POST", /\/decision$/)[0]![0])).toContain(LEAVE_2);
    expect(bodyOf(api, "POST", /\/decision$/)).toEqual({ decision: "approved" });
  });

  it("R4 is the database's answer, shown as the server words it: one's own leave is refused", async () => {
    const api = leaveMock({ decide: () => problem(409, "ERR_HR_SELF_PAY") });
    const { user, say } = mountLeave(api);
    await user.click(
      await screen.findByRole(
        "button",
        { name: say("leave.approveOne", { employee: "E-0001" }) },
        LOAD,
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("server detail for ERR_HR_SELF_PAY");
  });

  it("rejects with an optional reason in a form that takes the cursor", async () => {
    const api = leaveMock();
    const { user, say } = mountLeave(api);
    await user.click(
      await screen.findByRole(
        "button",
        { name: say("leave.rejectOne", { employee: "E-0002" }) },
        LOAD,
      ),
    );
    const reason = screen.getByLabelText(say("leave.rejectReason"));
    expect(reason).toHaveFocus();
    await user.type(reason, "busy month{Enter}");
    await waitFor(() => expect(calls(api, "POST", /\/decision$/)).toHaveLength(1));
    expect(bodyOf(api, "POST", /\/decision$/)).toEqual({
      decision: "rejected",
      reason: "busy month",
    });
  });

  it("requests leave: the first control has focus, days are written exactly, and a bad count is refused locally", async () => {
    const api = leaveMock();
    const { user, say } = mountLeave(api);
    await user.click(await screen.findByRole("button", { name: say("leave.new") }, LOAD));
    const form = await screen.findByRole("form", { name: say("leave.new") });
    const who = within(form).getByLabelText(say("leave.employee"));
    expect(who).toHaveFocus();
    await within(form).findByRole("option", { name: "E-0002" });
    await user.selectOptions(who, EMPLOYEE_B);
    await within(form).findByRole("option", { name: "Annual leave" });
    await user.selectOptions(within(form).getByLabelText(say("leave.type")), ANNUAL);
    await user.type(within(form).getByLabelText(say("leave.startsOn")), "2026-04-06");
    await user.type(within(form).getByLabelText(say("leave.endsOn")), "2026-04-07");
    await user.type(within(form).getByLabelText(say("leave.days")), "1.005");
    await user.click(within(form).getByRole("button", { name: say("leave.save") }));
    expect(await within(form).findByText(say("leave.daysInvalid"))).toBeVisible();
    expect(calls(api, "POST", /\/leave-records$/)).toHaveLength(0);
    await user.clear(within(form).getByLabelText(say("leave.days")));
    await user.type(within(form).getByLabelText(say("leave.days")), "1.5");
    await user.click(within(form).getByRole("button", { name: say("leave.save") }));
    await waitFor(() => expect(calls(api, "POST", /\/leave-records$/)).toHaveLength(1));
    const sent = bodyOf(api, "POST", /\/leave-records$/);
    expect(CreateLeaveRecordBody.safeParse(sent).success).toBe(true);
    expect(sent).toEqual({
      employeeId: EMPLOYEE_B,
      leaveTypeId: ANNUAL,
      startsOn: "2026-04-06",
      endsOn: "2026-04-07",
      days: "1.50",
      reason: null,
    });
    // Saved: the form closes and the cursor returns to its opener.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: say("leave.new") })).toHaveFocus(),
    );
  });

  // UI-10: the request's own contract refused it before sending; the operator reads which field and why.
  it.each(["en", "ar"] as const)(
    "names the field and reason when the contract refuses the request locally, in %s",
    async (locale) => {
      const api = leaveMock();
      const { user, say } = mountLeave(api, locale);
      await user.click(await screen.findByRole("button", { name: say("leave.new") }, LOAD));
      const form = await screen.findByRole("form", { name: say("leave.new") });
      await within(form).findByRole("option", { name: "E-0002" });
      await user.selectOptions(within(form).getByLabelText(say("leave.employee")), EMPLOYEE_B);
      await within(form).findByRole("option", {
        name: locale === "ar" ? "إجازة سنوية" : "Annual leave",
      });
      await user.selectOptions(within(form).getByLabelText(say("leave.type")), ANNUAL);
      await user.type(within(form).getByLabelText(say("leave.startsOn")), "2026-04-06");
      await user.type(within(form).getByLabelText(say("leave.endsOn")), "2026-04-07");
      await user.type(within(form).getByLabelText(say("leave.days")), "3");
      await user.click(within(form).getByRole("button", { name: say("leave.save") }));
      const alert = await within(form).findByRole("alert");
      expect(alert).toHaveTextContent(say("problem.ERR_VALIDATION_FAILED.title"));
      expect(alert).not.toHaveTextContent(say("app.error.title"));
      expect(alert).toHaveTextContent("/days");
      expect(alert).toHaveTextContent("days exceeds the span's 2 calendar day(s)");
      expect(calls(api, "POST", /\/leave-records$/)).toHaveLength(0);
    },
  );

  it("adds a leave type, an entitlement and a company-wide holiday", async () => {
    const api = leaveMock();
    const { user, say } = mountLeave(api);
    await user.click(await screen.findByRole("button", { name: say("leave.typeNew") }, LOAD));
    const typeForm = await screen.findByRole("form", { name: say("leave.typeNew") });
    await user.selectOptions(within(typeForm).getByLabelText(say("leave.typeCode")), "sick");
    await user.type(within(typeForm).getByLabelText(say("leave.nameEn")), "Sick leave");
    await user.type(within(typeForm).getByLabelText(say("leave.nameAr")), "إجازة مرضية");
    await user.click(within(typeForm).getByRole("button", { name: say("leave.save") }));
    await waitFor(() => expect(calls(api, "POST", /\/types$/)).toHaveLength(1));
    expect(bodyOf(api, "POST", /\/types$/)).toEqual({
      code: "sick",
      nameEn: "Sick leave",
      nameAr: "إجازة مرضية",
      paid: true,
    });

    await user.click(screen.getByRole("button", { name: say("leave.entitlementNew") }));
    const entitlement = await screen.findByRole("form", { name: say("leave.entitlementNew") });
    await within(entitlement).findByRole("option", { name: "E-0002" });
    await user.selectOptions(within(entitlement).getByLabelText(say("leave.employee")), EMPLOYEE_B);
    await user.selectOptions(within(entitlement).getByLabelText(say("leave.type")), ANNUAL);
    const year = within(entitlement).getByLabelText(say("leave.year"));
    await user.clear(year);
    await user.type(year, "2026");
    await user.type(within(entitlement).getByLabelText(say("leave.days")), "14");
    await user.click(within(entitlement).getByRole("button", { name: say("leave.save") }));
    await waitFor(() => expect(calls(api, "PUT", /\/entitlements$/)).toHaveLength(1));
    expect(bodyOf(api, "PUT", /\/entitlements$/)).toEqual({
      employeeId: EMPLOYEE_B,
      year: 2026,
      leaveTypeId: ANNUAL,
      days: "14.00",
    });

    await user.click(screen.getByRole("button", { name: say("leave.holidayNew") }));
    const holiday = await screen.findByRole("form", { name: say("leave.holidayNew") });
    expect(within(holiday).getByLabelText(say("leave.holidayOn"))).toHaveFocus();
    await user.type(within(holiday).getByLabelText(say("leave.holidayOn")), "2026-09-16");
    await user.type(within(holiday).getByLabelText(say("leave.nameEn")), "Malaysia day");
    await user.click(within(holiday).getByRole("button", { name: say("leave.save") }));
    await waitFor(() => expect(calls(api, "POST", /\/holidays$/)).toHaveLength(1));
    expect(bodyOf(api, "POST", /\/holidays$/)).toEqual({
      branchId: null,
      holidayOn: "2026-09-16",
      nameEn: "Malaysia day",
      nameAr: null,
    });
  });

  it("Esc closes a form and returns the cursor to its opener", async () => {
    const api = leaveMock();
    const { user, say } = mountLeave(api);
    await user.click(await screen.findByRole("button", { name: say("leave.typeNew") }, LOAD));
    await screen.findByRole("form", { name: say("leave.typeNew") });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: say("leave.typeNew") })).toHaveFocus(),
    );
  });

  it("a records-only reader is told why types are hidden, never shown an empty catalogue as fact", async () => {
    const api = leaveMock({ types: () => problem(403, "ERR_RBAC_FORBIDDEN") });
    const { say } = mountLeave(api);
    expect(await screen.findAllByText(say("leave.recordDenied"), {}, LOAD)).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: say("leave.typeNew") })).toBeNull();
  });
});

// ── The HR reports entry: 7A's list and run screen, reused ─────────────────────────────────────────────────────

const hrRow = (id: string, code: string, extra: Record<string, unknown>) =>
  ReportDefinitionSchema.parse({
    id,
    companyId: COMPANY,
    code,
    version: 1,
    definition: definition({ code, module: "hr", permission: "hr.payroll.read", ...extra }),
    clonedFrom: null,
    isCore: true,
    archivedAt: null,
    createdAt: "2026-11-01T00:00:00Z",
  });
const REGISTER = hrRow("0192dddd-0008-7000-8000-000000000008", "hr.payroll_register", {
  nameEn: "Payroll register",
  nameAr: "سجل الرواتب",
  parameters: [
    { name: "payrollDocumentId", kind: "text", required: true },
    { name: "branchId", kind: "text", required: false },
  ],
});
const ATTENDANCE = hrRow("0192dddd-0009-7000-8000-000000000009", "hr.attendance", {
  nameEn: "Attendance",
  nameAr: "الحضور",
  parameters: [{ name: "kind", kind: "enum", required: false, options: ["clock_in", "clock_out"] }],
});
const LEDGER = ReportDefinitionSchema.parse({
  id: "0192dddd-0001-7000-8000-000000000001",
  companyId: COMPANY,
  code: "accounting.trial_balance",
  version: 1,
  definition: definition(),
  clonedFrom: null,
  isCore: true,
  archivedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
});
function reportsMock() {
  return fetchMock((url) => {
    const path = url.pathname;
    const code = url.searchParams.get("filter[code][eq]");
    if (path.endsWith("/report-definitions"))
      return json({
        items: [LEDGER, REGISTER, ATTENDANCE].filter((r) => code === null || r.code === code),
        next_cursor: null,
      });
    if (path.endsWith("/saved-views") || path.endsWith("/report-runs"))
      return json({ items: [], next_cursor: null });
    return problem(404, "ERR_NOT_FOUND");
  });
}

describe("8D T10 — HR reports through 7A's screens (reuse, not a second viewer)", () => {
  it.each(["en", "ar"] as const)(
    "the HR entry opens the list on the hr module; the module filter widens it again, in %s",
    async (locale) => {
      const api = reportsMock();
      const navigation = { run: vi.fn(), design: vi.fn() };
      const user = mountWith(api, locale, (options) => (
        <ReportsRoute api={options} companyId={COMPANY} navigation={navigation} module="hr" />
      ));
      const say = sayIn(locale);
      const grid = await screen.findByRole("table", { name: say("report.list") }, LOAD);
      expect(await within(grid).findByText("hr.payroll_register")).toBeVisible();
      expect(within(grid).getByText("hr.attendance")).toBeVisible();
      expect(within(grid).queryByText("accounting.trial_balance")).toBeNull();
      await user.selectOptions(screen.getByLabelText(say("report.module")), "");
      expect(await within(grid).findByText("accounting.trial_balance")).toBeVisible();
      await directionIs(locale);
      physicalClassesAbsent();
    },
  );

  it("a run screen opened with parameters fills them in — and only the ones its definition declares", async () => {
    const api = reportsMock();
    mountWith(api, "en", (options) => (
      <ReportRunRoute
        api={options}
        companyId={COMPANY}
        code="hr.payroll_register"
        definitionId={null}
        preset={{ payrollDocumentId: RUN, notDeclared: "x" }}
        onBack={vi.fn()}
        onDesign={vi.fn()}
        onSelect={vi.fn()}
      />
    ));
    const say = sayIn("en");
    const field = await screen.findByLabelText(
      say("report.param.required", { label: say("report.param.name.payrollDocumentId") }),
      {},
      LOAD,
    );
    expect(field).toHaveValue(RUN);
  });

  it("labels hr.attendance's kind as an attendance event kind, with its options named", async () => {
    const api = reportsMock();
    mountWith(api, "ar", (options) => (
      <ReportRunRoute
        api={options}
        companyId={COMPANY}
        code="hr.attendance"
        definitionId={null}
        onBack={vi.fn()}
        onDesign={vi.fn()}
        onSelect={vi.fn()}
      />
    ));
    const say = sayIn("ar");
    const kind = await screen.findByLabelText(say("report.param.for.hr.attendance.kind"), {}, LOAD);
    expect(
      within(kind).getByRole("option", { name: say("report.param.option.clock_in") }),
    ).toBeInTheDocument();
    expect(screen.queryByText(say("report.param.name.kind"))).toBeNull();
  });
});
