import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { AppError, PERMISSION, ProblemSchema, UuidSchema } from "@dulja/contracts";
import {
  CreateDimensionTypeBody,
  CreateDimensionValueBody,
  DimensionTypeList,
  DimensionTypeSchema,
  DimensionValueList,
  DimensionValueQuery,
  DimensionValueSchema,
  UpdateDimensionValueBody,
} from "@dulja/contracts/admin/dimension";
import {
  createDimensionType,
  createDimensionValue,
  listDimensionTypes,
  listDimensionValues,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

export const dimensionTypesRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const CompanyParams = z.object({ companyId: UuidSchema });
const TypeParams = CompanyParams.extend({ dimensionTypeId: UuidSchema });
const ValueParams = TypeParams.extend({ valueId: UuidSchema });
const manage = requirePermission(PERMISSION["admin.company.manage"], {
  company: "path:companyId",
});
const problem = (status: 400 | 404 | 409) => ({
  [status]: {
    content: { "application/problem+json": { schema: ProblemSchema } },
    description: "Problem",
  },
});
async function companyExists(tx: Sql, companyId: string): Promise<boolean> {
  return (await tx`select 1 from app.company where id = ${companyId}`).length > 0;
}

/**
 * `app.dimension_value` has no `company_id`; it reaches a company only through its type. So every
 * route below that names a `dimensionTypeId` has to prove the type belongs to the company the gate
 * cleared — RLS bounds the tenant, and `companyExists` alone is true for every company in it, which
 * together admitted a caller authorised for one company to read and write another's values.
 */
async function typeInCompany(
  tx: Sql,
  companyId: string,
  dimensionTypeId: string,
): Promise<boolean> {
  return (
    (
      await tx`select 1 from app.dimension_type
                where id = ${dimensionTypeId} and company_id = ${companyId}`
    ).length > 0
  );
}

dimensionTypesRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["admin"],
    middleware: [manage],
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateDimensionTypeBody } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: DimensionTypeSchema } },
        description: "Created",
      },
      ...problem(400),
      ...problem(409),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const id = await c.var.withTenant((tx) =>
      createDimensionType(tx, { companyId, ...body, nameAr: body.nameAr ?? null }),
    );
    return c.json(
      { id, companyId, code: body.code, nameEn: body.nameEn, nameAr: body.nameAr ?? null },
      201,
    );
  },
);

dimensionTypesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["admin"],
    middleware: [manage],
    request: { params: CompanyParams },
    responses: {
      200: { content: { "application/json": { schema: DimensionTypeList } }, description: "Types" },
      ...problem(404),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const items = await c.var.withTenant(async (tx) =>
      (await companyExists(tx, companyId)) ? listDimensionTypes(tx, companyId) : null,
    );
    if (items === null)
      throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
    return c.json({ items, next_cursor: null }, 200);
  },
);

dimensionTypesRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{dimensionTypeId}/values",
    tags: ["admin"],
    middleware: [manage],
    request: {
      params: TypeParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateDimensionValueBody } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: DimensionValueSchema } },
        description: "Created",
      },
      ...problem(400),
      ...problem(404),
      ...problem(409),
    },
  }),
  async (c) => {
    const { companyId, dimensionTypeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const id = await c.var.withTenant(async (tx) => {
      if (!(await typeInCompany(tx, companyId, dimensionTypeId))) return null;
      // The parent FK is `(tenant_id, parent_id) → dimension_value(tenant_id, id)`, tenant-wide: it would
      // admit a value of another type in this company, or of any type in a sibling company. A hierarchy is
      // within one type, so the parent must be a live value of exactly this type.
      if (body.parentId !== undefined && body.parentId !== null) {
        const parent = await tx`select 1 from app.dimension_value
                                 where id = ${body.parentId} and dimension_type_id = ${dimensionTypeId}
                                   and archived_at is null`;
        if (parent.length === 0) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `no value ${body.parentId} in dimension type ${dimensionTypeId}`,
          );
        }
      }
      return createDimensionValue(tx, {
        dimensionTypeId,
        ...body,
        nameAr: body.nameAr ?? null,
        parentId: body.parentId ?? null,
      });
    });
    if (id === null)
      throw new AppError(
        "ERR_NOT_FOUND",
        `no dimension type ${dimensionTypeId} in company ${companyId}`,
      );
    return c.json(
      {
        id,
        dimensionTypeId,
        code: body.code,
        nameEn: body.nameEn,
        nameAr: body.nameAr ?? null,
        parentId: body.parentId ?? null,
        archivedAt: null,
      },
      201,
    );
  },
);

dimensionTypesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{dimensionTypeId}/values",
    tags: ["admin"],
    middleware: [manage],
    request: { params: TypeParams, query: DimensionValueQuery },
    responses: {
      200: {
        content: { "application/json": { schema: DimensionValueList } },
        description: "Values",
      },
      ...problem(404),
    },
  }),
  async (c) => {
    const { companyId, dimensionTypeId } = c.req.valid("param");
    const { includeArchived } = c.req.valid("query");
    const items = await c.var.withTenant(async (tx) =>
      (await typeInCompany(tx, companyId, dimensionTypeId))
        ? listDimensionValues(tx, dimensionTypeId, includeArchived)
        : null,
    );
    if (items === null)
      throw new AppError(
        "ERR_NOT_FOUND",
        `no dimension type ${dimensionTypeId} in company ${companyId}`,
      );
    return c.json({ items, next_cursor: null }, 200);
  },
);

dimensionTypesRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{dimensionTypeId}/values/{valueId}",
    tags: ["admin"],
    middleware: [manage],
    request: {
      params: ValueParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdateDimensionValueBody } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: DimensionValueSchema } },
        description: "Updated",
      },
      ...problem(400),
      ...problem(404),
    },
  }),
  async (c) => {
    const { companyId, dimensionTypeId, valueId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      // The join is the gate's other half: `where id = ${valueId}` alone let a caller cleared for
      // one company rename or archive any value in the tenant, because the value carries no company
      // and the path segments above it were never read. Both are predicates now, so a value from
      // another company — or from another type of this company — matches nothing and falls to 404.
      const [updated] = await tx<
        {
          id: string;
          dimension_type_id: string;
          code: string;
          name_en: string;
          name_ar: string | null;
          parent_id: string | null;
          archived_at: string | null;
        }[]
      >`
        update app.dimension_value value set
          name_en = coalesce(${body.nameEn ?? null}, value.name_en),
          name_ar = case when ${body.nameAr === undefined} then value.name_ar else ${body.nameAr ?? null} end,
          archived_at = case
            when ${body.archived === undefined} then value.archived_at
            when ${body.archived === true} then coalesce(value.archived_at, now())
            else null
          end
        from app.dimension_type dimension_type
        where value.id = ${valueId}
          and value.dimension_type_id = ${dimensionTypeId}
          and dimension_type.id = value.dimension_type_id
          and dimension_type.company_id = ${companyId}
        returning value.id, value.dimension_type_id, value.code, value.name_en, value.name_ar,
                  value.parent_id, value.archived_at`;
      return updated;
    });
    if (!row)
      throw new AppError(
        "ERR_NOT_FOUND",
        `no dimension value ${valueId} of type ${dimensionTypeId} in company ${companyId}`,
      );
    return c.json(
      {
        id: row.id,
        dimensionTypeId: row.dimension_type_id,
        code: row.code,
        nameEn: row.name_en,
        nameAr: row.name_ar,
        parentId: row.parent_id,
        archivedAt: row.archived_at,
      },
      200,
    );
  },
);
