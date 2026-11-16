import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  CreateWarehouseBody,
  decodeCursor,
  encodeCursor,
  ProblemSchema,
  UpdateWarehouseBody,
  UuidSchema,
  WarehouseList,
  WarehouseQuery,
  WarehouseSchema,
  WarehouseTree,
} from "@dulja/contracts";
import {
  archiveWarehouse,
  createWarehouse,
  getWarehouse,
  listWarehouses,
  updateWarehouse,
  warehouseTree,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import { INVENTORY_PERMISSION } from "./permissions";

/**
 * `/v1/companies/{companyId}/warehouses` — the warehouse tree, read under `inventory.item.read` and
 * maintained under `inventory.item.manage` (assumption 11: head office owns the catalogue, so there is no
 * separate warehouse code and a `branch_manager` holding only the two read codes cannot create one).
 *
 * No DELETE route: master data is archived (spec:2049) and this slice adds no `app_rw` DELETE grant.
 */
export const warehouseRoutes = new OpenAPIHono<AppEnv>({
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
 * AGENTS.md's Always list: an endpoint whose gate clears a company must pass that company into every service
 * call. `getWarehouse`, `updateWarehouse` and `archiveWarehouse` take a warehouse id alone, so the path's id
 * is bound to the path's company here first. 404, not 403: an id the caller may not see is not confirmed to
 * exist.
 */
async function loadWarehouse(tx: Tx, companyId: string, warehouseId: string): Promise<void> {
  const row = await getWarehouse(tx, warehouseId);
  if (!row || row.companyId !== companyId) {
    throw new AppError("ERR_NOT_FOUND", `no warehouse ${warehouseId} in company ${companyId}`);
  }
}

/** `warehouse.branch_id`'s key is `(tenant_id, branch_id) → app.dimension_value` (0029) — tenant-composite
 *  only — so without this a branch of a SIBLING company would be accepted and every figure this warehouse
 *  ever carries would be scoped to that company's branch. The same check the documents module makes. */
async function assertBranchBelongs(tx: Tx, companyId: string, branchId: string): Promise<void> {
  const [branch] = await tx<{ id: string }[]>`
    select v.id
      from app.dimension_value v
      join app.dimension_type t on t.id = v.dimension_type_id
     where v.id = ${branchId} and t.company_id = ${companyId} and t.code = 'BRANCH'
       and v.archived_at is null`;
  if (!branch) throw new AppError("ERR_NOT_FOUND", `no branch ${branchId} in company ${companyId}`);
}

/** `warehouse.parent_id`'s key is `(tenant_id, parent_id) → app.warehouse` — tenant-composite only, so a
 *  sibling company's warehouse would be admitted as a parent and `warehouseTree` would then walk across the
 *  company boundary. `app.warehouse_no_cycle()` is the second line of defence, not the first. */
async function assertParentBelongs(tx: Tx, companyId: string, parentId: string): Promise<void> {
  const parent = await getWarehouse(tx, parentId);
  if (!parent || parent.companyId !== companyId) {
    throw new AppError("ERR_NOT_FOUND", `no parent warehouse ${parentId} in company ${companyId}`);
  }
}

// `/tree` is registered BEFORE `/{warehouseId}` so the literal segment is not swallowed by the parameter.
warehouseRoutes.openapi(
  createRoute({
    method: "get",
    path: "/tree",
    tags: ["inventory"],
    middleware: [readGate()] as const,
    summary: "The whole warehouse tree, with depth and the code path to each node",
    request: { params: z.object({ companyId: UuidSchema }) },
    responses: {
      200: { description: "Tree", content: { "application/json": { schema: WarehouseTree } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    // Returned whole, not paged: a company has tens of warehouses, not thousands, and a fragment of a tree
    // is something the caller cannot reassemble.
    const nodes = await c.var.withTenant((tx) => warehouseTree(tx, companyId));
    return c.json({ items: nodes }, 200);
  },
);

warehouseRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["inventory"],
    middleware: [readGate()] as const,
    summary: "List warehouses, keyset-paged on code",
    request: { params: z.object({ companyId: UuidSchema }), query: WarehouseQuery },
    responses: {
      200: {
        description: "Warehouses",
        content: { "application/json": { schema: WarehouseList } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await c.var.withTenant((tx) =>
      listWarehouses(tx, {
        companyId,
        ...(q["filter[kind][eq]"] === undefined ? {} : { kind: q["filter[kind][eq]"] }),
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

warehouseRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["inventory"],
    middleware: [manageGate()] as const,
    summary: "Create a warehouse",
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateWarehouseBody } } },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: WarehouseSchema } } },
      404: problem("Unknown branch or parent"),
      409: problem("Duplicate code, or a parent that would close a cycle"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const b = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      await assertBranchBelongs(tx, companyId, b.branchId);
      if (b.parentId !== undefined && b.parentId !== null) {
        await assertParentBelongs(tx, companyId, b.parentId);
      }
      return createWarehouse(tx, {
        companyId,
        code: b.code,
        nameEn: b.nameEn,
        branchId: b.branchId,
        ...(b.nameAr === undefined ? {} : { nameAr: b.nameAr }),
        ...(b.kind === undefined ? {} : { kind: b.kind }),
        ...(b.parentId === undefined ? {} : { parentId: b.parentId }),
      });
    });
    return c.json(row, 201);
  },
);

warehouseRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{warehouseId}",
    tags: ["inventory"],
    middleware: [readGate()] as const,
    summary: "Read one warehouse",
    request: { params: z.object({ companyId: UuidSchema, warehouseId: UuidSchema }) },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: WarehouseSchema } } },
      404: problem("Unknown"),
    },
  }),
  async (c) => {
    const { companyId, warehouseId } = c.req.valid("param");
    const row = await c.var.withTenant((tx) => getWarehouse(tx, warehouseId));
    if (!row || row.companyId !== companyId) {
      throw new AppError("ERR_NOT_FOUND", `no warehouse ${warehouseId} in company ${companyId}`);
    }
    return c.json(row, 200);
  },
);

warehouseRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{warehouseId}",
    tags: ["inventory"],
    middleware: [manageGate()] as const,
    summary: "Edit a warehouse's names or parent — never its code, kind or branch",
    request: {
      params: z.object({ companyId: UuidSchema, warehouseId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdateWarehouseBody } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: WarehouseSchema } } },
      404: problem("Unknown"),
      409: problem("A parent that would close a cycle"),
    },
  }),
  async (c) => {
    const { companyId, warehouseId } = c.req.valid("param");
    const b = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      await loadWarehouse(tx, companyId, warehouseId);
      if (b.parentId !== undefined && b.parentId !== null) {
        await assertParentBelongs(tx, companyId, b.parentId);
      }
      return updateWarehouse(tx, warehouseId, {
        ...(b.nameEn === undefined ? {} : { nameEn: b.nameEn }),
        ...(b.nameAr === undefined ? {} : { nameAr: b.nameAr }),
        ...(b.parentId === undefined ? {} : { parentId: b.parentId }),
      });
    });
    if (row === null) {
      throw new AppError("ERR_NOT_FOUND", `no warehouse ${warehouseId} in company ${companyId}`);
    }
    return c.json(row, 200);
  },
);

/** Archive is a POST, never a DELETE (spec:2049). `archiveWarehouse` is idempotent. */
warehouseRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{warehouseId}/archive",
    tags: ["inventory"],
    middleware: [manageGate()] as const,
    summary: "Archive a warehouse",
    request: {
      params: z.object({ companyId: UuidSchema, warehouseId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: z.object({}).strict() } } },
    },
    responses: {
      200: {
        description: "Archived",
        content: { "application/json": { schema: WarehouseSchema } },
      },
      404: problem("Unknown"),
    },
  }),
  async (c) => {
    const { companyId, warehouseId } = c.req.valid("param");
    const row = await c.var.withTenant(async (tx) => {
      await loadWarehouse(tx, companyId, warehouseId);
      return archiveWarehouse(tx, warehouseId);
    });
    if (row === null) {
      throw new AppError("ERR_NOT_FOUND", `no warehouse ${warehouseId} in company ${companyId}`);
    }
    return c.json(row, 200);
  },
);
