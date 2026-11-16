import { CreateExportBody, ExportJobSchema, type ExportJobDto } from "@dulja/contracts";
import type { Locale } from "@dulja/i18n";
import { PHYSICAL_PROPERTY_PATTERNS } from "@dulja/ui";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportsRoute } from "../../../src/routes/admin/exports";
import {
  ACTOR,
  calls,
  COMPANY,
  fetchMock,
  json,
  mountWith,
  problem,
  sayIn,
  stubDownloads,
  type Handler,
} from "../../support/reports";

const JOB = "0192baba-0001-7000-8000-000000000001";
const OLD = "0192baba-0002-7000-8000-000000000002";
const LOAD = { timeout: 5000 };
const POLL = { timeout: 6000 };
const STATUS_URL = `/v1/companies/${COMPANY}/exports/${JOB}`;
const SHA = "c".repeat(64);

const job = (
  status: ExportJobDto["status"],
  overrides: Partial<Record<keyof ExportJobDto, unknown>> = {},
): ExportJobDto =>
  ExportJobSchema.parse({
    id: JOB,
    companyId: COMPANY,
    requestedBy: ACTOR,
    format: "both",
    status,
    readableModules: ["accounting"],
    lotAttachments: false,
    includeAttachments: true,
    tableCount: status === "done" ? 41 : null,
    rowCount: status === "done" ? "1234" : null,
    byteSize: status === "done" ? "2048" : null,
    sha256: status === "done" ? SHA : null,
    manifest:
      status === "done"
        ? {
            formatVersion: 1,
            exportJobId: JOB,
            companyId: COMPANY,
            generatedAt: "2026-11-06T00:00:00Z",
            format: "both",
            tables: [],
            excluded: [
              { table: "employee", gate: "hr.employee.read" },
              { table: "stock_movement", gate: "inventory.stock.read" },
            ],
            excludedRows: [{ table: "document_line", gate: "hr.payroll.read", module: "hr" }],
            attachments: [],
            attachmentsOmitted: [],
          }
        : null,
    startedAt: status === "queued" ? null : "2026-11-06T00:00:01Z",
    finishedAt: status === "done" || status === "failed" ? "2026-11-06T00:00:05Z" : null,
    error: status === "failed" ? "ERR_INTERNAL: the object store refused the archive" : null,
    createdAt: "2026-11-06T00:00:00Z",
    ...overrides,
  });

function exportApi(
  options: {
    statuses?: ExportJobDto["status"][];
    post?: () => Response;
    list?: () => Response;
    history?: ExportJobDto[];
  } = {},
) {
  const statuses = [...(options.statuses ?? ["queued", "running", "done"])];
  const handler: Handler = (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path.endsWith("/exports") && method === "POST")
      return options.post
        ? options.post()
        : json({ exportJobId: JOB, jobId: "job-1", statusUrl: STATUS_URL }, 202);
    if (path.endsWith("/exports"))
      return options.list
        ? options.list()
        : json({ items: options.history ?? [], next_cursor: null });
    if (path.endsWith(`/exports/${JOB}/content`))
      return new Response(new Uint8Array([31, 139, 8]), {
        headers: { "content-type": "application/gzip" },
      });
    if (path.endsWith(`/exports/${JOB}`)) return json(job(statuses.shift() ?? "done"));
    if (path.endsWith(`/exports/${OLD}`)) return json(job("failed", { id: OLD }));
    return problem(404, "ERR_NOT_FOUND");
  };
  return fetchMock(handler);
}

