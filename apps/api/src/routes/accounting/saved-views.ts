import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  CreateSavedViewBody,
  decodeCursor,
  encodeCursor,
  ProblemSchema,
  SavedViewList,
  SavedViewQuery,
  SavedViewSchema,
  UpdateSavedViewBody,
  UuidSchema,
} from "@dulja/contracts";
import {
  archiveSavedView,
  createSavedView,
  getSavedView,
  listSavedViews,
  updateSavedView,
  type SavedViewRow,
} from "@dulja/db";
import type { Context } from "hono";
import type { AppEnv } from "../../context";
import { membershipOnly } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
// Type-only, so nothing circular survives to runtime.
import type { RouteModule } from "../index";

/**
 * `/v1/companies/{companyId}/saved-views` (7A Task 13, contracts §4.11.2, ADR 0067) — a named parameter set
 * over a report definition, which its owner bookmarks (spec:1241). Archived, never deleted (spec:2049).
 *
 * NO permission code on any route, deliberately. A saved view is personal state, and §3.6.1 closes the
 * permission vocabulary with no code for it. The gates are RLS (the tenant), the company predicate the store
 * takes, `owner_principal_id = app.current_actor()` in the store for every write, and the `shared` flag for a
 * read. A run started from a view is gated again, by the export code and the definition's own `permission`
 * (Task 12), so a bookmark never widens what its holder can render. The module declares `permissions: []`,
 * which is what `assertRouteGates` reads as "no code to enforce" (the `/v1/session` precedent); the two reads
 * still say `membershipOnly()` out loud.
 */
export const savedViewRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

export const SAVED_VIEW_ROUTE_PATH = "/v1/companies/:companyId/saved-views";

const Params = z.object({ companyId: UuidSchema });
const ItemParams = Params.extend({ viewId: UuidSchema });

const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

function toDto(v: SavedViewRow) {
  return {
    id: v.id,
    companyId: v.companyId,
    reportDefinitionId: v.reportDefinitionId,
    nameEn: v.nameEn,
    nameAr: v.nameAr,
    parameters: v.parameters,
    ownerPrincipalId: v.ownerPrincipalId,
    shared: v.shared,
    archivedAt: v.archivedAt,
    createdAt: v.createdAt,
  };
}

/** `listSavedViews` orders by `(created_at, id)` descending, so its cursor is `k: [createdAt]` plus the id. */
function viewCursor(raw: string): { createdAt: string; id: string } {
  const decoded = decodeCursor(raw);
  const [createdAt] = decoded.k;
  if (
    decoded.k.length !== 1 ||
    typeof createdAt !== "string" ||
    Number.isNaN(Date.parse(createdAt)) ||
    !UuidSchema.safeParse(decoded.id).success
  )
    throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid saved-view cursor");
  return { createdAt, id: decoded.id };
}

/** The view in THIS company, or 404 — an id alone never reaches another company's row, and a row of another
 *  tenant is invisible to RLS and takes the same branch (what the isolation probe asserts). */
async function loadCompanyView(
  c: Context<AppEnv>,
  companyId: string,
  viewId: string,
): Promise<SavedViewRow> {
  const row = await c.var.withTenant((tx) => getSavedView(tx, viewId));
  if (row === null || row.companyId !== companyId)
    throw new AppError(
      "ERR_NOT_FOUND",
      `saved view ${viewId} was not found in company ${companyId}`,
    );
  return row;
}

savedViewRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["reports"],
    middleware: [membershipOnly()] as const,
    summary: "List the caller's own saved views and the company's shared ones, newest first",
    request: { params: Params, query: SavedViewQuery },
    responses: {
      200: {
        description: "Saved views",
        content: { "application/json": { schema: SavedViewList } },
      },
      400: problem("Invalid query or cursor"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const cursor = q.cursor === undefined ? null : viewCursor(q.cursor);
    // No principal argument: `app.current_actor()` inside the transaction already is the caller.
    const rows = await c.var.withTenant((tx) =>
      listSavedViews(tx, {
        companyId,
        reportDefinitionId: q["filter[report_definition_id][eq]"],
        limit: q.limit + 1,
        cursor,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page.map(toDto),
        next_cursor:
          rows.length > q.limit && last !== undefined
            ? encodeCursor({ k: [last.createdAt], id: last.id })
            : null,
      },
      200,
    );
  },
);

savedViewRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["reports"],
    summary: "Save a named parameter set over a report definition, owned by the caller",
    request: {
      params: Params,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateSavedViewBody } } },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: SavedViewSchema } },
      },
      400: problem("Invalid body, or a parameter the definition does not declare"),
      404: problem("No live definition of this company"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant((tx) =>
      createSavedView(tx, {
        companyId,
        reportDefinitionId: body.reportDefinitionId,
        nameEn: body.nameEn,
        nameAr: body.nameAr ?? null,
        parameters: body.parameters,
        shared: body.shared,
      }),
    );
    return c.json(toDto(row), 201);
  },
);

savedViewRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{viewId}",
    tags: ["reports"],
    middleware: [membershipOnly()] as const,
    summary: "Read one live saved view the caller owns or that is shared",
    request: { params: ItemParams },
    responses: {
      200: {
        description: "The view",
        content: { "application/json": { schema: SavedViewSchema } },
      },
      403: problem("Another principal's private view"),
      404: problem("Not found or archived"),
    },
  }),
  async (c) => {
    const { companyId, viewId } = c.req.valid("param");
    const row = await loadCompanyView(c, companyId, viewId);
    if (row.archivedAt !== null)
      throw new AppError(
        "ERR_NOT_FOUND",
        `saved view ${viewId} was not found in company ${companyId}`,
      );
    // Another principal's PRIVATE view is a refusal, not a 404: the row is in the caller's own tenant and
    // company, and the decision is a permission one. A row of another tenant took the 404 above.
    if (!row.shared && row.ownerPrincipalId !== c.var.ctx.actorId)
      throw new AppError(
        "ERR_RBAC_FORBIDDEN",
        `saved view ${viewId} belongs to another principal and is not shared`,
      );
    return c.json(toDto(row), 200);
  },
);

savedViewRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{viewId}",
    tags: ["reports"],
    summary: "Change a saved view — its owner only",
    request: {
      params: ItemParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdateSavedViewBody } } },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: SavedViewSchema } },
      },
      400: problem("Invalid body, an undeclared parameter, or an archived view"),
      403: problem("Not the view's owner"),
      404: problem("Not found"),
    },
  }),
  async (c) => {
    const { companyId, viewId } = c.req.valid("param");
    const body = c.req.valid("json");
    // The pre-flight separates "another company's id in the path" (404) from "not yours" (403, raised by the
    // store's own owner check against app.current_actor(), which is the authority).
    await loadCompanyView(c, companyId, viewId);
    const row = await c.var.withTenant((tx) => updateSavedView(tx, { id: viewId, ...body }));
    return c.json(toDto(row), 200);
  },
);

savedViewRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{viewId}",
    tags: ["reports"],
    summary: "Archive a saved view — its owner only; the row is never deleted (spec:2049)",
    request: { params: ItemParams, headers: IdempotencyHeader },
    responses: {
      204: { description: "Archived" },
      403: problem("Not the view's owner"),
      404: problem("Not found"),
    },
  }),
  async (c) => {
    const { companyId, viewId } = c.req.valid("param");
    await loadCompanyView(c, companyId, viewId);
    // `app_rw` holds no DELETE on `saved_view` (§3.5.4's pinned list); DELETE sets `archived_at` (§4.11.2), and
    // a second DELETE of an archived view is a no-op that still answers 204.
    await c.var.withTenant((tx) => archiveSavedView(tx, viewId));
    return c.body(null, 204);
  },
);

export const savedViewRouteModule: RouteModule = {
  path: SAVED_VIEW_ROUTE_PATH,
  router: savedViewRoutes,
  // EMPTY, deliberately: see the module comment. Inventing a code would breach §3.6.1.
  permissions: [],
  auth: "human",
};
