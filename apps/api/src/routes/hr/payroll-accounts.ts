import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema, UuidSchema } from "@dulja/contracts";
import {
  LinkPayrollAccountsBody,
  PayrollAccountLinkageSchema,
} from "@dulja/contracts/hr/pay-component";
import { PERMISSION } from "@dulja/contracts/permissions";
import { linkPayrollAccounts } from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import type { RouteModule } from "../index";
import { IdempotencyHeader } from "../idempotency-header";

/**
 * ADR 0097 (full review PRD-08): `POST /v1/companies/{companyId}/payroll-accounts` — the route form of
 * `bun run --cwd packages/db seed:payroll-accounts`, so payroll does not wait on an engineer. It runs the same
 * `linkPayrollAccounts` under `hr.pay_component.manage`, the code that already writes a component's accounts
 * (`PATCH …/pay-components/{id}`, `…/schemes`). Two differences from the CLI, both on purpose: it acts as the
 * caller, not the system principal (a person asked for it, and the audit row says who); and a missing account code
 * is a 422 that rolls the whole wiring back, so a company is never left half-linked.
 */
export const payrollAccountRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const manage = PERMISSION["hr.pay_component.manage"];

payrollAccountRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["hr"],
    summary:
      "Link the company's pay components and statutory schemes to its payroll accounts (idempotent)",
    middleware: [requirePermission(manage, { company: "path:companyId" })] as const,
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: LinkPayrollAccountsBody } } },
    },
    responses: {
      200: {
        description: "What was linked",
        content: { "application/json": { schema: PayrollAccountLinkageSchema } },
      },
      403: {
        description: "forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description: "The chart lacks a payroll account code; nothing was linked",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const result = await c.var.withTenant(async (tx) => {
      const linkage = await linkPayrollAccounts(tx, companyId);
      if (linkage.missingCodes.length > 0) {
        throw new AppError(
          "ERR_POLICY_REQUIRES_MISSING",
          `the company's chart has no payroll account ${linkage.missingCodes.join(", ")}; ` +
            "create it (POST /v1/companies/{companyId}/accounts) and link the payroll accounts again",
        );
      }
      return linkage;
    });
    return c.json(result, 200);
  },
);

export const payrollAccountRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/payroll-accounts",
  router: payrollAccountRoutes,
  permissions: [manage],
  auth: "human",
};
