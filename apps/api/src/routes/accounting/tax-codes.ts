import { PERMISSION } from "@dulja/contracts/permissions";

/**
 * Slice 5A's one permission code (§3.6.2). Declared here rather than in `packages/contracts` because
 * `scripts/lint/rules/permission-catalogue.ts` scans `apps/**`, `packages/sync` and `packages/db/src` and
 * NOT `packages/contracts/src` — and `packages/db` may not import `@dulja/contracts` (§3.1). Task 8 adds
 * `taxCodeRoutes` and `taxCodeRouteModule` to this file; the module is not registered in `buildRoutes`
 * until then, so the isolation harness never sees a ROUTES entry without a PROBES key.
 *
 * The BRACKET form is required: a dotted code cannot be reached by dot access.
 */
export const TAX_PERMISSION = { manage: PERMISSION["accounting.tax.manage"] } as const;

// apps/api/src/routes/accounting/tax-codes.ts — T4's TAX_PERMISSION const stays exactly as it is; these
// imports and everything below join it.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  getTaxCode,
  archiveTaxCode,
  createTaxCode,
  listTaxCodes,
  type TaxCodeRow,
} from "@dulja/db";
import { decodeCursor, encodeCursor, ProblemSchema, UuidSchema } from "@dulja/contracts";
import {
  CreateTaxCodeBody,
  TaxCodeList,
  TaxCodeQuery,
  TaxCodeSchema,
  type TaxCodeDto,
} from "@dulja/contracts/accounting/tax";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";

export const taxCodeRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

const scope = { company: "path:companyId" } as const;

taxCodeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    request: { params: z.object({ companyId: UuidSchema }), query: TaxCodeQuery },
    responses: {
      200: { content: { "application/json": { schema: TaxCodeList } }, description: "Tax codes" },
      403: {
        content: { "application/problem+json": { schema: ProblemSchema } },
        description: "Forbidden",
      },
    },
    middleware: [requirePermission(TAX_PERMISSION.manage, scope)],
    tags: ["accounting"],
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await c.var.withTenant((tx) =>
      listTaxCodes(tx, {
        companyId,
        ...(q["filter[regimeCode][eq]"] === undefined
          ? {}
          : { regimeCode: q["filter[regimeCode][eq]"] }),
        includeArchived: q["filter[archived][eq]"] === "true",
        cursor: cursor ? { code: cursor.k[0] as string, id: cursor.id } : null,
        limit: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const next =
      rows.length > q.limit && page.length > 0
        ? encodeCursor({ k: [page[page.length - 1]!.code], id: page[page.length - 1]!.id })
        : null;
    return c.json({ items: page.map(toTaxCodeDto), next_cursor: next }, 200);
  },
);

taxCodeRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateTaxCodeBody } } },
    },
    responses: {
      201: { content: { "application/json": { schema: TaxCodeSchema } }, description: "Created" },
      422: {
        content: { "application/problem+json": { schema: ProblemSchema } },
        description: "Unresolvable account",
      },
    },
    middleware: [requirePermission(TAX_PERMISSION.manage, scope)],
    tags: ["accounting"],
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant((tx) =>
      createTaxCode(tx, c.var.ctx, {
        companyId,
        ...body,
        nameAr: body.nameAr ?? null,
        effectiveTo: body.effectiveTo ?? null,
      }),
    );
    return c.json(toTaxCodeDto(row), 201);
  },
);

taxCodeRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{taxCodeId}/archive",
    request: {
      params: z.object({ companyId: UuidSchema, taxCodeId: UuidSchema }),
      headers: IdempotencyHeader,
    },
    responses: {
      // 200 with the archived row, not 204 (MON-13): the idempotency layer replays a stored answer as
      // `new Response(JSON.stringify(body), { status })`, and a 204 may carry no body, so a retried archive
      // threw inside the middleware and answered 500 for the key's whole retention. Bank statements' unmatch
      // and 4A's unallocate answer the same way.
      200: {
        content: { "application/json": { schema: TaxCodeSchema } },
        description: "Archived; the row carries its archivedAt",
      },
      404: {
        content: { "application/problem+json": { schema: ProblemSchema } },
        description: "Not found",
      },
    },
    middleware: [requirePermission(TAX_PERMISSION.manage, scope)],
    tags: ["accounting"],
  }),
  async (c) => {
    const { companyId, taxCodeId } = c.req.valid("param");
    // The path company is in the archive's own UPDATE, so a sibling company's code is the 404 an unknown
    // id gets, with nothing read first.
    const row = await c.var.withTenant(async (tx) => {
      await archiveTaxCode(tx, c.var.ctx, taxCodeId, companyId);
      return getTaxCode(tx, companyId, taxCodeId);
    });
    return c.json(toTaxCodeDto(row), 200);
  },
);

taxCodeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{taxCodeId}",
    request: { params: z.object({ companyId: UuidSchema, taxCodeId: UuidSchema }) },
    middleware: [requirePermission(TAX_PERMISSION.manage, scope)],
    tags: ["accounting"],
    responses: {
      200: { description: "Tax code", content: { "application/json": { schema: TaxCodeSchema } } },
      404: {
        description: "Not found",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, taxCodeId } = c.req.valid("param");
    const row = await c.var.withTenant((tx) => getTaxCode(tx, companyId, taxCodeId));
    return c.json(toTaxCodeDto(row), 200);
  },
);

export const taxCodeRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/tax-codes",
  router: taxCodeRoutes,
  permissions: [TAX_PERMISSION.manage],
  auth: "human",
};

/** `TaxCodeRow` (packages/db) → `TaxCodeDto` (the wire). The one conversion: `archived_at` comes back as a
 *  `text` timestamp and `TimestampSchema` wants RFC 3339, which is what `toISOString()` produces. */
function toTaxCodeDto(row: TaxCodeRow): TaxCodeDto {
  return {
    id: row.id,
    regimeId: row.regimeId,
    regimeCode: row.regimeCode,
    regimeVersion: row.regimeVersion,
    code: row.code,
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    rate: row.rate,
    kind: row.kind,
    roundingMode: row.roundingMode,
    outputAccountId: row.outputAccountId,
    inputAccountId: row.inputAccountId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    archivedAt: row.archivedAt === null ? null : new Date(row.archivedAt).toISOString(),
  };
}
