import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  CloneReportDefinitionBody,
  CreateReportDefinitionBody,
  decodeCursor,
  encodeCursor,
  ProblemSchema,
  ReportDefinitionList,
  ReportDefinitionQuery,
  ReportDefinitionSchema,
  UpdateReportDefinitionBody,
  UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  archiveReportDefinition,
  cloneReportDefinition,
  createReportDefinition,
  getReportDefinition,
  listReportDefinitions,
  updateReportDefinition,
  type ReportDefinitionRow,
} from "@dulja/db";
import type { ReportDefinition } from "@dulja/domain";
import type { Context } from "hono";
import type { AppEnv } from "../../context";
import { membershipOnly, requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
// Type-only, so nothing circular survives to runtime (the shape `paymentTermRouteModule` uses).
import type { RouteModule } from "../index";

/**
 * `/v1/companies/{companyId}/report-definitions` (7A Task 13, contracts §4.11.2) — "a user clones and edits a
 * report without a release" (spec:2293).
 *
 * WRITES are gated by `admin.company.manage`: §3.6.2 maintains document types, posting policies and print
 * templates under it, and a report definition is the same class of company configuration. READS are
 * membership only (`membershipOnly()`), on §4.2.11's dimension precedent and the chart of accounts': §3.6.1
 * closes the vocabulary and holds no report-definition read code. A definition is a layout, not data; the
 * data it reads is gated again, by the definition's own `permission`, on every run (Task 12).
 */
export const reportDefinitionRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

export const REPORT_DEFINITION_ROUTE_PATH = "/v1/companies/:companyId/report-definitions";

/** The gate clearing this company is what keeps the `companyId` handed to every store call an authorised id
 *  rather than a claimed one (AGENTS.md). */
const manage = () =>
  requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" });

const Params = z.object({ companyId: UuidSchema });
const ItemParams = Params.extend({ definitionId: UuidSchema });

const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

function toDto(row: ReportDefinitionRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    version: row.version,
    definition: row.definition,
    clonedFrom: row.clonedFrom,
    isCore: row.isCore,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}

/** `listReportDefinitions` orders by `(code, version)`, so its cursor is `k: [code, version]` plus the id. */
function definitionCursor(raw: string): { code: string; version: number } {
  const decoded = decodeCursor(raw);
  const [code, version] = decoded.k;
  if (
    decoded.k.length !== 2 ||
    typeof code !== "string" ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    !UuidSchema.safeParse(decoded.id).success
  )
    throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid report-definition cursor");
  return { code, version };
}

/** The definition in THIS company, or 404 — an id alone never reaches another company's row. */
async function loadCompanyDefinition(
  c: Context<AppEnv>,
  companyId: string,
  definitionId: string,
): Promise<ReportDefinitionRow> {
  const row = await c.var.withTenant((tx) => getReportDefinition(tx, definitionId));
  if (row === null || row.companyId !== companyId)
    throw new AppError(
      "ERR_NOT_FOUND",
      `report definition ${definitionId} was not found in company ${companyId}`,
    );
  return row;
}

reportDefinitionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["reports"],
    middleware: [membershipOnly()] as const,
    summary: "List the company's report definitions, keyset-paged on (code, version)",
    request: { params: Params, query: ReportDefinitionQuery },
    responses: {
      200: {
        description: "Report definitions",
        content: { "application/json": { schema: ReportDefinitionList } },
      },
      400: problem("Invalid query or cursor"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const cursor = q.cursor === undefined ? null : definitionCursor(q.cursor);
    // One row past the page decides whether there IS a next page.
    const rows = await c.var.withTenant((tx) =>
      listReportDefinitions(tx, {
        companyId,
        code: q["filter[code][eq]"],
        includeArchived: q["filter[archived][eq]"] === "true",
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
            ? encodeCursor({ k: [last.code, last.version], id: last.id })
            : null,
      },
      200,
    );
  },
);

reportDefinitionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{definitionId}",
    tags: ["reports"],
    middleware: [membershipOnly()] as const,
    summary: "Read one report definition (an archived one included)",
    request: { params: ItemParams },
    responses: {
      200: {
        description: "The definition",
        content: { "application/json": { schema: ReportDefinitionSchema } },
      },
      404: problem("Not found"),
    },
  }),
  async (c) => {
    const { companyId, definitionId } = c.req.valid("param");
    return c.json(toDto(await loadCompanyDefinition(c, companyId, definitionId)), 200);
  },
);

reportDefinitionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["reports"],
    middleware: [manage()] as const,
    summary: "Create a tenant report definition at the code's next version",
    request: {
      params: Params,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateReportDefinitionBody } } },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: ReportDefinitionSchema } },
      },
      400: problem("Invalid definition; errors[] are JSON Pointers into it"),
      403: problem("Forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { definition } = c.req.valid("json");
    // `isCore` is never the caller's: only the seed pack writes a core row (Task 14).
    const row = await c.var.withTenant((tx) =>
      createReportDefinition(tx, { companyId, definition, isCore: false }),
    );
    return c.json(toDto(row), 201);
  },
);

// ── THE DoD ROUTE: clone-and-edit without a release (spec:2293) ──────────────────────────────────────
reportDefinitionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{definitionId}/clone",
    tags: ["reports"],
    middleware: [manage()] as const,
    summary: "Clone a definition at the code's next version, optionally overriding parts of it",
    request: {
      params: ItemParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CloneReportDefinitionBody } } },
    },
    responses: {
      201: {
        description: "The clone",
        content: { "application/json": { schema: ReportDefinitionSchema } },
      },
      400: problem("The cloned definition is invalid"),
      403: problem("Forbidden"),
      404: problem("Not found"),
    },
  }),
  async (c) => {
    const { companyId, definitionId } = c.req.valid("param");
    const { overrides } = c.req.valid("json");
    // The store re-validates the merged result in full, so the overrides' shape needs no second check here.
    const row = await c.var.withTenant((tx) =>
      cloneReportDefinition(tx, {
        companyId,
        sourceId: definitionId,
        overrides: overrides as Partial<ReportDefinition> | undefined,
      }),
    );
    return c.json(toDto(row), 201);
  },
);

reportDefinitionRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{definitionId}",
    tags: ["reports"],
    middleware: [manage()] as const,
    summary: "Edit a tenant definition in place; a core definition refuses and must be cloned",
    request: {
      params: ItemParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdateReportDefinitionBody } } },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: ReportDefinitionSchema } },
      },
      400: problem("Invalid definition, a core definition, or an archived one"),
      403: problem("Forbidden"),
      404: problem("Not found"),
    },
  }),
  async (c) => {
    const { companyId, definitionId } = c.req.valid("param");
    const { definition } = c.req.valid("json");
    await loadCompanyDefinition(c, companyId, definitionId);
    const row = await c.var.withTenant((tx) =>
      updateReportDefinition(tx, { id: definitionId, definition }),
    );
    return c.json(toDto(row), 200);
  },
);

reportDefinitionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{definitionId}/archive",
    tags: ["reports"],
    middleware: [manage()] as const,
    summary: "Archive a definition — never deleted (spec:2049)",
    request: { params: ItemParams, headers: IdempotencyHeader },
    responses: {
      204: { description: "Archived" },
      403: problem("Forbidden"),
      404: problem("Not found or already archived"),
    },
  }),
  async (c) => {
    const { companyId, definitionId } = c.req.valid("param");
    await loadCompanyDefinition(c, companyId, definitionId);
    await c.var.withTenant((tx) => archiveReportDefinition(tx, definitionId));
    return c.body(null, 204);
  },
);

export const reportDefinitionRouteModule: RouteModule = {
  path: REPORT_DEFINITION_ROUTE_PATH,
  router: reportDefinitionRoutes,
  permissions: [PERMISSION["admin.company.manage"]],
  auth: "human",
};
