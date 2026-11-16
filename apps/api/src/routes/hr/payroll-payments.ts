import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, decodeCursor, encodeCursor, ProblemSchema } from "@dulja/contracts";
import {
  CreatePayrollPaymentBody,
  PayrollPaymentList,
  PayrollPaymentQuery,
  PayrollPaymentSchema,
} from "@dulja/contracts/hr/payroll-payment";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  createPayrollPayment,
  listMoneyOut,
  payrollBatchCsv,
  readMoneyOut,
  type MoneyOutResult,
} from "@dulja/db";
import { isCalendarDate } from "@dulja/domain";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";

const CompanyParams = z.object({ companyId: z.string().uuid() });
const DocumentParams = CompanyParams.extend({ documentId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;
const pay = PERMISSION["hr.payroll.pay"],
  read = PERMISSION["hr.payroll.read"];
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 8C T6 — the payroll-payment module (§4.2.7, round 18 B10, spec:2082/2083). Draft a bank batch for a POSTED run's
 * net pay, list, read, and download the bank-neutral CSV.
 *
 * `hr.payroll.pay` gates the RELEASE (the draft). There is NO transition route here: submit, approve and post go
 * through 2B's generic `POST …/documents/{documentId}/transitions`, which resolves PAYROLL_PAYMENT's policy —
 * `accounting.payment.approve` / `.post` — and enforces R1 and R2, so the two-person rule is the one Phase 4's
 * payments already keep.
 *
 * Every service call is bound to the path's company AND to the type: a document of another company, or a JOURNAL
 * asked for by id, is 404.
 */
export const payrollPaymentRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

/** `document.notes` is `payroll:<run id>` on every batch — `createPayrollPayment` writes it and reads it back to
 *  exclude an employee already paid on that run. A batch without it was not drafted by this module. */
const payrollRunOf = (r: MoneyOutResult): string => {
  const id = r.notes?.startsWith("payroll:") === true ? r.notes.slice("payroll:".length) : null;
  if (id === null || !UUID.test(id)) {
    throw new AppError(
      "ERR_INTERNAL",
      `payroll payment ${r.documentId} carries no payroll run reference`,
    );
  }
  return id;
};

/** The ONE place a `MoneyOutResult` becomes `PayrollPaymentSchema`'s body: the 201, the list item and the detail
 *  are the same object by construction. */
const present = (r: MoneyOutResult): z.infer<typeof PayrollPaymentSchema> => ({
  documentId: r.documentId,
  series: r.series,
  number: r.number,
  status: r.status,
  effectiveDate: r.effectiveDate,
  branchId: r.branchId,
  payrollDocumentId: payrollRunOf(r),
  employeeCount: r.employeeCount,
  total: r.total.toJSON(),
  lines: r.lines.map((l) => ({
    documentLineId: l.documentLineId,
    employeeId: l.employeeId,
    employeeNumber: l.employeeNumber,
    employeeName: l.employeeName,
    amount: l.amount.toJSON(),
    branchId: l.branchId,
  })),
});

/** The cursor is base64url, not signed: a hand-made key that is not a (date, uuid) pair is refused here, not by a
 *  cast in SQL. */
export function moneyOutCursor(
  raw: string | undefined,
): { effectiveDate: string; id: string } | null {
  if (raw === undefined) return null;
  const cursor = decodeCursor(raw);
  const effectiveDate = String(cursor.k[0] ?? "");
  if (cursor.k.length !== 1 || !isCalendarDate(effectiveDate) || !UUID.test(cursor.id)) {
    throw new AppError("ERR_VALIDATION_FAILED", "cursor is not valid");
  }
  return { effectiveDate, id: cursor.id };
}

payrollPaymentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["hr"],
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreatePayrollPaymentBody } } },
    },
    middleware: [requirePermission(pay, gate)],
    responses: {
      201: {
        description:
          "The DRAFT batch, one line per unpaid employee at the run's net pay. Submit, approve and post it through …/documents/{documentId}/transitions",
        content: { "application/json": { schema: PayrollPaymentSchema } },
      },
      400: problem(
        "an invalid body, every employee on the run already paid, or a named employee not on it",
      ),
      403: problem("forbidden"),
      404: problem("no such payroll run in this company"),
      409: problem("the run is not posted"),
      422: problem("the PAYROLL_PAYMENT type is not configured for the company"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await c.var.withTenant((tx) =>
      createPayrollPayment(tx, c.var.ctx, {
        companyId,
        payrollDocumentId: body.payrollDocumentId,
        effectiveDate: body.effectiveDate,
        branchId: body.branchId,
        ...(body.employeeIds === undefined ? {} : { employeeIds: body.employeeIds }),
      }),
    );
    return c.json(present(result), 201);
  },
);

payrollPaymentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["hr"],
    request: { params: CompanyParams, query: PayrollPaymentQuery },
    middleware: [requirePermission(read, gate)],
    responses: {
      200: {
        description: "Batches, newest first",
        content: { "application/json": { schema: PayrollPaymentList } },
      },
      400: problem("an unknown or malformed query parameter"),
      403: problem("forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const cursor = moneyOutCursor(q.cursor);
    const rows = await c.var.withTenant((tx) =>
      listMoneyOut(tx, {
        companyId,
        typeCode: "PAYROLL_PAYMENT",
        ...(q["filter[payrollDocumentId][eq]"] === undefined
          ? {}
          : { payrollDocumentId: q["filter[payrollDocumentId][eq]"] }),
        ...(q["filter[status][eq]"] === undefined ? {} : { status: q["filter[status][eq]"] }),
        ...(q["filter[effectiveDate][gte]"] === undefined
          ? {}
          : { from: q["filter[effectiveDate][gte]"] }),
        ...(q["filter[effectiveDate][lte]"] === undefined
          ? {}
          : { to: q["filter[effectiveDate][lte]"] }),
        limit: q.limit + 1,
        cursor,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    const next =
      rows.length > q.limit && last !== undefined
        ? encodeCursor({ k: [last.effectiveDate], id: last.documentId })
        : null;
    return c.json({ items: page.map(present), next_cursor: next }, 200);
  },
);

payrollPaymentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{documentId}",
    tags: ["hr"],
    request: { params: DocumentParams },
    middleware: [requirePermission(read, gate)],
    responses: {
      200: {
        description: "The batch and its lines",
        content: { "application/json": { schema: PayrollPaymentSchema } },
      },
      403: problem("forbidden"),
      404: problem("no such payroll payment in this company"),
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const result = await c.var.withTenant((tx) =>
      readMoneyOut(tx, documentId, { companyId, typeCode: "PAYROLL_PAYMENT" }),
    );
    return c.json(present(result), 200);
  },
);

payrollPaymentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{documentId}/csv",
    tags: ["hr"],
    request: { params: DocumentParams },
    middleware: [requirePermission(read, gate)],
    responses: {
      200: {
        description:
          "The bank-neutral batch file (spec:2083): employee_number, employee_name, bank_account (masked), amount, currency, reference",
        content: { "text/csv": { schema: z.string() } },
      },
      403: problem("forbidden"),
      404: problem("no such payroll payment in this company"),
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const result = await c.var.withTenant((tx) =>
      readMoneyOut(tx, documentId, { companyId, typeCode: "PAYROLL_PAYMENT" }),
    );
    const reference = result.number === null ? result.series : `${result.series}-${result.number}`;
    const csv = payrollBatchCsv(
      result.lines.map((l) => ({
        employeeNumber: l.employeeNumber,
        employeeName: l.employeeName,
        // A CONSTANT MASK, never a read of the real number: the account is `employee_sensitive`, behind 8A's
        // `sensitive_gate` (spec:2076), and this route is gated on hr.payroll.read, not hr.employee.read_sensitive.
        // Whether a verified bank layout needs the digits is OD-28's (Task 13), as a separately gated download.
        bankAccountMasked: "****",
        amount: l.amount.toString(),
        currency: l.amount.currency,
        reference,
      })),
    );
    return c.body(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="payroll-batch-${documentId}.csv"`,
      "cache-control": "private, no-store",
    });
  },
);

/** One module, one `PROBES` key (hazard 31). */
export const payrollPaymentRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/payroll-payments",
  router: payrollPaymentRoutes,
  permissions: [pay, read],
  auth: "human",
};