function mount(api: ReturnType<typeof exportApi>, locale: Locale = "en") {
  const user = mountWith(api, locale, (options) => (
    <ExportsRoute api={options} companyId={COMPANY} />
  ));
  return { user, say: sayIn(locale) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("7C T13 — the tenant export screen", () => {
  it.each(["en", "ar"] as const)(
    "offers exactly the three formats (both by default) and the attachments toggle (on), in %s",
    async (locale) => {
      const { say } = mount(exportApi(), locale);
      const form = await screen.findByRole("form", { name: say("admin.export.request") }, LOAD);
      const format = within(form).getByLabelText(say("admin.export.format"));
      expect(format).toHaveValue("both");
      expect(
        within(format)
          .getAllByRole("option")
          .map((o) => (o as HTMLOptionElement).value),
      ).toEqual(["both", "csv", "json"]);
      expect(within(form).getByLabelText(say("admin.export.includeAttachments"))).toBeChecked();
      // No fourth control: CreateExportBody has two members and is strict.
      expect(form.querySelectorAll("input, select, textarea")).toHaveLength(2);
      await waitFor(() =>
        expect(document.documentElement).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr"),
      );
      const classes = [...document.body.querySelectorAll("[class]")]
        .map((e) => e.getAttribute("class"))
        .join(" ");
      for (const pattern of PHYSICAL_PROPERTY_PATTERNS)
        expect(classes).not.toMatch(new RegExp(pattern));
    },
  );

  it.each(["en", "ar"] as const)(
    "requests with Ctrl+Enter, polls the returned statusUrl, then downloads with the SHA-256 shown, in %s",
    async (locale) => {
      const downloads = stubDownloads();
      const api = exportApi();
      const { user, say } = mount(api, locale);
      const form = await screen.findByRole("form", { name: say("admin.export.request") }, LOAD);
      await user.selectOptions(within(form).getByLabelText(say("admin.export.format")), "csv");
      await user.click(within(form).getByLabelText(say("admin.export.includeAttachments")));
      await user.keyboard("{Control>}{Enter}{/Control}");
      await waitFor(() => expect(calls(api, "POST", /\/exports$/)).toHaveLength(1));
      const body = JSON.parse(String(calls(api, "POST", /\/exports$/)[0]![1]!.body));
      expect(CreateExportBody.safeParse(body).success).toBe(true);
      expect(body).toEqual({ format: "csv", includeAttachments: false });
      expect(await screen.findByText(say("admin.export.status.queued"))).toBeVisible();
      const download = await screen.findByRole(
        "button",
        { name: say("admin.export.download") },
        POLL,
      );
      expect(download).toHaveFocus();
      // Every status read went to the statusUrl the 202 returned — never a job path.
      const reads = calls(api, "GET", /\/exports\/[^/]+$/).map(
        ([input]) => new URL(String(input)).pathname,
      );
      expect(reads.length).toBeGreaterThanOrEqual(3);
      expect(new Set(reads)).toEqual(new Set([STATUS_URL]));
      expect(screen.getByTestId("export-sha256")).toHaveTextContent(SHA);
      expect(screen.getByTestId("export-sha256")).toHaveAttribute("dir", "ltr");
      await user.click(download);
      await waitFor(() => expect(downloads.clicks).toEqual([`dulja-export-${JOB}.tar.gz`]));
      expect(calls(api, "GET", new RegExp(`/exports/${JOB}/content$`))).toHaveLength(1);
    },
  );

  it.each(["en", "ar"] as const)(
    "lists every table the requester's gates kept out, with its gate, in %s",
    async (locale) => {
      const { user, say } = mount(exportApi({ statuses: ["done"] }), locale);
      await user.click(
        await screen.findByRole("button", { name: say("admin.export.submit") }, LOAD),
      );
      const excluded = await screen.findByTestId("export-excluded", {}, POLL);
      const items = within(excluded).getAllByRole("listitem");
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent("employee");
      expect(items[0]).toHaveTextContent("hr.employee.read");
      expect(items[1]).toHaveTextContent("inventory.stock.read");
      expect(screen.getByText(say("admin.export.excludedHint"))).toBeVisible();
    },
  );

  it.each(["en", "ar"] as const)(
    "lists the rows a module gate kept out of an included table, with module and gate, in %s (Phase 8 review)",
    async (locale) => {
      const { user, say } = mount(exportApi({ statuses: ["done"] }), locale);
      await user.click(
        await screen.findByRole("button", { name: say("admin.export.submit") }, LOAD),
      );
      const rows = await screen.findByTestId("export-excluded-rows", {}, POLL);
      const items = within(rows).getAllByRole("listitem");
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent("document_line");
      expect(items[0]).toHaveTextContent("hr.payroll.read");
      expect(items[0]).toHaveTextContent(say("admin.export.excludedRowsModule"));
      expect(screen.getByText(say("admin.export.excludedRowsHint"))).toBeVisible();
    },
  );

  it("shows a failed export's error and offers a new request, never a retry of that row", async () => {
    const api = exportApi({ history: [job("failed", { id: OLD })] });
    const { user, say } = mount(api);
    const table = await screen.findByRole("table", { name: say("admin.export.list") }, LOAD);
    await within(table).findByText(say("admin.export.status.failed"));
    within(table).getAllByRole("cell")[0]!.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText("ERR_INTERNAL: the object store refused the archive"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: say("admin.export.newRequest") }));
    expect(screen.getByLabelText(say("admin.export.format"))).toHaveFocus();
    expect(
      screen.queryByText("ERR_INTERNAL: the object store refused the archive"),
    ).not.toBeInTheDocument();
    expect(calls(api, "POST", /./)).toHaveLength(0);
  });

  it.each(["en", "ar"] as const)(
    "renders a 403's remedy and no stack trace, in %s",
    async (locale) => {
      const api = exportApi({ post: () => problem(403, "ERR_RBAC_FORBIDDEN") });
      const { user, say } = mount(api, locale);
      await user.click(
        await screen.findByRole("button", { name: say("admin.export.submit") }, LOAD),
      );
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(say("problem.ERR_RBAC_FORBIDDEN.title"));
      expect(alert).toHaveTextContent(say("problem.ERR_RBAC_FORBIDDEN.remedy"));
      expect(alert).toHaveTextContent("req-1");
      expect(alert.textContent).not.toMatch(/\bat \w+ \(/);
    },
  );
});
