import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import {
  CreatePayComponentBody,
  PayComponentList,
  PayComponentQuery,
  PayComponentSchema,
  SetComponentSchemesBody,
  UpdatePayComponentBody,
} from "@dulja/contracts/hr/pay-component";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  archivePayComponent,
  createPayComponent,
  listPayComponents,
  renamePayComponent,
  setComponentSchemes,
  type PayComponent,
} from "@dulja/db";
import type { Sql } from "postgres";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";

const CompanyParams = z.object({ companyId: z.string().uuid() });
const ComponentParams = CompanyParams.extend({ componentId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;
const read = PERMISSION["hr.compensation.read"],
  manage = PERMISSION["hr.pay_component.manage"];
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

const toDto = (c: PayComponent) => ({
  id: c.id,
  code: c.code,
  nameEn: c.nameEn,
  nameAr: c.nameAr,
  kind: c.kind,
  expenseAccountId: c.expenseAccountId,
  payableAccountId: c.payableAccountId,
  quantityBased: c.quantityBased,
  schemeIds: c.schemeIds,
  archivedAt: c.archivedAt,
});

/** One read, used by every route that answers with a component after changing it. Reading back through
 *  `listPayComponents` rather than a `returning` clause is deliberate: `schemeIds` aggregates the join table. It is
 *  also the company binding: a component of another company (or tenant) is 404 before anything is written. */
const reread = async (tx: Sql, companyId: string, componentId: string) => {
  const row = (await listPayComponents(tx, companyId, { includeArchived: true })).find(
    (c) => c.id === componentId,
  );
  if (row === undefined)
    throw new AppError("ERR_NOT_FOUND", `pay component ${componentId} was not found`);
  return toDto(row);
};

/** 8A T7 — the pay-component catalogue (amendment A7). The list is gated by the compensation READ code rather than
 *  membership: the catalogue names what a company pays for, which spec:2159 keeps from `user`. */
export const payComponentRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

payComponentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["hr"],
    request: { params: CompanyParams, query: PayComponentQuery },
    middleware: [requirePermission(read, gate)],
    responses: {
      200: {
        description: "The catalogue, by kind then code",
        content: { "application/json": { schema: PayComponentList } },
      },
      403: problem("forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    // `filter[archived][eq]=true` widens the read to archived rows too; absent or `false` is the default list.
    const includeArchived = q["filter[archived][eq]"] === "true";
    const kind = q["filter[kind][eq]"];
    const rows = await c.var.withTenant((tx) =>
      listPayComponents(tx, companyId, { includeArchived }),
    );
    const items = rows.filter((r) => kind === undefined || r.kind === kind).map(toDto);
    return c.json({ items, next_cursor: null }, 200);
  },
);

payComponentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["hr"],
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreatePayComponentBody } } },
    },
    middleware: [requirePermission(manage, gate)],
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: PayComponentSchema } },
      },
      403: problem("forbidden"),
      409: problem("the code is already used in this company"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      const id = await createPayComponent(tx, companyId, {
        code: body.code,
        nameEn: body.nameEn,
        nameAr: body.nameAr ?? null,
        kind: body.kind,
        quantityBased: body.quantityBased,
      });
      return reread(tx, companyId, id);
    });
    return c.json(dto, 201);
  },
);

payComponentRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{componentId}",
    tags: ["hr"],
    request: {
      params: ComponentParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdatePayComponentBody } } },
    },
    middleware: [requirePermission(manage, gate)],
    responses: {
      200: {
        description: "Renamed",
        content: { "application/json": { schema: PayComponentSchema } },
      },
      403: problem("forbidden"),
      404: problem("no such pay component in this company"),
    },
  }),
  async (c) => {
    const { companyId, componentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      await reread(tx, companyId, componentId); // 404 before the update, never after it
      await renamePayComponent(tx, componentId, {
        ...(body.nameEn === undefined ? {} : { nameEn: body.nameEn }),
        ...(body.nameAr === undefined ? {} : { nameAr: body.nameAr }),
      });
      return reread(tx, companyId, componentId);
    });
    return c.json(dto, 200);
  },
);

payComponentRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{componentId}/schemes",
    tags: ["hr"],
    request: {
      params: ComponentParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: SetComponentSchemesBody } } },
    },
    middleware: [requirePermission(manage, gate)],
    responses: {
      200: {
        description: "The joins after the change",
        content: { "application/json": { schema: PayComponentSchema } },
      },
      403: problem("forbidden"),
      404: problem("no such pay component in this company"),
      409: problem("an unknown statutory scheme"),
    },
  }),
  async (c) => {
    const { companyId, componentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      await reread(tx, companyId, componentId);
      // An unknown scheme id violates the scheme FK migration 0084 adds (A13): SQLSTATE 23503, mapped to
      // ERR_CONFLICT_REFERENCE. The handler adds no existence pre-check — the FK is the check.
      await setComponentSchemes(tx, componentId, body.schemeIds);
      return reread(tx, companyId, componentId);
    });
    return c.json(dto, 200);
  },
);

payComponentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{componentId}/archive",
    tags: ["hr"],
    request: { params: ComponentParams, headers: IdempotencyHeader },
    middleware: [requirePermission(manage, gate)],
    responses: {
      200: {
        description: "Archived; the row leaves the default list",
        content: { "application/json": { schema: PayComponentSchema } },
      },
      403: problem("forbidden"),
      404: problem("no such pay component in this company"),
    },
  }),
  async (c) => {
    const { companyId, componentId } = c.req.valid("param");
    const dto = await c.var.withTenant(async (tx) => {
      await reread(tx, companyId, componentId);
      await archivePayComponent(tx, componentId);
      return reread(tx, companyId, componentId);
    });
    return c.json(dto, 200);
  },
);

export const payComponentRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/pay-components",
  router: payComponentRoutes,
  permissions: [read, manage],
  auth: "human",
};
