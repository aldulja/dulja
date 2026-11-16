import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, encodeCursor, ProblemSchema } from "@dulja/contracts";
import {
  CreateEmployeeAdvanceBody,
  EmployeeAdvanceBalanceQuery,
  EmployeeAdvanceBalanceSchema,
  EmployeeAdvanceList,
  EmployeeAdvanceQuery,
  EmployeeAdvanceSchema,
} from "@dulja/contracts/hr/employee-advance";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  advanceBalance,
  createEmployeeAdvance,
  listMoneyOut,
  readMoneyOut,
  type MoneyOutResult,
} from "@dulja/db";
import { Money } from "@dulja/domain";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";
import { moneyOutCursor } from "./payroll-payments";

const CompanyParams = z.object({ companyId: z.string().uuid() });
const DocumentParams = CompanyParams.extend({ documentId: z.string().uuid() });
const EmployeeParams = CompanyParams.extend({ employeeId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;
const create = PERMISSION["hr.advance.create"],
  read = PERMISSION["hr.payroll.read"];
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/**
 * 8C T6 — the employee-advance module (§4.2.7, round 18 B10, spec:2082). Draft an advance under `hr.advance.create`,
 * list, read, and the outstanding balance — a LEDGER projection over `1400` tagged EMPLOYEE, never a loan ledger.
 * Submit, approve and post go through 2B's generic transitions route (`accounting.payment.approve` / `.post`).
 */
export const employeeAdvanceRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

/** An advance has exactly one line, by construction: `createEmployeeAdvance` drafts one. `document.notes` is
 *  `advance:<reason>`. */
const present = (r: MoneyOutResult): z.infer<typeof EmployeeAdvanceSchema> => {
  const line = r.lines[0];
  if (line === undefined || r.lines.length !== 1) {
    throw new AppError(
      "ERR_INTERNAL",
      `employee advance ${r.documentId} has ${r.lines.length} lines, not one`,
    );
  }
  return {
    documentId: r.documentId,
    series: r.series,
    number: r.number,
    status: r.status,
    effectiveDate: r.effectiveDate,
    branchId: r.branchId,
    employeeId: line.employeeId,
    employeeNumber: line.employeeNumber,
    employeeName: line.employeeName,
    amount: line.amount.toJSON(),
    reason: r.notes?.startsWith("advance:") === true ? r.notes.slice("advance:".length) : "",
  };
};

employeeAdvanceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["hr"],
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateEmployeeAdvanceBody } } },
    },
    middleware: [requirePermission(create, gate)],
    responses: {
      201: {
        description:
          "The DRAFT advance. Submit, approve and post it through …/documents/{documentId}/transitions",
        content: { "application/json": { schema: EmployeeAdvanceSchema } },
      },
      400: problem(
        "an invalid body, a non-positive amount, or a currency other than the company's base currency",
      ),
      403: problem("forbidden"),
      404: problem("no such active employee in this company"),
      422: problem("the EMPLOYEE_ADVANCE type is not configured for the company"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    // The service refuses a currency other than the company's base currency (422) — it reads the company.
    const result = await c.var.withTenant((tx) =>
      createEmployeeAdvance(tx, c.var.ctx, {
        companyId,
        employeeId: body.employeeId,
        effectiveDate: body.effectiveDate,
        branchId: body.branchId,
        amount: Money.fromJSON(body.amount),
        reason: body.reason,
      }),
    );
    return c.json(present(result), 201);
  },
);

employeeAdvanceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["hr"],
    request: { params: CompanyParams, query: EmployeeAdvanceQuery },
    middleware: [requirePermission(read, gate)],
    responses: {
      200: {
        description: "Advances, newest first",
        content: { "application/json": { schema: EmployeeAdvanceList } },
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
        typeCode: "EMPLOYEE_ADVANCE",
        ...(q["filter[employeeId][eq]"] === undefined
          ? {}
          : { employeeId: q["filter[employeeId][eq]"] }),
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

employeeAdvanceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{documentId}",
    tags: ["hr"],
    request: { params: DocumentParams },
    middleware: [requirePermission(read, gate)],
    responses: {
      200: {
        description: "The advance",
        content: { "application/json": { schema: EmployeeAdvanceSchema } },
      },
      403: problem("forbidden"),
      404: problem("no such employee advance in this company"),
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const result = await c.var.withTenant((tx) =>
      readMoneyOut(tx, documentId, { companyId, typeCode: "EMPLOYEE_ADVANCE" }),
    );
    return c.json(present(result), 200);
  },
);

employeeAdvanceRoutes.openapi(
  createRoute({
    method: "get",
    // `/balances/{employeeId}` and NOT `/{employeeId}/balance`: a document id and an employee id are the same shape,
    // and `/{documentId}` would otherwise shadow one of the two.
    path: "/balances/{employeeId}",
    tags: ["hr"],
    request: { params: EmployeeParams, query: EmployeeAdvanceBalanceQuery },
    middleware: [requirePermission(read, gate)],
    responses: {
      200: {
        description:
          "The outstanding advance balance as of `asOf`: 1400 tagged with the employee, from the ledger (spec:2082)",
        content: { "application/json": { schema: EmployeeAdvanceBalanceSchema } },
      },
      400: problem("asOf is missing or not a calendar date"),
      403: problem("forbidden"),
      404: problem("no such employee in this company"),
    },
  }),
  async (c) => {
    const { companyId, employeeId } = c.req.valid("param");
    const { asOf } = c.req.valid("query");
    const balance = await c.var.withTenant((tx) =>
      advanceBalance(tx, { companyId, employeeId, asOf }),
    );
    return c.json({ employeeId, asOf, balance: balance.toJSON() }, 200);
  },
);

/** One module, one `PROBES` key (hazard 31). */
export const employeeAdvanceRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/employee-advances",
  router: employeeAdvanceRoutes,
  permissions: [create, read],
  auth: "human",
};
