import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  BranchPosPolicyList,
  BranchPosPolicyQuery,
  BranchPosPolicySchema,
  UpsertBranchPosPolicyBody,
} from "@dulja/contracts/pos/branch-pos-policy";
import { ProblemSchema, encodeCursor, decodeCursor } from "@dulja/contracts";
import { listBranchPosPolicies, upsertBranchPosPolicy } from "@dulja/db";
import { AppError } from "@dulja/contracts";
import type { AppEnv } from "../../context";
import type { RouteModule } from "../index";
import { IdempotencyHeader } from "../idempotency-header";
import { staffBranchGate, assertStaffBranchPermission } from "../staff-permission";

export const branchPosPolicyRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const Params = z.object({ companyId: z.string().uuid() });

branchPosPolicyRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["pos"],
    request: { params: Params, query: BranchPosPolicyQuery },
    middleware: [staffBranchGate(PERMISSION["admin.company.manage"])],
    responses: {
      200: {
        description: "branch POS policies",
        content: { "application/json": { schema: BranchPosPolicyList } },
      },
      403: {
        description: "forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (cursor && (cursor.k.length !== 0 || !z.string().uuid().safeParse(cursor.id).success))
      throw new AppError("ERR_VALIDATION_FAILED", "cursor is not valid");
    const { rows, nextCursor } = await c.var.withTenant((tx) =>
      listBranchPosPolicies(tx, companyId, {
        limit: q.limit,
        ...(cursor ? { cursor } : {}),
        ...(q["filter[branchId][eq]"] ? { branchId: q["filter[branchId][eq]"] } : {}),
      }),
    );
    return c.json(
      {
        items: rows.map((row) => BranchPosPolicySchema.parse(row)),
        next_cursor: nextCursor ? encodeCursor({ k: [], id: nextCursor }) : null,
      },
      200,
    );
  },
);

branchPosPolicyRoutes.openapi(
  createRoute({
    method: "put",
    path: "/",
    tags: ["pos"],
    request: {
      params: Params,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpsertBranchPosPolicyBody } } },
    },
    middleware: [staffBranchGate(PERMISSION["admin.company.manage"])],
    responses: {
      200: {
        description: "the policy for this branch",
        content: { "application/json": { schema: BranchPosPolicySchema } },
      },
      403: {
        description: "forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "no such branch",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      // Validate the company-bound branch before changing its policy.
      const [branch] =
        await tx`select 1 from app.dimension_value v join app.dimension_type t on t.id=v.dimension_type_id and t.tenant_id=v.tenant_id where v.id=${body.branchId} and t.company_id=${companyId} and t.code='BRANCH'`;
      if (!branch) throw new AppError("ERR_NOT_FOUND", `branch ${body.branchId} is not visible`);
      await assertStaffBranchPermission(
        tx,
        PERMISSION["admin.company.manage"],
        companyId,
        body.branchId,
      );
      return upsertBranchPosPolicy(tx, companyId, {
        branchId: body.branchId,
        ...(body.maxLineDiscountPct === undefined
          ? {}
          : { maxLineDiscountPct: body.maxLineDiscountPct }),
        ...(body.maxTicketDiscountPct === undefined
          ? {}
          : { maxTicketDiscountPct: body.maxTicketDiscountPct }),
        ...(body.maxVoidAmount === undefined ? {} : { maxVoidAmount: body.maxVoidAmount }),
        ...(body.maxPriceOverridePct === undefined
          ? {}
          : { maxPriceOverridePct: body.maxPriceOverridePct }),
        ...(body.blindReturnAllowed === undefined
          ? {}
          : { blindReturnAllowed: body.blindReturnAllowed }),
        ...(body.maxBlindReturnAmount === undefined
          ? {}
          : { maxBlindReturnAmount: body.maxBlindReturnAmount }),
        ...(body.maxCashInDrawer === undefined ? {} : { maxCashInDrawer: body.maxCashInDrawer }),
        ...(body.requireCustomerOver === undefined
          ? {}
          : { requireCustomerOver: body.requireCustomerOver }),
        ...(body.roundingIncrement === undefined
          ? {}
          : { roundingIncrement: body.roundingIncrement }),
        ...(body.paidOutAllowed === undefined ? {} : { paidOutAllowed: body.paidOutAllowed }),
        ...(body.maxPaidOutAmount === undefined ? {} : { maxPaidOutAmount: body.maxPaidOutAmount }),
      });
    });
    return c.json(BranchPosPolicySchema.parse(row), 200);
  },
);

export const branchPosPolicyRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/branch-pos-policies",
  router: branchPosPolicyRoutes,
  permissions: [PERMISSION["admin.company.manage"]],
  auth: "human",
};
