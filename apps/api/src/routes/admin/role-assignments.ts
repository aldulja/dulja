import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  CreateRoleAssignmentBody,
  decodeCursor,
  encodeCursor,
  ProblemSchema,
  RoleAssignmentBranchBody,
  RoleAssignmentList,
  RoleAssignmentQuery,
  RoleAssignmentSchema,
  UuidSchema,
} from "@dulja/contracts";
import type { Sql } from "postgres";
import { PERMISSION } from "@dulja/contracts/permissions";
import { missingCeilingForAssignment } from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

export const roleAssignmentRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const gate = requirePermission(PERMISSION["admin.role.assign"], { company: "path:companyId" });
const Key = z.object({ companyId: UuidSchema, principalId: UuidSchema, roleId: UuidSchema });

type AssignmentRow = {
  principal_id: string;
  role_id: string;
  company_id: string;
  granted_by: string;
  granted_at: Date;
  /** `granted_at::text` — microsecond-exact, for the keyset cursor; an ISO string would lose precision. */
  granted_at_text: string;
  expires_at: Date | null;
  branch_ids: string[];
};

/**
 * Every branch id must be a live value of THIS company's BRANCH dimension type. `role_assignment_branch_dim_fk`
 * is `(tenant_id, branch_id) → dimension_value(tenant_id, id)`, tenant-wide, so without this a caller holding
 * `admin.role.assign` in company A could restrict — and so grant — an assignment to a branch of company B, or
 * to a cost-centre value that is no branch at all; `actor_has(code, A, V)` then answers true for a document
 * carrying that id. 404 like the document routes' branch check: an id the caller may not see is not
 * confirmed to exist by a 409.
 */
async function assertBranchesBelong(
  tx: Sql,
  companyId: string,
  branchIds: readonly string[],
): Promise<void> {
  const wanted = [...new Set(branchIds)];
  if (wanted.length === 0) return;
  const found = await tx<{ id: string }[]>`
    select v.id from app.dimension_value v
      join app.dimension_type t on t.id = v.dimension_type_id
     where v.id = any(${wanted}::uuid[]) and t.company_id = ${companyId} and t.code = 'BRANCH'
       and v.archived_at is null`;
  const live = new Set(found.map((row) => row.id));
  const missing = wanted.find((id) => !live.has(id));
  if (missing !== undefined) {
    throw new AppError("ERR_NOT_FOUND", `no branch ${missing} in company ${companyId}`);
  }
}

/**
 * ADR 0091's assignment ceiling (2026-11-15 review, API-09): the assigner must hold every code of the role at the
 * scope the assignment grants — company-wide with no branch rows, else at each branch. Without it two holders of
 * `admin.role.assign` could hand each other `admin`. The till's own codes are exempt (`isCeilingExempt`).
 */
async function assertWithinCeiling(
  tx: Sql,
  actorId: string,
  roleId: string,
  companyId: string,
  branchIds: readonly string[],
): Promise<void> {
  const missing = await missingCeilingForAssignment(tx, roleId, companyId, branchIds);
  if (missing.length > 0)
    throw new AppError(
      "ERR_RBAC_FORBIDDEN",
      `principal ${actorId} cannot assign role ${roleId}: it does not hold ${missing.join(", ")} at that scope in company ${companyId}`,
    );
}

const toAssignment = (row: AssignmentRow) => ({
  principalId: row.principal_id,
  roleId: row.role_id,
  companyId: row.company_id,
  grantedBy: row.granted_by,
  grantedAt: row.granted_at.toISOString(),
  expiresAt: row.expires_at?.toISOString() ?? null,
  branchIds: row.branch_ids,
});

roleAssignmentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["admin"],
    middleware: [gate] as const,
    summary: "Assign a role in this company, optionally restricted to branches",
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema }),
      body: { content: { "application/json": { schema: CreateRoleAssignmentBody } } },
    },
    responses: {
      201: {
        description: "The assignment",
        content: { "application/json": { schema: RoleAssignmentSchema } },
      },
      409: {
        description: "Self-grant, wrong kind, or an unknown principal or role",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description: "The role holds a code the caller lacks at that scope (ADR 0091)",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (context) => {
    const { companyId } = context.req.valid("param");
    const body = context.req.valid("json");
    const row = await context.var.withTenant(async (tx) => {
      const [member] = await tx<{ principal_id: string }[]>`
        select principal_id from app.membership where principal_id = ${body.principalId}`;
      if (!member)
        throw new AppError(
          "ERR_CONFLICT_REFERENCE",
          `no principal ${body.principalId} in this tenant`,
        );
      await assertBranchesBelong(tx, companyId, body.branchIds ?? []);
      await assertWithinCeiling(
        tx,
        context.var.ctx.actorId,
        body.roleId,
        companyId,
        body.branchIds ?? [],
      );
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id, expires_at)
               values (${context.var.ctx.tenantId}, ${body.principalId}, ${body.roleId}, ${companyId}, ${body.expiresAt ?? null})`;
      for (const branchId of body.branchIds ?? [])
        await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
                 values (${context.var.ctx.tenantId}, ${body.principalId}, ${body.roleId}, ${companyId}, ${branchId})`;
      return readOne(tx, companyId, body.principalId, body.roleId);
    });
    return context.json(toAssignment(row), 201);
  },
);

roleAssignmentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["admin"],
    middleware: [gate] as const,
    summary: "List this company's assignments",
    request: { params: z.object({ companyId: UuidSchema }), query: RoleAssignmentQuery },
    responses: {
      200: {
        description: "A page of assignments",
        content: { "application/json": { schema: RoleAssignmentList } },
      },
    },
  }),
  async (context) => {
    const { companyId } = context.req.valid("param");
    const { limit, principalId, cursor } = context.req.valid("query");
    // Keyset on the declared sort (granted_at desc, principal_id desc, role_id desc) — the route advertised
    // `cursor` through ListQuery and answered `next_cursor: null` regardless, so a company with more
    // assignments than `limit` could never see the rest (§4.2.8). The cursor carries `granted_at::text`, not
    // an ISO string: timestamptz is microsecond-exact and a millisecond cursor would skip or repeat rows.
    const after = cursor ? decodeCursor(cursor) : null;
    const afterAt = after ? String(after.k[0]) : null;
    const afterPrincipal = after ? String(after.k[1]) : null;
    const afterRole = after?.id ?? null;
    const rows = await context.var.withTenant(
      (tx) => tx<AssignmentRow[]>`
      select ra.principal_id, ra.role_id, ra.company_id, ra.granted_by, ra.granted_at,
             ra.granted_at::text as granted_at_text, ra.expires_at,
             coalesce(array_agg(b.branch_id) filter (where b.branch_id is not null), '{}') as branch_ids
        from app.role_assignment ra
        left join app.role_assignment_branch b
          on b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id
       where ra.company_id = ${companyId}
         and (${principalId ?? null}::uuid is null or ra.principal_id = ${principalId ?? null}::uuid)
         and (${afterAt}::text is null
              or (ra.granted_at, ra.principal_id, ra.role_id)
                 < (${afterAt}::timestamptz, ${afterPrincipal}::uuid, ${afterRole}::uuid))
       group by ra.principal_id, ra.role_id, ra.company_id, ra.granted_by, ra.granted_at, ra.expires_at
       order by ra.granted_at desc, ra.principal_id desc, ra.role_id desc limit ${limit}`,
    );
    const last = rows.at(-1);
    return context.json({
      items: rows.map(toAssignment),
      next_cursor:
        rows.length === limit && last
          ? encodeCursor({ k: [last.granted_at_text, last.principal_id], id: last.role_id })
          : null,
    });
  },
);

roleAssignmentRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{principalId}/{roleId}/branches",
    tags: ["admin"],
    middleware: [gate] as const,
    summary: "Replace the branch rows of one assignment",
    request: {
      headers: IdempotencyHeader,
      params: Key,
      body: { content: { "application/json": { schema: RoleAssignmentBranchBody } } },
    },
    responses: {
      200: {
        description: "The assignment",
        content: { "application/json": { schema: RoleAssignmentSchema } },
      },
      404: {
        description: "No such assignment",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (context) => {
    const { companyId, principalId, roleId } = context.req.valid("param");
    const { branchIds } = context.req.valid("json");
    const row = await context.var.withTenant(async (tx) => {
      const [assignment] = await tx<{ principal_id: string }[]>`
        select principal_id from app.role_assignment
         where principal_id = ${principalId} and role_id = ${roleId} and company_id = ${companyId}`;
      if (!assignment)
        throw new AppError(
          "ERR_NOT_FOUND",
          `no assignment of role ${roleId} to principal ${principalId} in company ${companyId}`,
        );
      await assertBranchesBelong(tx, companyId, branchIds);
      await assertWithinCeiling(tx, context.var.ctx.actorId, roleId, companyId, branchIds);
      await tx`delete from app.role_assignment_branch
                where principal_id = ${principalId} and role_id = ${roleId} and company_id = ${companyId}`;
      for (const branchId of branchIds)
        await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
                 values (${context.var.ctx.tenantId}, ${principalId}, ${roleId}, ${companyId}, ${branchId})`;
      return readOne(tx, companyId, principalId, roleId);
    });
    return context.json(toAssignment(row), 200);
  },
);

roleAssignmentRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{principalId}/{roleId}",
    tags: ["admin"],
    middleware: [gate] as const,
    summary: "End an assignment without deleting it",
    request: { headers: IdempotencyHeader, params: Key },
    responses: {
      200: {
        description: "The expired assignment",
        content: { "application/json": { schema: RoleAssignmentSchema } },
      },
      409: {
        description: "The last administrator",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (context) => {
    const { companyId, principalId, roleId } = context.req.valid("param");
    const row = await context.var.withTenant(async (tx) => {
      const updated = await tx<{ principal_id: string }[]>`
        update app.role_assignment set expires_at = now()
         where principal_id = ${principalId} and role_id = ${roleId} and company_id = ${companyId}
         returning principal_id`;
      if (updated.length === 0)
        throw new AppError(
          "ERR_NOT_FOUND",
          `no assignment of role ${roleId} to principal ${principalId} in company ${companyId}`,
        );
      return readOne(tx, companyId, principalId, roleId);
    });
    return context.json(toAssignment(row), 200);
  },
);

type TenantTx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];
async function readOne(
  tx: TenantTx,
  companyId: string,
  principalId: string,
  roleId: string,
): Promise<AssignmentRow> {
  const [row] = await tx<AssignmentRow[]>`
    select ra.principal_id, ra.role_id, ra.company_id, ra.granted_by, ra.granted_at, ra.granted_at::text as granted_at_text, ra.expires_at,
           coalesce(array_agg(b.branch_id) filter (where b.branch_id is not null), '{}') as branch_ids
      from app.role_assignment ra
      left join app.role_assignment_branch b
        on b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id
     where ra.principal_id = ${principalId} and ra.role_id = ${roleId} and ra.company_id = ${companyId}
     group by ra.principal_id, ra.role_id, ra.company_id, ra.granted_by, ra.granted_at, ra.expires_at`;
  if (!row)
    throw new AppError(
      "ERR_NOT_FOUND",
      `no assignment of role ${roleId} to principal ${principalId} in company ${companyId}`,
    );
  return row;
}
