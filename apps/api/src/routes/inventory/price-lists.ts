import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  CreatePriceListBody,
  PriceListLineList,
  PriceListList,
  PriceListQuery,
  PriceListSchema,
  PriceQuerySchema,
  ProblemSchema,
  ReplacePriceListLinesBody,
  ResolvedPriceEnvelope,
  UpdatePriceListBody,
  UuidSchema,
  decodeCursor,
  encodeCursor,
} from "@dulja/contracts";
import {
  archivePriceList,
  createPriceList,
  getPriceList,
  listPriceListLines,
  listPriceLists,
  replacePriceListLines,
  resolvePrice,
  updatePriceList,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import { INVENTORY_PERMISSION } from "./permissions";

/**
 * `/v1/companies/{companyId}/price-lists` under `inventory.price.manage` (contracts §3.6.2). A price list is
 * master data: created, edited, ARCHIVED, never deleted (spec:2049), so there is no DELETE route anywhere in
 * this module and this slice adds no `app_rw` DELETE grant.
 */
export const priceListRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

const SCOPE = { company: "path:companyId" } as const;
const gate = () => requirePermission(INVENTORY_PERMISSION.priceManage, SCOPE);

type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

/**
 * The company-binding guard AGENTS.md requires of every id in a path. `getPriceList`, `updatePriceList`,
 * `archivePriceList`, `listPriceListLines` and `replacePriceListLines` (Task 4) take a bare `priceListId`:
 * RLS bounds the TENANT and nothing else, so without this a principal cleared for company A could read and
 * rewrite company B's lists inside the same tenant. 404, not 403 — an id the caller may not see must not be
 * confirmed to exist (the leak 0B removed from `GET /v1/companies/{companyId}`).
 */
async function priceListInCompany(tx: Tx, companyId: string, priceListId: string): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.price_list where id = ${priceListId} and company_id = ${companyId}`;
  if (!row)
    throw new AppError("ERR_NOT_FOUND", `no price list ${priceListId} in company ${companyId}`);
}

/** 2026-11-15 review, API-15 / INV-14: `price_list.branch_id`'s key is `(tenant_id, branch_id) →
 *  app.dimension_value` (0030) — tenant-composite only — so a sibling company's branch, or a value of a
 *  dimension that is not BRANCH, would be accepted and the list would then match no branch user (Form B's
 *  `actor_in_branch`). The same check the warehouse route makes. 404: another company's row is not
 *  confirmed to exist. */
async function assertBranchBelongs(tx: Tx, companyId: string, branchId: string): Promise<void> {
  const [branch] = await tx<{ id: string }[]>`
    select v.id
      from app.dimension_value v
      join app.dimension_type t on t.id = v.dimension_type_id
     where v.id = ${branchId} and t.company_id = ${companyId} and t.code = 'BRANCH'
       and v.archived_at is null`;
  if (!branch) throw new AppError("ERR_NOT_FOUND", `no branch ${branchId} in company ${companyId}`);
}

/** API-15: `price_list_line`'s item and unit keys are tenant-composite only (0030), and `replacePriceListLines`
 *  writes the ids as given, so each is bound to the PATH company — or company A's list would carry company
 *  B's items to A's tills (`sync/catalogue.ts`). Company only, not liveness: a list may keep a line for an
 *  item archived since, and a full-set replace must be able to resend it. */
async function assertLinesBelong(
  tx: Tx,
  companyId: string,
  lines: readonly { itemId: string; unitId?: string | null | undefined }[],
): Promise<void> {
  const itemIds = [...new Set(lines.map((line) => line.itemId))];
  const unitIds = [
    ...new Set(lines.flatMap((line) => (typeof line.unitId === "string" ? [line.unitId] : []))),
  ];
  const items = new Set(
    (
      await tx<{ id: string }[]>`
        select id from app.item where company_id = ${companyId} and id = any(${itemIds}::uuid[])`
    ).map((row) => row.id),
  );
  const units = new Set(
    (
      await tx<{ id: string }[]>`
        select id from app.unit_of_measure
         where company_id = ${companyId} and id = any(${unitIds}::uuid[])`
    ).map((row) => row.id),
  );
  for (const line of lines) {
    if (!items.has(line.itemId)) {
      throw new AppError("ERR_NOT_FOUND", `no item ${line.itemId} in company ${companyId}`);
    }
    if (typeof line.unitId === "string" && !units.has(line.unitId)) {
      throw new AppError(
        "ERR_NOT_FOUND",
        `no unit of measure ${line.unitId} in company ${companyId}`,
      );
    }
  }
}

const ListParams = z.object({ companyId: UuidSchema });
const ItemParams = z.object({ companyId: UuidSchema, priceListId: UuidSchema });

priceListRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "List price lists, keyset-paged on code",
    request: { params: ListParams, query: PriceListQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: PriceListList } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await c.var.withTenant((tx) =>
      listPriceLists(tx, {
        companyId,
        includeArchived: q.includeArchived,
        // `exactOptionalPropertyTypes` is on, so an absent option is OMITTED rather than passed as undefined.
        ...(q.branchId === undefined ? {} : { branchId: q.branchId }),
        ...(after === null ? {} : { cursor: { code: String(after.k[0]) } }),
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

priceListRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "Create a price list — a null branchId means every branch",
    request: {
      params: ListParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreatePriceListBody } } },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: PriceListSchema } } },
      404: {
        description: "The branch is not a BRANCH value of this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "Duplicate code",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const b = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      if (typeof b.branchId === "string") await assertBranchBelongs(tx, companyId, b.branchId);
      return createPriceList(tx, {
        companyId,
        code: b.code,
        nameEn: b.nameEn,
        currency: b.currency,
        ...(b.nameAr === undefined ? {} : { nameAr: b.nameAr }),
        ...(b.customerKind === undefined ? {} : { customerKind: b.customerKind }),
        ...(b.branchId === undefined ? {} : { branchId: b.branchId }),
        ...(b.validFrom === undefined ? {} : { validFrom: b.validFrom }),
        ...(b.validTo === undefined ? {} : { validTo: b.validTo }),
      });
    });
    return c.json(row, 201);
  },
);

/**
 * Mounted BEFORE `GET /{priceListId}` so `resolve` is never parsed as a uuid path parameter. A catalogue gap
 * answers `200 { price: null }` rather than 404: "this item has no price on any applicable list" is a
 * successful answer a screen renders as an empty price field, while a 404 means "no such route or resource"
 * and would make an ordinary gap look like a client error.
 */
priceListRoutes.openapi(
  createRoute({
    method: "get",
    path: "/resolve",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "Resolve one price for an item, quantity, date, trade level and branch",
    request: { params: ListParams, query: PriceQuerySchema },
    responses: {
      200: {
        description: "The applicable price, or null when no list carries one",
        content: { "application/json": { schema: ResolvedPriceEnvelope } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const price = await c.var.withTenant((tx) =>
      resolvePrice(tx, {
        companyId,
        itemId: q.itemId,
        currency: q.currency,
        quantity: q.quantity,
        on: q.on,
        ...(q.unitId === undefined ? {} : { unitId: q.unitId }),
        ...(q.customerKind === undefined ? {} : { customerKind: q.customerKind }),
        ...(q.branchId === undefined ? {} : { branchId: q.branchId }),
      }),
    );
    return c.json({ price }, 200);
  },
);

priceListRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{priceListId}",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "Read one price list",
    request: { params: ItemParams },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: PriceListSchema } } },
      404: {
        description: "Unknown",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, priceListId } = c.req.valid("param");
    const row = await c.var.withTenant(async (tx) => {
      await priceListInCompany(tx, companyId, priceListId);
      return getPriceList(tx, priceListId);
    });
    if (row === null) throw new AppError("ERR_NOT_FOUND", `no price list ${priceListId}`);
    return c.json(row, 200);
  },
);

priceListRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{priceListId}",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "Edit a price list's name, trade level or validity window",
    request: {
      params: ItemParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdatePriceListBody } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: PriceListSchema } } },
      404: {
        description: "Unknown",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, priceListId } = c.req.valid("param");
    const b = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      await priceListInCompany(tx, companyId, priceListId);
      return updatePriceList(tx, priceListId, {
        ...(b.nameEn === undefined ? {} : { nameEn: b.nameEn }),
        ...(b.nameAr === undefined ? {} : { nameAr: b.nameAr }),
        ...(b.customerKind === undefined ? {} : { customerKind: b.customerKind }),
        ...(b.validFrom === undefined ? {} : { validFrom: b.validFrom }),
        ...(b.validTo === undefined ? {} : { validTo: b.validTo }),
      });
    });
    if (row === null) throw new AppError("ERR_NOT_FOUND", `no price list ${priceListId}`);
    return c.json(row, 200);
  },
);

/** Archive, never delete (spec:2049). 404 rather than 409 on an already-archived list: `archivePriceList`'s
 *  `and archived_at is null` returns null, and "there is no unarchived list by that id" is the honest answer
 *  for an idempotent replay whose first attempt succeeded. */
priceListRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{priceListId}/archive",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "Archive a price list",
    request: {
      params: ItemParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: z.object({}).strict() } } },
    },
    responses: {
      200: {
        description: "Archived",
        content: { "application/json": { schema: PriceListSchema } },
      },
      404: {
        description: "Unknown",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, priceListId } = c.req.valid("param");
    const row = await c.var.withTenant(async (tx) => {
      await priceListInCompany(tx, companyId, priceListId);
      return archivePriceList(tx, priceListId);
    });
    if (row === null) {
      throw new AppError("ERR_NOT_FOUND", `no unarchived price list ${priceListId}`);
    }
    return c.json(row, 200);
  },
);

priceListRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{priceListId}/lines",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "List a price list's live lines",
    request: { params: ItemParams },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: PriceListLineList } } },
    },
  }),
  async (c) => {
    const { companyId, priceListId } = c.req.valid("param");
    const rows = await c.var.withTenant(async (tx) => {
      await priceListInCompany(tx, companyId, priceListId);
      return listPriceListLines(tx, { priceListId });
    });
    return c.json({ items: rows, next_cursor: null }, 200);
  },
);

/**
 * A replace, so the body is the COMPLETE set (1A's `PUT …/documents/{id}/lines` precedent). The response is
 * the SURVIVING set rather than an echo of the request: `replacePriceListLines` archives an omitted line
 * instead of deleting it (§3.5.4 pins the DELETE grants), and returning the request would hide that.
 */
priceListRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{priceListId}/lines",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "Replace a price list's lines with the complete supplied set",
    request: {
      params: ItemParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: ReplacePriceListLinesBody } } },
    },
    responses: {
      200: {
        description: "The surviving lines",
        content: { "application/json": { schema: PriceListLineList } },
      },
      404: {
        description: "Unknown list, or an item or unit that is not this company's",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, priceListId } = c.req.valid("param");
    const { lines } = c.req.valid("json");
    const rows = await c.var.withTenant(async (tx) => {
      await priceListInCompany(tx, companyId, priceListId);
      await assertLinesBelong(tx, companyId, lines);
      return replacePriceListLines(
        tx,
        priceListId,
        lines.map((line) => ({
          itemId: line.itemId,
          unitPrice: line.unitPrice,
          ...(line.unitId === undefined ? {} : { unitId: line.unitId }),
          ...(line.minQuantity === undefined ? {} : { minQuantity: line.minQuantity }),
        })),
      );
    });
    return c.json({ items: rows, next_cursor: null }, 200);
  },
);
