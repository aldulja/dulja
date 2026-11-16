import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CostLayerList,
  CostLayerQuery,
  UuidSchema,
  ValuationList,
  ValuationQuery,
  decodeCursor,
  encodeCursor,
} from "@dulja/contracts";
import { openLayersOf, valuationAsOf } from "@dulja/db";
import type { AppEnv } from "../../context";
// `requirePermission` lives in apps/api/src/middleware/require-permission.ts (§4.2.5), NOT in
// @dulja/contracts — that module exports only PERMISSIONS, PERMISSION, PermissionCode and isMutating.
import { requirePermission } from "../../middleware/require-permission";
// Type-only, so nothing circular survives to runtime (the same shape `reportsRouteModule` uses).
import type { RouteModule } from "../index";
import { INVENTORY_PERMISSION } from "./permissions";

/**
 * `/v1/companies/{companyId}/valuation` under `inventory.cost.read` (amendment A8).
 *
 * An ORDINARY LIST module, deliberately NOT a `ReportCode`: `inventory.valuation` in §4.16.1 is 3D's report
 * code on 1B's `reports` module, and the two never collide because they are different modules on different
 * paths. 3D's report will read `valuationAsOf` — the same function these two routes read — rather than
 * re-derive anything, which is what makes LEGACY-009 unrepeatable.
 *
 * Both routes are GETs. Nothing here writes, so no route declares `IdempotencyHeader`.
 */
export const valuationRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

// `ScopeSource` is a closed four-variant union (§4.2.5) and `{ company: "param" }` is not one of them. The
// module mounts at /v1/companies/:companyId/valuation, which is exactly what "path:companyId" reads — and
// the gate clearing a company is what keeps `companyId` below an authorised id rather than a claimed one.
const SCOPE = { company: "path:companyId" } as const;
const gate = () => requirePermission(INVENTORY_PERMISSION.costRead, SCOPE);

const Params = z.object({ companyId: UuidSchema });

valuationRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "Quantity and value per item and warehouse as at a date, derived from the cost layers",
    request: { params: Params, query: ValuationQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: ValuationList } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const itemId = q["filter[item_id][eq]"];
    const warehouseId = q["filter[warehouse_id][eq]"];
    const rows = await c.var.withTenant((tx) =>
      valuationAsOf(tx, {
        companyId,
        asOf: q.asOf,
        // `exactOptionalPropertyTypes` is on, so an absent filter is OMITTED, never passed as undefined.
        ...(itemId === undefined ? {} : { itemId }),
        ...(warehouseId === undefined ? {} : { warehouseId }),
        ...(after === null
          ? {}
          : { cursor: { itemCode: String(after.k[0]), warehouseCode: String(after.k[1]) } }),
        // One more than asked for: the extra row is how "is there a next page?" is answered without a
        // second count query, and it is dropped before the envelope is built.
        limit: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page,
        next_cursor:
          rows.length > q.limit && last
            ? encodeCursor({ k: [last.itemCode, last.warehouseCode], id: last.warehouseId })
            : null,
      },
      200,
    );
  },
);

valuationRoutes.openapi(
  createRoute({
    method: "get",
    path: "/layers",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "The open cost layers of one item, oldest first, with each layer's as-at residue",
    request: { params: Params, query: CostLayerQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: CostLayerList } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const warehouseId = q["filter[warehouse_id][eq]"];
    const rows = await c.var.withTenant((tx) =>
      openLayersOf(tx, {
        companyId,
        itemId: q["filter[item_id][eq]"],
        asOf: q.asOf,
        ...(warehouseId === undefined ? {} : { warehouseId }),
        ...(after === null
          ? {}
          : { cursor: { effectiveAt: String(after.k[0]), sequence: String(after.k[1]) } }),
        limit: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page,
        next_cursor:
          rows.length > q.limit && last
            ? encodeCursor({ k: [last.effectiveAt, last.sequence], id: last.layerId })
            : null,
      },
      200,
    );
  },
);

/** `PROBES` (tests/invariants/probes.ts) is keyed by `RouteModule.path`; `/layers` is a sub-path of this
 *  one and needs no key of its own (hazard 31). */
export const valuationRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/valuation",
  router: valuationRoutes,
  permissions: ["inventory.cost.read"],
  auth: "human",
};
