import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  CreatePromotionBody,
  ProblemSchema,
  PromotionList,
  PromotionQuery,
  PromotionSchema,
  UpdatePromotionBody,
  UuidSchema,
  decodeCursor,
  encodeCursor,
} from "@dulja/contracts";
import { createPromotion, listPromotions, updatePromotion } from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import { INVENTORY_PERMISSION } from "./permissions";

/**
 * `/v1/companies/{companyId}/promotions` under `inventory.price.manage` (contracts §3.6.2). There is no
 * archive route and no DELETE route: §4.6.1 gives `app.promotion` no `archived_at`, so an offer is RETIRED
 * by patching `endsAt` — which is what a date-windowed offer means.
 */
export const promotionRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

const SCOPE = { company: "path:companyId" } as const;
const gate = () => requirePermission(INVENTORY_PERMISSION.priceManage, SCOPE);

type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

/**
 * The company-binding guard AGENTS.md requires of every id in a path. `updatePromotion` (Task 4) takes a bare
 * `promotionId`, and RLS bounds the TENANT and nothing else, so without this a principal cleared for company A
 * could rewrite company B's offers inside the same tenant.
 */
async function promotionInCompany(tx: Tx, companyId: string, promotionId: string): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.promotion where id = ${promotionId} and company_id = ${companyId}`;
  if (!row)
    throw new AppError("ERR_NOT_FOUND", `no promotion ${promotionId} in company ${companyId}`);
}

/** 2026-11-15 review, API-15 / INV-14: `promotion.branch_id`'s key is `(tenant_id, branch_id) →
 *  app.dimension_value` (0030) — tenant-composite only — so a sibling company's branch, or a value of a
 *  dimension that is not BRANCH, would be accepted and the promotion would then match no branch user (Form B's
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** API-15: a definition's `itemIds` (6B's three kinds, `packages/domain/src/pos/promotion.ts`) are shipped to
 *  the company's tills, so each must be an item of the PATH company; the definition is otherwise carried
 *  verbatim. A definition with no `itemIds` array is not inspected. */
async function assertDefinitionItemsBelong(
  tx: Tx,
  companyId: string,
  definition: Record<string, unknown>,
): Promise<void> {
  const listed = definition["itemIds"];
  if (!Array.isArray(listed)) return;
  const candidates = [
    ...new Set(listed.filter((id): id is string => typeof id === "string" && UUID.test(id))),
  ];
  const found = new Set(
    (
      await tx<{ id: string }[]>`
        select id from app.item where company_id = ${companyId} and id = any(${candidates}::uuid[])`
    ).map((row) => row.id),
  );
  for (const id of listed) {
    if (typeof id !== "string" || !found.has(id)) {
      throw new AppError("ERR_NOT_FOUND", `no item ${String(id)} in company ${companyId}`);
    }
  }
}

/** PostgreSQL validates the complete stored window, including retained PATCH fields and microsecond
 * rounding. Translate only this CHECK; other database failures keep their existing error mapping. */
function promotionWriteError(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23514" &&
    "constraint_name" in error &&
    error.constraint_name === "promotion_window_check"
  ) {
    throw new AppError("ERR_VALIDATION_FAILED", "endsAt must be after startsAt", {
      errors: [{ path: "endsAt", message: "endsAt must be after startsAt" }],
    });
  }
  throw error;
}

promotionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "List promotions, keyset-paged on code",
    request: { params: z.object({ companyId: UuidSchema }), query: PromotionQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: PromotionList } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await c.var.withTenant((tx) =>
      listPromotions(tx, {
        companyId,
        ...(q.branchId === undefined ? {} : { branchId: q.branchId }),
        ...(q.activeOn === undefined ? {} : { activeOn: q.activeOn }),
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

promotionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "Create a promotion — a null branchId means every branch",
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreatePromotionBody } } },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: PromotionSchema } } },
      400: {
        description: "Invalid promotion window",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "The branch, or an item in definition.itemIds, is not this company's",
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
    const row = await c.var
      .withTenant(async (tx) => {
        if (typeof b.branchId === "string") await assertBranchBelongs(tx, companyId, b.branchId);
        await assertDefinitionItemsBelong(tx, companyId, b.definition);
        return createPromotion(tx, {
          companyId,
          code: b.code,
          nameEn: b.nameEn,
          kind: b.kind,
          definition: b.definition,
          ...(b.nameAr === undefined ? {} : { nameAr: b.nameAr }),
          ...(b.startsAt === undefined ? {} : { startsAt: b.startsAt }),
          ...(b.endsAt === undefined ? {} : { endsAt: b.endsAt }),
          ...(b.branchId === undefined ? {} : { branchId: b.branchId }),
        });
      })
      .catch(promotionWriteError);
    return c.json(row, 201);
  },
);

promotionRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{promotionId}",
    tags: ["inventory"],
    middleware: [gate()] as const,
    summary: "Edit a promotion — setting endsAt is how an offer is retired",
    request: {
      params: z.object({ companyId: UuidSchema, promotionId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdatePromotionBody } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: PromotionSchema } } },
      400: {
        description: "Invalid promotion window",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description:
          "Unknown promotion, or an item in definition.itemIds that is not this company's",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, promotionId } = c.req.valid("param");
    const b = c.req.valid("json");
    const row = await c.var
      .withTenant(async (tx) => {
        await promotionInCompany(tx, companyId, promotionId);
        if (b.definition !== undefined)
          await assertDefinitionItemsBelong(tx, companyId, b.definition);
        return updatePromotion(tx, promotionId, {
          ...(b.nameEn === undefined ? {} : { nameEn: b.nameEn }),
          ...(b.nameAr === undefined ? {} : { nameAr: b.nameAr }),
          ...(b.definition === undefined ? {} : { definition: b.definition }),
          ...(b.startsAt === undefined ? {} : { startsAt: b.startsAt }),
          ...(b.endsAt === undefined ? {} : { endsAt: b.endsAt }),
        });
      })
      .catch(promotionWriteError);
    if (row === null) throw new AppError("ERR_NOT_FOUND", `no promotion ${promotionId}`);
    return c.json(row, 200);
  },
);
