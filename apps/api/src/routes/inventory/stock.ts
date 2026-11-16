import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  FefoPickList,
  FefoQuery,
  ProblemSchema,
  StockOnHandList,
  StockOnHandQuery,
  UuidSchema,
  decodeCursor,
  encodeCursor,
} from "@dulja/contracts";
import { listStockOnHand, pickLotsFefo } from "@dulja/db";
import { Quantity } from "@dulja/domain";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { INVENTORY_PERMISSION } from "./permissions";

/**
 * `/v1/companies/{companyId}/stock-on-hand` under `inventory.stock.read`.
 *
 * This is an ORDINARY LIST endpoint and deliberately NOT a `ReportCode`: `inventory.stock_on_hand`,
 * `inventory.valuation` and `inventory.sales_by_item` are 3D's minimal report set (§4.16.1, hazard 4), and a
 * slice that seeded a report code here would collide with the slice that owns it.
 *
 * Both routes are GETs. Nothing in this module writes, so no route declares `IdempotencyHeader`.
 */
export const stockRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

const SCOPE = { company: "path:companyId" } as const;
const gate = () => requirePermission(INVENTORY_PERMISSION.stockRead, SCOPE);

const Params = z.object({ companyId: UuidSchema });

type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

/**
 * The company-binding guard AGENTS.md requires of every id a request names. `pickLotsFefo` and
 * `app.pick_lots_fefo` take a bare item and warehouse: RLS bounds the TENANT and nothing else, so without
 * this a principal cleared for company A could read company B's batch positions — quantities, and by their
 * ordering the expiry dates — through the fefo route. 404, not 403: an id the caller may not see must not be
 * confirmed to exist.
 */
async function assertInCompany(
  tx: Tx,
  companyId: string,
  ids: { itemId: string; warehouseId: string },
): Promise<void> {
  const [row] = await tx<{ items: number; warehouses: number }[]>`
    select (select count(*)::int from app.item
             where id = ${ids.itemId} and company_id = ${companyId})      as items,
           (select count(*)::int from app.warehouse
             where id = ${ids.warehouseId} and company_id = ${companyId}) as warehouses`;
  if (!row || row.items === 0) {
    throw new AppError("ERR_NOT_FOUND", `no item ${ids.itemId} in company ${companyId}`);
  }
  if (row.warehouses === 0) {
    throw new AppError("ERR_NOT_FOUND", `no warehouse ${ids.warehouseId} in company ${companyId}`);
  }
}

stockRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "List stock per item, warehouse and lot, keyset-paged on the three natural codes",
    request: { params: Params, query: StockOnHandQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: StockOnHandList } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const itemId = q["filter[itemId][eq]"];
    const warehouseId = q["filter[warehouseId][eq]"];
    const lotId = q["filter[lotId][eq]"];
    const rows = await c.var.withTenant((tx) =>
      listStockOnHand(tx, {
        companyId,
        nonZeroOnly: q.nonZeroOnly,
        // `exactOptionalPropertyTypes` is on, so an absent filter is OMITTED, never passed as undefined.
        ...(itemId === undefined ? {} : { itemId }),
        ...(warehouseId === undefined ? {} : { warehouseId }),
        ...(lotId === undefined ? {} : { lotId }),
        ...(after === null
          ? {}
          : {
              cursor: {
                itemCode: String(after.k[0]),
                warehouseCode: String(after.k[1]),
                lotCode: String(after.k[2]),
              },
            }),
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
            ? // The keyset is the three natural codes; `id` carries the lot, because `app.stock_on_hand` has
              // no `id` column at all — its natural key IS its key (migration 0031).
              encodeCursor({
                k: [last.itemCode, last.warehouseCode, last.lotCode],
                id: last.lotId,
              })
            : null,
      },
      200,
    );
  },
);

/**
 * First-expired-first-out picking over the synchronous projection (ADR 0036). A GET: it reads, it writes
 * nothing, and a partial pick is a legitimate answer — refusing an under-supplied warehouse is
 * `assert_stock_available`'s job inside the posting transaction, not this read's.
 */
stockRoutes.openapi(
  createRoute({
    method: "get",
    path: "/fefo",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "Pick lots first-expired-first-out for an item, warehouse and quantity",
    request: { params: Params, query: FefoQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: FefoPickList } } },
      404: {
        description: "Unknown item or warehouse",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const picks = await c.var.withTenant(async (tx) => {
      await assertInCompany(tx, companyId, { itemId: q.itemId, warehouseId: q.warehouseId });
      return pickLotsFefo(tx, {
        itemId: q.itemId,
        warehouseId: q.warehouseId,
        quantity: Quantity.of(q.quantity),
      });
    });
    return c.json(
      { items: picks.map((p) => ({ lotId: p.lotId, quantity: p.quantity.toString() })) },
      200,
    );
  },
);
