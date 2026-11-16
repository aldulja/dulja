import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, decodeCursor, encodeCursor, ProblemSchema } from "@dulja/contracts";
import { isCalendarDate } from "@dulja/domain";
import {
  CreatePayrollRunBody,
  PayrollRunList,
  PayrollRunQuery,
  PayrollRunSchema,
  SetPayrollOverrideBody,
} from "@dulja/contracts/hr/payroll-run";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  calculatePayrollRun,
  readPayrollRun,
  recalculatePayrollRun,
  setStatutoryOverride,
  type PayrollRunKind,
  type PayrollRunStatus,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";

const CompanyParams = z.object({ companyId: z.string().uuid() });
const RunParams = CompanyParams.extend({ documentId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;
const read = PERMISSION["hr.payroll.read"],
  prepare = PERMISSION["hr.payroll.prepare"];
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/**
 * 8B T10/T11 — the payroll-run module (§4.2.7, spec:2081). Calculate, recalculate, record a manual statutory
 * override (spec:2087), read and list.
 *
 * There is NO transition route here. Submit, approve and post go through 2B's generic
 * `POST /v1/companies/{companyId}/documents/{documentId}/transitions`, which resolves the effective PAYROLL policy and
 * applies `requireDocumentPermission`; a type-specific transition route would give PAYROLL a second authority path
 * beside the one R1 and R2 are enforced on (2B's `app.document_status_before`).
 *
 * Every service call is bound to the path's company (`RunScope.companyId`): RLS bounds the tenant only, so a run of
 * another company of the same tenant is 404 here, never read or recalculated.
 */
export const payrollRunRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

payrollRunRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["hr"],
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreatePayrollRunBody } } },
    },
    middleware: [requirePermission(prepare, gate)],
    responses: {
      201: {
        description: "The calculated DRAFT run, every line with its pin",
        content: { "application/json": { schema: PayrollRunSchema } },
      },
      403: problem("forbidden"),
      404: problem("a period or configuration the run needs is missing"),
      422: problem(
        "a refusal — an unverified or uncovering rate table, a missing statutory input, or a missing account",
      ),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const detail = await c.var.withTenant(async (tx) => {
      const r = await calculatePayrollRun(tx, c.var.ctx, {
        companyId,
        kind: body.kind,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        payDate: body.payDate,
        effectiveDate: body.effectiveDate,
        branchId: body.branchId,
        ...(body.employeeIds === undefined ? {} : { employeeIds: body.employeeIds }),
      });
      return readPayrollRun(tx, r.documentId, { companyId });
    });
    return c.json(detail, 201);
  },
);

payrollRunRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/recalculate",
    tags: ["hr"],
    request: { params: RunParams, headers: IdempotencyHeader },
    middleware: [requirePermission(prepare, gate)],
    responses: {
      200: {
        description:
          "The recalculated DRAFT run. A SUBMITTED run is returned to draft first and needs a fresh submission (spec:2081)",
        content: { "application/json": { schema: PayrollRunSchema } },
      },
      403: problem("forbidden"),
      404: problem("no such run in this company"),
      409: problem("the run is approved or later"),
      422: problem("a calculation refusal"),
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const detail = await c.var.withTenant(async (tx) => {
      await recalculatePayrollRun(tx, c.var.ctx, documentId, { companyId });
      return readPayrollRun(tx, documentId, { companyId });
    });
    return c.json(detail, 200);
  },
);

payrollRunRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/overrides",
    tags: ["hr"],
    request: {
      params: RunParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: SetPayrollOverrideBody } } },
    },
    middleware: [requirePermission(prepare, gate)],
    responses: {
      200: {
        description:
          "The DRAFT run recalculated with the override applied; the override is flagged and listed (spec:2087)",
        content: { "application/json": { schema: PayrollRunSchema } },
      },
      403: problem("forbidden"),
      404: problem("no such run in this company"),
      409: problem("the run is not a draft"),
      422: problem("no such computed share, a wrong currency, or a calculation refusal"),
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const detail = await c.var.withTenant(async (tx) => {
      // `entered_by` is the session's actor, stamped by the database; the body carries no actor (LEGACY-044).
      await setStatutoryOverride(
        tx,
        c.var.ctx,
        {
          documentId,
          employeeId: body.employeeId,
          schemeId: body.schemeId,
          share: body.share,
          amount: body.amount,
          reason: body.reason,
        },
        { companyId },
      );
      return readPayrollRun(tx, documentId, { companyId });
    });
    return c.json(detail, 200);
  },
);

payrollRunRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{documentId}",
    tags: ["hr"],
    request: { params: RunParams },
    middleware: [requirePermission(read, gate)],
    responses: {
      200: {
        description: "The run, every line with its pin and override reason (spec:2087)",
        content: { "application/json": { schema: PayrollRunSchema } },
      },
      403: problem("forbidden"),
      404: problem("no such run in this company"),
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    return c.json(
      await c.var.withTenant((tx) => readPayrollRun(tx, documentId, { companyId })),
      200,
    );
  },
);

payrollRunRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["hr"],
    request: { params: CompanyParams, query: PayrollRunQuery },
    middleware: [requirePermission(read, gate)],
    responses: {
      200: {
        description: "Runs, newest period first",
        content: { "application/json": { schema: PayrollRunList } },
      },
      400: problem("an unknown or malformed query parameter"),
      403: problem("forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor === undefined ? null : decodeCursor(q.cursor);
    const kind = q["filter[kind][eq]"] ?? null;
    const status = q["filter[status][eq]"] ?? null;
    const fromStart = q["filter[periodStart][gte]"] ?? null;
    const toEnd = q["filter[periodEnd][lte]"] ?? null;
    const afterStart = after === null ? null : String(after.k[0] ?? "");
    // The cursor is base64url, not signed: a hand-made key that is not a date is refused here, not by the cast.
    if (afterStart !== null && !isCalendarDate(afterStart))
      throw new AppError("ERR_VALIDATION_FAILED", "cursor is not valid");
    const afterId = after?.id ?? null;
    // `status` and `kind` are the unions `PayrollRunListItem` declares, not bare strings: the handler returns these
    // rows straight against that schema.
    const rows = await c.var.withTenant(
      (tx) => tx<
        {
          documentId: string;
          number: string | null;
          series: string;
          status: PayrollRunStatus;
          kind: PayrollRunKind;
          periodStart: string;
          periodEnd: string;
          payDate: string;
          pinnedTables: { schemeId: string; version: number }[];
        }[]
      >`
        select d.id as "documentId", d.number::text as number, d.series, d.status::text as status, r.kind,
               to_char(r.period_start, 'YYYY-MM-DD') as "periodStart",
               to_char(r.period_end, 'YYYY-MM-DD') as "periodEnd",
               to_char(r.pay_date, 'YYYY-MM-DD') as "payDate", r.pinned_tables as "pinnedTables"
          from app.payroll_run r join app.document d on d.id = r.document_id
         where r.company_id = ${companyId}
           and (${kind}::text is null or r.kind = ${kind}::text)
           and (${status}::text is null or d.status::text = ${status}::text)
           and (${fromStart}::date is null or r.period_start >= ${fromStart}::date)
           and (${toEnd}::date is null or r.period_end <= ${toEnd}::date)
           and (${afterId}::uuid is null or (r.period_start, d.id) < (${afterStart}::date, ${afterId}::uuid))
         order by r.period_start desc, d.id desc
         limit ${q.limit + 1}`,
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    const next =
      rows.length > q.limit && last !== undefined
        ? encodeCursor({ k: [last.periodStart], id: last.documentId })
        : null;
    return c.json({ items: [...page], next_cursor: next }, 200);
  },
);

/** One module, one `PROBES` key (hazard 31). */
export const payrollRunRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/payroll-runs",
  router: payrollRunRoutes,
  permissions: [prepare, read],
  auth: "human",
};
