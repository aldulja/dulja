import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { v7 as newUuidV7 } from "uuid";
import {
  AppError,
  decodeCursor,
  encodeCursor,
  InviteUserBody,
  ProblemSchema,
  UserList,
  UserQuery,
  UserSchema,
  UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import type { AuthAdmin } from "../../ports";
import { IdempotencyHeader } from "../idempotency-header";

export function createUserRoutes(authAdmin: AuthAdmin): OpenAPIHono<AppEnv> {
  const users = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });
  const gate = requirePermission(PERMISSION["admin.user.manage"], { company: "any" });

  users.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["admin"],
      middleware: [gate] as const,
      summary: "Invite a person to this tenant",
      request: {
        headers: IdempotencyHeader,
        body: { content: { "application/json": { schema: InviteUserBody } } },
      },
      responses: {
        201: {
          description: "The principal",
          content: { "application/json": { schema: UserSchema } },
        },
        409: {
          description: "Already a member",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
      },
    }),
    async (context) => {
      const { email, displayName } = context.req.valid("json");
      // The provider is asked only once this tenant is known not to hold the address already. Inviting
      // first and letting app.principal.auth_subject's UNIQUE constraint answer meant the invitation mail
      // had already been sent when the 409 was raised, with no principal and no membership to show for it
      // and nothing that reconciles the two. Repeated with fresh idempotency keys and fresh addresses,
      // that is unbounded mail to arbitrary third parties from the project's verified sender.
      //
      // The check is tenant-local by construction: `principal_in_tenant` admits only rows this tenant has
      // a membership for, and app.membership.principal_id is UNIQUE, so a principal belongs to exactly
      // one tenant. An address another tenant already holds still reaches the provider before the
      // constraint answers. The constraint remains the arbiter, not this read — two concurrent
      // invitations of one address both pass it.
      const held = await context.var.withTenant(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          select p.id from app.principal p
            join app.membership m on m.principal_id = p.id and m.tenant_id = ${context.var.ctx.tenantId}
           where lower(p.email) = lower(${email})`;
        return row ?? null;
      });
      if (held)
        throw new AppError(
          "ERR_CONFLICT_UNIQUE",
          `${email} already belongs to a principal in this tenant`,
        );
      const invited = await authAdmin.inviteUser(email);
      const id = newUuidV7();
      const created = await context.var.withTenant(async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, email, display_name)
                 values (${id}, 'human', ${invited.sub}, ${invited.email}, ${displayName})`;
        await tx`insert into app.membership (tenant_id, principal_id)
                 values (${context.var.ctx.tenantId}, ${id})`;
        const [row] = await tx<
          {
            id: string;
            display_name: string;
            email: string | null;
            kind: "human";
            created_at: Date;
          }[]
        >`select id, display_name, email, kind, created_at from app.principal where id = ${id}`;
        return row!;
      });
      return context.json(
        {
          id: created.id,
          displayName: created.display_name,
          email: created.email,
          kind: created.kind,
          createdAt: created.created_at.toISOString(),
          activeAssignments: 0,
        },
        201,
      );
    },
  );

  users.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["admin"],
      middleware: [gate] as const,
      summary: "List the people who may use this tenant",
      request: { query: UserQuery },
      responses: {
        200: {
          description: "A page of principals",
          content: { "application/json": { schema: UserList } },
        },
      },
    }),
    async (context) => {
      const { cursor, limit, kind } = context.req.valid("query");
      const after = cursor ? decodeCursor(cursor) : null;
      const rows = await context.var.withTenant(
        (tx) => tx<
          {
            id: string;
            display_name: string;
            email: string | null;
            kind: "human" | "system" | "terminal";
            created_at: Date;
            created_at_text: string;
            active_assignments: number;
          }[]
        >`
        select p.id, p.display_name, p.email, p.kind, p.created_at,
               -- The keyset travels as Postgres' own text, and the WHERE clause below casts it
               -- text -> timestamptz in two steps. Both halves matter: toISOString() kept only
               -- milliseconds, and a parameter written directly as $n::timestamptz is typed as
               -- timestamptz by postgres.js, which serialises it through its Date path and truncates
               -- microseconds just the same. Either way the cursor landed before rows it had already
               -- passed, and rows written in one transaction share created_at exactly.
               p.created_at::text as created_at_text,
               (select count(*)::int from app.role_assignment ra
                 where ra.principal_id = p.id and (ra.expires_at is null or ra.expires_at > now())) as active_assignments
          from app.principal p
          join app.membership m on m.principal_id = p.id and m.tenant_id = ${context.var.ctx.tenantId}
         where (${kind ?? null}::text is null or p.kind::text = ${kind ?? null})
           and (${after ? String(after.k[0]) : null}::text is null
                or (p.created_at, p.id) < (${after ? String(after.k[0]) : null}::text::timestamptz, ${after?.id ?? null}::uuid))
         order by p.created_at desc, p.id desc
         limit ${limit + 1}`,
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return context.json({
        items: page.map((row) => ({
          id: row.id,
          displayName: row.display_name,
          email: row.email,
          kind: row.kind,
          createdAt: row.created_at.toISOString(),
          activeAssignments: row.active_assignments,
        })),
        next_cursor:
          rows.length > limit && last
            ? encodeCursor({ k: [last.created_at_text], id: last.id })
            : null,
      });
    },
  );

  users.openapi(
    createRoute({
      method: "post",
      path: "/{userId}/expire",
      tags: ["admin"],
      middleware: [gate] as const,
      summary: "End a person's access while keeping the principal",
      request: { headers: IdempotencyHeader, params: z.object({ userId: UuidSchema }) },
      responses: {
        200: {
          description:
            "How many assignments were expired — those in companies where the caller holds admin.user.manage",
          content: {
            "application/json": {
              schema: z.object({ id: UuidSchema, expiredAssignments: z.number().int() }),
            },
          },
        },
        404: {
          description: "No such principal in this tenant",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
        409: {
          description: "The last administrator",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
      },
    }),
    async (context) => {
      const { userId } = context.req.valid("param");
      const expired = await context.var.withTenant(async (tx) => {
        const [member] = await tx<{ id: string }[]>`
          select p.id from app.principal p
            join app.membership m on m.principal_id = p.id and m.tenant_id = ${context.var.ctx.tenantId}
           where p.id = ${userId}`;
        if (!member) throw new AppError("ERR_NOT_FOUND", `no principal ${userId} in this tenant`);
        // ADR 0091 (2026-11-15 review, API-08): only the assignments in companies where the caller holds
        // admin.user.manage. The gate admits a holder in ANY company; without this filter an administrator of
        // company A ended the user's roles in company B too, past B's own admin.role.assign gate.
        const rows = await tx<{ principal_id: string }[]>`
          update app.role_assignment set expires_at = now()
           where principal_id = ${userId} and (expires_at is null or expires_at > now())
             and app.actor_has(${PERMISSION["admin.user.manage"]}, company_id)
           returning principal_id`;
        return rows.length;
      });
      return context.json({ id: userId, expiredAssignments: expired }, 200);
    },
  );

  return users;
}
