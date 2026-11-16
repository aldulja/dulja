import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  CreateItemBody,
  CreateLotBody,
  decodeCursor,
  encodeCursor,
  ItemList,
  ItemQuery,
  ItemSchema,
  LotList,
  LotQuery,
  LotSchema,
  ProblemSchema,
  ReplaceUnitConversionsBody,
  UnitConversionList,
  UpdateItemBody,
  UuidSchema,
} from "@dulja/contracts";
import {
  archiveItem,
  createItem,
  createLot,
  getItem,
  listItems,
  listLots,
  listUnitConversions,
  replaceUnitConversions,
  updateItem,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import { INVENTORY_PERMISSION } from "./permissions";

/**
 * `/v1/companies/{companyId}/items` — the item master, its unit conversions and its lots. Every read is
 * `inventory.item.read`; every write is `inventory.item.manage` (§3.6.2, assumption 11: head office owns
 * the catalogue, and spec:2159/2160 give neither `warehouse` nor `branch_manager` any authority over it).
 *
 * `GET /{itemId}` carries the read CODE rather than `membershipOnly()`: §4.2.7's membership-only precedent
 * exists for reads the catalogue has no code for (the chart of accounts, dimension values). Here there is
 * one, so the gate uses it.
 *
 * There is no DELETE route anywhere below. Master data is archived (spec:2049), `POST …/{id}/archive` is
 * the whole vocabulary, and this slice adds no `app_rw` DELETE grant (§3.5.4's list is pinned).
 */
export const itemRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

const PAGE = { company: "path:companyId" } as const;
const readGate = () => requirePermission(INVENTORY_PERMISSION.itemRead, PAGE);
const manageGate = () => requirePermission(INVENTORY_PERMISSION.itemManage, PAGE);

type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/**
 * AGENTS.md's Always list, and a real finding of the Phase 2 review pass: "RLS bounds the tenant and nothing
 * else, so an endpoint whose gate clears a company must pass that company down into every service call it
 * makes; an entity id alone lets a caller authorised for one company reach another's rows inside the same
 * tenant." `getItem`, `updateItem`, `archiveItem`, `listUnitConversions` and `replaceUnitConversions` all
 * take an item id alone, so every route that names one in its path binds it here first. 404 rather than 403:
 * an id the caller may not see is not confirmed to exist (0B's precedent on `GET /v1/companies/{id}`).
 */
async function assertItemBelongs(tx: Tx, companyId: string, itemId: string): Promise<void> {
  const item = await getItem(tx, itemId);
  if (!item || item.companyId !== companyId) {
    throw new AppError("ERR_NOT_FOUND", `no item ${itemId} in company ${companyId}`);
  }
}

/**
 * `item.base_unit_id` and `unit_conversion.unit_id` are both `(tenant_id, unit_id)` composite keys (0028) —
 * tenant-composite only — so the schema admits a unit of a SIBLING company, and every quantity stored under
 * that item would then be expressed in a unit this company's screens cannot name. The same shape as
 * `assertBranchBelongs` in the documents module.
 */
async function assertUnitsBelong(
  tx: Tx,
  companyId: string,
  unitIds: readonly string[],
): Promise<void> {
  const wanted = [...new Set(unitIds)];
  if (wanted.length === 0) return;
  const rows = await tx<{ id: string }[]>`
    select id from app.unit_of_measure
     where company_id = ${companyId} and id = any(${wanted}::uuid[])`;
  const known = new Set(rows.map((r) => r.id));
  for (const id of wanted) {
    if (!known.has(id)) {
      throw new AppError("ERR_NOT_FOUND", `no unit ${id} in company ${companyId}`);
    }
  }
}

itemRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["inventory"],
    middleware: [readGate()] as const,
    summary: "List items, keyset-paged on code",
    request: { params: z.object({ companyId: UuidSchema }), query: ItemQuery },
    responses: {
      200: { description: "Items", content: { "application/json": { schema: ItemList } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    // `limit + 1` then `slice(0, limit)`: the extra row is how the handler knows whether a further page
    // exists without emitting a cursor that leads to an empty one.
    const rows = await c.var.withTenant((tx) =>
      listItems(tx, {
        companyId,
        ...(q["filter[kind][eq]"] === undefined ? {} : { kind: q["filter[kind][eq]"] }),
        ...(q["filter[code][eq]"] === undefined ? {} : { code: q["filter[code][eq]"] }),
        ...(q["filter[barcode][eq]"] === undefined ? {} : { barcode: q["filter[barcode][eq]"] }),
        includeArchived: q.includeArchived === "true",
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

itemRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["inventory"],
    middleware: [manageGate()] as const,
    summary: "Create an item; its four account defaults are resolved, never supplied",
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateItemBody } } },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: ItemSchema } } },
      409: problem("Duplicate code"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const b = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      await assertUnitsBelong(tx, companyId, [b.baseUnitId]);
      // `exactOptionalPropertyTypes` is on: an absent optional is omitted, never passed as `undefined`.
      return createItem(tx, c.var.ctx, {
        companyId,
        code: b.code,
        nameEn: b.nameEn,
        kind: b.kind,
        baseUnitId: b.baseUnitId,
        ...(b.nameAr === undefined ? {} : { nameAr: b.nameAr }),
        ...(b.barcode === undefined ? {} : { barcode: b.barcode }),
        ...(b.taxCodeId === undefined ? {} : { taxCodeId: b.taxCodeId }),
        ...(b.trackLots === undefined ? {} : { trackLots: b.trackLots }),
        ...(b.shelfLifeDays === undefined ? {} : { shelfLifeDays: b.shelfLifeDays }),
      });
    });
    return c.json(row, 201);
  },
);

itemRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{itemId}",
    tags: ["inventory"],
    middleware: [readGate()] as const,
    summary: "Read one item",
    request: { params: z.object({ companyId: UuidSchema, itemId: UuidSchema }) },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: ItemSchema } } },
      404: problem("Unknown"),
    },
  }),
  async (c) => {
    const { companyId, itemId } = c.req.valid("param");
    const row = await c.var.withTenant((tx) => getItem(tx, itemId));
    if (!row || row.companyId !== companyId) {
      throw new AppError("ERR_NOT_FOUND", `no item ${itemId} in company ${companyId}`);
    }
    return c.json(row, 200);
  },
);

itemRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{itemId}",
    tags: ["inventory"],
    middleware: [manageGate()] as const,
    summary:
      "Edit an item's names, barcode, lot tracking or shelf life — never its code, kind or unit",
    request: {
      params: z.object({ companyId: UuidSchema, itemId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdateItemBody } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: ItemSchema } } },
      404: problem("Unknown"),
    },
  }),
  async (c) => {
    const { companyId, itemId } = c.req.valid("param");
    const b = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      await assertItemBelongs(tx, companyId, itemId);
      return updateItem(tx, itemId, {
        ...(b.nameEn === undefined ? {} : { nameEn: b.nameEn }),
        ...(b.nameAr === undefined ? {} : { nameAr: b.nameAr }),
        ...(b.barcode === undefined ? {} : { barcode: b.barcode }),
        ...(b.taxCodeId === undefined ? {} : { taxCodeId: b.taxCodeId }),
        ...(b.trackLots === undefined ? {} : { trackLots: b.trackLots }),
        ...(b.shelfLifeDays === undefined ? {} : { shelfLifeDays: b.shelfLifeDays }),
      });
    });
    if (row === null)
      throw new AppError("ERR_NOT_FOUND", `no item ${itemId} in company ${companyId}`);
    return c.json(row, 200);
  },
);

/**
 * Archive is a POST, never a DELETE (spec:2049). 404 rather than 409 on an already-archived row is NOT what
 * happens here: `archiveItem` is `coalesce(archived_at, now())`, so a replay returns the row it archived the
 * first time — which is what an idempotent archive should do.
 */
itemRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{itemId}/archive",
    tags: ["inventory"],
    middleware: [manageGate()] as const,
    summary: "Archive an item",
    request: {
      params: z.object({ companyId: UuidSchema, itemId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: z.object({}).strict() } } },
    },
    responses: {
      200: { description: "Archived", content: { "application/json": { schema: ItemSchema } } },
      404: problem("Unknown"),
    },
  }),
  async (c) => {
    const { companyId, itemId } = c.req.valid("param");
    const row = await c.var.withTenant(async (tx) => {
      await assertItemBelongs(tx, companyId, itemId);
      return archiveItem(tx, itemId);
    });
    if (row === null)
      throw new AppError("ERR_NOT_FOUND", `no item ${itemId} in company ${companyId}`);
    return c.json(row, 200);
  },
);

itemRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{itemId}/unit-conversions",
    tags: ["inventory"],
    middleware: [readGate()] as const,
    summary: "The item's unit conversions",
    request: { params: z.object({ companyId: UuidSchema, itemId: UuidSchema }) },
    responses: {
      200: {
        description: "Conversions",
        content: { "application/json": { schema: UnitConversionList } },
      },
      404: problem("Unknown"),
    },
  }),
  async (c) => {
    const { companyId, itemId } = c.req.valid("param");
    const rows = await c.var.withTenant(async (tx) => {
      await assertItemBelongs(tx, companyId, itemId);
      return listUnitConversions(tx, itemId);
    });
    return c.json({ items: rows, next_cursor: null }, 200);
  },
);

/**
 * A replace, so the body is the complete set (1A's `PUT …/documents/{id}/lines` precedent). The response is
 * the SURVIVING set rather than an echo of the request: `replaceUnitConversions` leaves an omitted pair
 * standing — `app_rw` holds no DELETE on `app.unit_conversion` (§3.5.4) — and echoing the request would hide
 * that from the caller.
 */
itemRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{itemId}/unit-conversions",
    tags: ["inventory"],
    middleware: [manageGate()] as const,
    summary: "Replace the item's unit conversions",
    request: {
      params: z.object({ companyId: UuidSchema, itemId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: ReplaceUnitConversionsBody } } },
    },
    responses: {
      200: {
        description: "Conversions",
        content: { "application/json": { schema: UnitConversionList } },
      },
      404: problem("Unknown item or unit"),
    },
  }),
  async (c) => {
    const { companyId, itemId } = c.req.valid("param");
    const { conversions } = c.req.valid("json");
    const rows = await c.var.withTenant(async (tx) => {
      await assertItemBelongs(tx, companyId, itemId);
      await assertUnitsBelong(
        tx,
        companyId,
        conversions.map((pair) => pair.unitId),
      );
      return replaceUnitConversions(tx, itemId, conversions);
    });
    return c.json({ items: rows, next_cursor: null }, 200);
  },
);

itemRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{itemId}/lots",
    tags: ["inventory"],
    middleware: [readGate()] as const,
    summary: "The item's lots, keyset-paged on code",
    request: {
      params: z.object({ companyId: UuidSchema, itemId: UuidSchema }),
      query: LotQuery,
    },
    responses: {
      200: { description: "Lots", content: { "application/json": { schema: LotList } } },
      404: problem("Unknown"),
    },
  }),
  async (c) => {
    const { companyId, itemId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const expiring = q["filter[expiresBefore][lte]"];
    const rows = await c.var.withTenant(async (tx) => {
      await assertItemBelongs(tx, companyId, itemId);
      return listLots(tx, {
        companyId,
        itemId,
        ...(expiring === undefined ? {} : { expiringBefore: expiring }),
        includeArchived: q.includeArchived === "true",
        cursor: after ? { code: String(after.k[0]) } : null,
        limit: q.limit + 1,
      });
    });
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

itemRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{itemId}/lots",
    tags: ["inventory"],
    middleware: [manageGate()] as const,
    summary: "Create a lot of this item",
    request: {
      params: z.object({ companyId: UuidSchema, itemId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateLotBody } } },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: LotSchema } } },
      404: problem("Unknown"),
      409: problem("Duplicate code"),
    },
  }),
  async (c) => {
    const { companyId, itemId } = c.req.valid("param");
    const b = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      await assertItemBelongs(tx, companyId, itemId);
      return createLot(tx, {
        companyId,
        itemId,
        code: b.code,
        ...(b.expiresOn === undefined ? {} : { expiresOn: b.expiresOn }),
        ...(b.manufacturedOn === undefined ? {} : { manufacturedOn: b.manufacturedOn }),
      });
    });
    return c.json(row, 201);
  },
);
