import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { v7 as newUuidV7 } from "uuid";
import {
  AppError,
  CreateRoleBody,
  decodeCursor,
  encodeCursor,
  ListQuery,
  ProblemSchema,
  RoleList,
  RolePermissionsBody,
  RoleSchema,
  UpdateRoleBody,
  UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { incompatiblePairsIn, missingAtTenantScope, missingCeilingAtTenantScope } from "@dulja/db";
import type { Sql } from "postgres";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

export const roleRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
/**
 * The route gate admits a holder of `admin.role.manage` in any company — enough to LIST roles. A write is held to
 * ADR 0091's tenant scope in the handler (`assertTenantScope`): a role is a tenant-wide row, so a change reaches
 * every company where it is assigned (2026-11-15 review, API-03).
 */
const gate = requirePermission(PERMISSION["admin.role.manage"], { company: "any" });

async function assertTenantScope(tx: Sql, actorId: string, codes: readonly string[]) {
  const missing = await missingAtTenantScope(tx, codes);
  if (missing.length > 0)
    throw new AppError(
      "ERR_RBAC_FORBIDDEN",
      `principal ${actorId} lacks ${missing.join(", ")} in a company of this tenant that has role holders`,
    );
}

/** 404 for an id this tenant does not hold; 409 for a system role, which changes only by migration (spec:2152). */
async function assertCustomRole(tx: Sql, roleId: string) {
  const [role] = await tx<{ is_system: boolean }[]>`
    select is_system from app.role where id = ${roleId}`;
  if (!role) throw new AppError("ERR_NOT_FOUND", `no role ${roleId} in this tenant`);
  if (role.is_system)
    throw new AppError(
      "ERR_RBAC_SYSTEM_ROLE",
      `role ${roleId} is a system role; clone it into a custom role to change it`,
    );
}

type RoleRow = {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  description: string | null;
  is_system: boolean;
  created_at: Date;
  permissions: string[];
};

const toRole = (row: RoleRow) => ({
  id: row.id,
  code: row.code,
  nameEn: row.name_en,
  nameAr: row.name_ar,
  description: row.description,
  isSystem: row.is_system,
  permissions: row.permissions,
  createdAt: row.created_at.toISOString(),
});

roleRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["admin"],
    middleware: [gate] as const,
    summary: "Create a role",
    request: {
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateRoleBody } } },
    },
    responses: {
      201: { description: "The role", content: { "application/json": { schema: RoleSchema } } },
      409: {
        description: "Duplicate code",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (context) => {
    const body = context.req.valid("json");
    const id = newUuidV7();
    const row = await context.var.withTenant(async (tx) => {
      await assertTenantScope(tx, context.var.ctx.actorId, [PERMISSION["admin.role.manage"]]);
      await tx`insert into app.role (id, tenant_id, code, name_en, name_ar, description)
               values (${id}, ${context.var.ctx.tenantId}, ${body.code}, ${body.nameEn}, ${body.nameAr ?? null}, ${body.description ?? null})`;
      const [created] = await tx<Omit<RoleRow, "permissions">[]>`
        select id, code, name_en, name_ar, description, is_system, created_at from app.role where id = ${id}`;
      return created!;
    });
    return context.json(toRole({ ...row, permissions: [] }), 201);
  },
);

roleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["admin"],
    middleware: [gate] as const,
    summary: "List roles",
    request: { query: ListQuery },
    responses: {
      200: {
        description: "A page of roles",
        content: { "application/json": { schema: RoleList } },
      },
    },
  }),
  async (context) => {
    const { cursor, limit } = context.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await context.var.withTenant(
      (tx) => tx<RoleRow[]>`
      select r.id, r.code, r.name_en, r.name_ar, r.description, r.is_system, r.created_at,
             coalesce(array_agg(rp.permission_code order by rp.permission_code)
                      filter (where rp.permission_code is not null), '{}') as permissions
        from app.role r left join app.role_permission rp on rp.role_id = r.id
       where (${after ? after.id : null}::uuid is null or r.id > ${after ? after.id : null}::uuid)
       group by r.id order by r.id limit ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return context.json({
      items: page.map(toRole),
      next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.id }) : null,
    });
  },
);

roleRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{roleId}",
    tags: ["admin"],
    middleware: [gate] as const,
    summary: "Rename a role",
    request: {
      headers: IdempotencyHeader,
      params: z.object({ roleId: UuidSchema }),
      body: { content: { "application/json": { schema: UpdateRoleBody } } },
    },
    responses: {
      200: { description: "The role", content: { "application/json": { schema: RoleSchema } } },
      403: {
        description: "The caller does not hold admin.role.manage at tenant scope",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "No such role",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "A system role, which changes only by migration",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (context) => {
    const { roleId } = context.req.valid("param");
    const body = context.req.valid("json");
    const row = await context.var.withTenant(async (tx) => {
      await assertTenantScope(tx, context.var.ctx.actorId, [PERMISSION["admin.role.manage"]]);
      await assertCustomRole(tx, roleId);
      const updated = await tx<Omit<RoleRow, "permissions">[]>`
        update app.role set
          name_en = coalesce(${body.nameEn ?? null}, name_en),
          name_ar = coalesce(${body.nameAr ?? null}, name_ar),
          description = coalesce(${body.description ?? null}, description)
         where id = ${roleId}
         returning id, code, name_en, name_ar, description, is_system, created_at`;
      if (updated.length === 0)
        throw new AppError("ERR_NOT_FOUND", `no role ${roleId} in this tenant`);
      const permissions = await tx<{ permission_code: string }[]>`
        select permission_code from app.role_permission where role_id = ${roleId} order by 1`;
      return { ...updated[0]!, permissions: permissions.map((item) => item.permission_code) };
    });
    return context.json(toRole(row), 200);
  },
);

roleRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{roleId}/permissions",
    tags: ["admin"],
    middleware: [gate] as const,
    summary: "Replace the permissions a role grants",
    request: {
      headers: IdempotencyHeader,
      params: z.object({ roleId: UuidSchema }),
      body: { content: { "application/json": { schema: RolePermissionsBody } } },
    },
    responses: {
      200: { description: "The role", content: { "application/json": { schema: RoleSchema } } },
      403: {
        description:
          "The caller does not hold admin.role.manage, or a code being added, at tenant scope (ADR 0091)",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "No such role",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description:
          "A system role, an incompatible pair (R6), self-escalation, last admin, or an unknown code",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (context) => {
    const { roleId } = context.req.valid("param");
    const { permissions } = context.req.valid("json");
    const row = await context.var.withTenant(async (tx) => {
      const actorId = context.var.ctx.actorId;
      await assertTenantScope(tx, actorId, [PERMISSION["admin.role.manage"]]);
      await assertCustomRole(tx, roleId);
      // The ceiling (ADR 0091): every code ADDED must be one the caller holds at tenant scope. A code outside the
      // catalogue is left to role_permission's foreign key, which answers ERR_CONFLICT_REFERENCE as before.
      const added = await tx<{ code: string }[]>`
        select p.code from app.permission p
         where p.code = any(${permissions}::text[])
           and not exists (select 1 from app.role_permission rp
                            where rp.role_id = ${roleId} and rp.permission_code = p.code)`;
      const missing = await missingCeilingAtTenantScope(
        tx,
        added.map((item) => item.code),
      );
      if (missing.length > 0)
        throw new AppError(
          "ERR_RBAC_FORBIDDEN",
          `principal ${actorId} cannot give a role ${missing.join(", ")}: it lacks them in a company of this tenant that has role holders`,
        );
      const pairs = incompatiblePairsIn(permissions);
      if (pairs.length > 0)
        throw new AppError(
          "ERR_RBAC_INCOMPATIBLE_PAIR",
          `a role may not hold both ${pairs.map(([left, right]) => `${left} and ${right}`).join("; nor ")} (R6)`,
        );
      await tx`delete from app.role_permission where role_id = ${roleId}
                and permission_code <> all(${permissions}::text[])`;
      for (const code of permissions)
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                 values (${context.var.ctx.tenantId}, ${roleId}, ${code}) on conflict do nothing`;
      const [updated] = await tx<Omit<RoleRow, "permissions">[]>`
        select id, code, name_en, name_ar, description, is_system, created_at from app.role where id = ${roleId}`;
      const current = await tx<{ permission_code: string }[]>`
        select permission_code from app.role_permission where role_id = ${roleId} order by 1`;
      return { ...updated!, permissions: current.map((item) => item.permission_code) };
    });
    return context.json(toRole(row), 200);
  },
);
