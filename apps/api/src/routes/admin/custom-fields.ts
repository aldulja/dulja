import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { AppError, PERMISSION, ProblemSchema, UuidSchema } from "@dulja/contracts";
import {
  CreateCustomFieldDefinitionBody,
  CustomFieldDefinitionList,
  CustomFieldDefinitionQuery,
  CustomFieldDefinitionSchema,
  CustomFieldEntitySchema,
  CustomFieldValuesResponse,
  SetCustomFieldValuesBody,
} from "@dulja/contracts/admin/custom-field";
import { createDefinition, getValues, listDefinitions, setValues } from "@dulja/db";
import type { CustomFieldOptions } from "@dulja/domain";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

const CompanyParams = z.object({ companyId: UuidSchema });
const EntityParams = CompanyParams.extend({
  entity: CustomFieldEntitySchema,
  entityId: UuidSchema,
});
const manage = requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" });
const problem = (status: 400 | 404 | 409) => ({
  [status]: {
    content: { "application/problem+json": { schema: ProblemSchema } },
    description: "Problem",
  },
});
async function companyExists(tx: Sql, companyId: string): Promise<boolean> {
  return (await tx`select 1 from app.company where id = ${companyId}`).length > 0;
}
function cleanOptions(
  input:
    | {
        enumValues?: string[] | undefined;
        scale?: number | undefined;
        dimensionTypeId?: string | undefined;
        maxLength?: number | undefined;
      }
    | undefined,
): CustomFieldOptions {
  if (!input) return {};
  return {
    ...(input.enumValues === undefined ? {} : { enumValues: input.enumValues }),
    ...(input.scale === undefined ? {} : { scale: input.scale }),
    ...(input.dimensionTypeId === undefined ? {} : { dimensionTypeId: input.dimensionTypeId }),
    ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }),
  };
}

const validationHook = {
  defaultHook: (result: { success: boolean; error?: unknown }) => {
    if (!result.success) throw result.error;
  },
};
export const customFieldDefinitionsRoutes = new OpenAPIHono<AppEnv>(validationHook);

customFieldDefinitionsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["admin"],
    middleware: [manage],
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateCustomFieldDefinitionBody } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: CustomFieldDefinitionSchema } },
        description: "Created",
      },
      ...problem(400),
      ...problem(409),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const options = cleanOptions(body.options);
    const id = await c.var.withTenant(async (tx) => {
      // Both ids the body may carry are company-scoped rows reached through tenant-wide keys
      // (`custom_field_definition.document_type_id`'s FK is (tenant_id, id); `options.dimensionTypeId`
      // sits in jsonb with no key at all), so the route binds each to the path's company: a definition of
      // company A must not hang off company B's document type or read B's dimension type. 404, never 409,
      // so the answer does not confirm the other company's id exists.
      if (body.documentTypeId !== undefined) {
        const type = await tx`select 1 from app.document_type
                               where id = ${body.documentTypeId} and company_id = ${companyId}`;
        if (type.length === 0) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `no document type ${body.documentTypeId} in company ${companyId}`,
          );
        }
      }
      if (options.dimensionTypeId !== undefined) {
        const dimension = await tx`select 1 from app.dimension_type
                                    where id = ${options.dimensionTypeId} and company_id = ${companyId}`;
        if (dimension.length === 0) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `no dimension type ${options.dimensionTypeId} in company ${companyId}`,
          );
        }
      }
      return createDefinition(tx, {
        companyId,
        entity: body.entity,
        documentTypeId: body.documentTypeId ?? null,
        code: body.code,
        nameEn: body.nameEn,
        nameAr: body.nameAr ?? null,
        kind: body.kind,
        required: body.required ?? false,
        options,
        indexed: body.indexed ?? false,
      });
    });
    return c.json(
      {
        id,
        companyId,
        entity: body.entity,
        documentTypeId: body.documentTypeId ?? null,
        code: body.code,
        nameEn: body.nameEn,
        nameAr: body.nameAr ?? null,
        kind: body.kind,
        required: body.required ?? false,
        options,
        indexed: body.indexed ?? false,
        archivedAt: null,
      },
      201,
    );
  },
);

customFieldDefinitionsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["admin"],
    middleware: [manage],
    request: { params: CompanyParams, query: CustomFieldDefinitionQuery },
    responses: {
      200: {
        content: { "application/json": { schema: CustomFieldDefinitionList } },
        description: "Definitions",
      },
      ...problem(404),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { entity } = c.req.valid("query");
    const items = await c.var.withTenant(async (tx) =>
      (await companyExists(tx, companyId)) ? listDefinitions(tx, companyId, entity) : null,
    );
    if (items === null)
      throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
    return c.json({ items, next_cursor: null }, 200);
  },
);

export const customFieldValuesRoutes = new OpenAPIHono<AppEnv>(validationHook);
customFieldValuesRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{entity}/{entityId}",
    tags: ["admin"],
    middleware: [manage],
    request: {
      params: EntityParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: SetCustomFieldValuesBody } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: CustomFieldValuesResponse } },
        description: "Values",
      },
      ...problem(400),
      ...problem(404),
    },
  }),
  async (c) => {
    const { companyId, entity, entityId } = c.req.valid("param");
    const { values } = c.req.valid("json");
    const result = await c.var.withTenant(async (tx) => {
      const written = await setValues(tx, companyId, entity, entityId, values);
      if (!written.ok) return written;
      return { ok: true as const, values: await getValues(tx, companyId, entity, entityId) };
    });
    if (!result.ok)
      throw new AppError("ERR_VALIDATION_FAILED", "one or more custom field values are invalid", {
        errors: result.errors,
      });
    return c.json({ values: result.values }, 200);
  },
);

customFieldValuesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{entity}/{entityId}",
    tags: ["admin"],
    middleware: [manage],
    request: { params: EntityParams },
    responses: {
      200: {
        content: { "application/json": { schema: CustomFieldValuesResponse } },
        description: "Values",
      },
      ...problem(404),
    },
  }),
  async (c) => {
    const { companyId, entity, entityId } = c.req.valid("param");
    const values = await c.var.withTenant(async (tx) =>
      (await companyExists(tx, companyId)) ? getValues(tx, companyId, entity, entityId) : null,
    );
    if (values === null)
      throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
    return c.json({ values }, 200);
  },
);
