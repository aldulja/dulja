import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import {
  CompensationLineSchema,
  CompensationList,
  CompensationQuery,
  OpenCompensationBody,
} from "@dulja/contracts/hr/compensation";
import { PERMISSION } from "@dulja/contracts/permissions";
import { Money, Quantity, currency } from "@dulja/domain";
import {
  compensationOn,
  listCompensation,
  openCompensation,
  type CompensationLine,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import { requireEmployeeInCompany } from "./employee-scope";

const Params = z.object({ companyId: z.string().uuid(), employeeId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

const toDto = (l: CompensationLine) => ({
  id: l.id,
  employeeId: l.employeeId,
  componentId: l.componentId,
  effectiveFrom: l.effectiveFrom,
  effectiveTo: l.effectiveTo,
  amount: l.amount === null ? null : l.amount.toJSON(),
  quantity: l.quantity === null ? null : l.quantity.toJSON(),
  enteredBy: l.enteredBy,
});

/** 8A T7 — two sub-paths composed onto 6C's employees module (A16); they inherit its PROBES key (hazard 31). */
export const compensationRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

compensationRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{employeeId}/compensation-lines",
    tags: ["hr"],
    request: { params: Params, query: CompensationQuery },
    middleware: [requirePermission(PERMISSION["hr.compensation.read"], gate)],
    responses: {
      200: {
        description: "Newest first",
        content: { "application/json": { schema: CompensationList } },
      },
      403: problem("forbidden"),
      404: problem("no such employee in this company"),
    },
  }),
  async (c) => {
    const { companyId, employeeId } = c.req.valid("param");
    const q = c.req.valid("query");
    const on = q["filter[effectiveOn][eq]"];
    const componentId = q["filter[componentId][eq]"];
    const rows = await c.var.withTenant(async (tx) => {
      await requireEmployeeInCompany(tx, companyId, employeeId);
      return on === undefined
        ? listCompensation(tx, employeeId)
        : compensationOn(tx, employeeId, on);
    });
    const items = rows
      .filter((r) => componentId === undefined || r.componentId === componentId)
      .map(toDto);
    return c.json({ items, next_cursor: null }, 200);
  },
);

compensationRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{employeeId}/compensation-lines",
    tags: ["hr"],
    request: {
      params: Params,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: OpenCompensationBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.compensation.manage"], gate)],
    responses: {
      201: {
        description: "Opened; the previous line of the same component is closed",
        content: { "application/json": { schema: CompensationLineSchema } },
      },
      400: problem("invalid body, or an archived pay component"),
      403: problem("forbidden"),
      404: problem("no such employee or pay component in this company"),
      409: problem("a principal may not write their own compensation (R4), or the date collides"),
      422: problem("the amount is not in the company's base currency"),
    },
  }),
  async (c) => {
    const { companyId, employeeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      await requireEmployeeInCompany(tx, companyId, employeeId);
      const [scope] = await tx<{ base_currency: string; archived: boolean | null }[]>`
        select co.base_currency,
               (select pc.archived_at is not null from app.pay_component pc
                 where pc.id = ${body.componentId}::uuid and pc.company_id = co.id) as archived
          from app.company co where co.id = ${companyId}::uuid`;
      if (scope === undefined || scope.archived === null)
        throw new AppError(
          "ERR_NOT_FOUND",
          `pay component ${body.componentId} was not found in this company`,
        );
      if (scope.archived)
        throw new AppError(
          "ERR_VALIDATION_FAILED",
          `pay component ${body.componentId} is archived; open the line on its replacement`,
        );
      if (body.amount !== undefined && body.amount.currency !== scope.base_currency)
        throw new AppError(
          "ERR_MONEY_CURRENCY_MISMATCH",
          `compensation is entered in the company's base currency ${scope.base_currency}; ${body.amount.currency} was supplied (v1 payroll is single-currency, spec:2093)`,
        );
      const id = await openCompensation(tx, {
        employeeId,
        componentId: body.componentId,
        effectiveFrom: body.effectiveFrom,
        amount:
          body.amount === undefined
            ? null
            : Money.of(body.amount.amount, currency(body.amount.currency)),
        quantity: body.quantity === undefined ? null : Quantity.of(body.quantity),
      });
      const rows = await listCompensation(tx, employeeId);
      return toDto(rows.find((r) => r.id === id)!);
    });
    return c.json(dto, 201);
  },
);
