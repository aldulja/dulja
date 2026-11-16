import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CreateUnitBody,
  decodeCursor,
  encodeCursor,
  ProblemSchema,
  UnitList,
  UnitQuery,
  UnitSchema,
  UuidSchema,
} from "@dulja/contracts";
import { createUnit, listUnits } from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import { INVENTORY_PERMISSION } from "./permissions";

/**
 * `/v1/companies/{companyId}/units` — units of measure, read under `inventory.item.read` and maintained
 * under `inventory.item.manage`. There is no separate warehouse or unit code: §3.6.1 closes the permission
 * vocabulary at five inventory codes for 3A and spec:2159/2160 give neither `warehouse` nor `branch_manager`
 * any catalogue authority (assumption 11).
 *
 * There is deliberately no archive route and no DELETE route. `app.unit_of_measure` has no `archived_at`
 * column (§4.6.1) and this slice adds no `app_rw` DELETE grant (§3.5.4), so a unit, once created, stands —
 * which is right: a conversion is a physical fact about a package, and every stored quantity names a unit.
 */
export const unitRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

const PAGE = { company: "path:companyId" } as const;

unitRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["inventory"],
    middleware: [requirePermission(INVENTORY_PERMISSION.itemRead, PAGE)] as const,
    summary: "List units of measure, keyset-paged on code",
    request: { params: z.object({ companyId: UuidSchema }), query: UnitQuery },
    responses: {
      200: { description: "Units", content: { "application/json": { schema: UnitList } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await c.var.withTenant((tx) =>
      listUnits(tx, {
        companyId,
        cursor: after ? { code: String(after.k[0]) } : null,
        limit: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page,
        next_cursor:
          rows.length > q.limit && last ? encodeCursor({ k: [last.code], id: last.id }) : null,
      },
      200,
    );
  },
);

unitRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["inventory"],
    middleware: [requirePermission(INVENTORY_PERMISSION.itemManage, PAGE)] as const,
    summary: "Create a unit of measure",
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateUnitBody } } },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: UnitSchema } } },
      409: {
        description: "Duplicate code",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const b = c.req.valid("json");
    // `exactOptionalPropertyTypes` is on: an absent optional is omitted, never passed as `undefined`.
    const row = await c.var.withTenant((tx) =>
      createUnit(tx, {
        companyId,
        code: b.code,
        nameEn: b.nameEn,
        ...(b.nameAr === undefined ? {} : { nameAr: b.nameAr }),
      }),
    );
    return c.json(row, 201);
  },
);
