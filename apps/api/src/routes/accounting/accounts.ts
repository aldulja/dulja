import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { v7 as newUuidV7 } from "uuid";
import { AppError, decodeCursor, encodeCursor, ProblemSchema, UuidSchema } from "@dulja/contracts";
import {
  AccountList,
  AccountQuery,
  AccountSchema,
  AccountTree,
  CreateAccountBody,
  UpdateAccountBody,
} from "@dulja/contracts/accounting/account";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../../context";
import { membershipOnly, requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

export const accountRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
/** Writes need the code; reads need membership only — the 0D precedent for dimensions (contracts §4.2.11)
 *  and the reading spec:2158 forces, since the catalogue has no accounts read code (§3.6.1 is closed). */
const manage = requirePermission(PERMISSION["accounting.account.manage"], {
  company: "path:companyId",
});

/** `type::text` can only be one of the five labels of `app.account_type`, so it is typed as the union the
 *  response schema declares rather than widened to `string` and cast back at the edge. */
type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
interface Row {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  type: AccountType;
  parent_id: string | null;
  is_group: boolean;
  currency: string | null;
  archived_at: Date | null;
  created_at: Date;
}
const toAccount = (row: Row) => ({
  id: row.id,
  code: row.code,
  nameEn: row.name_en,
  nameAr: row.name_ar,
  type: row.type,
  parentId: row.parent_id,
  isGroup: row.is_group,
  currency: row.currency,
  archivedAt: row.archived_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});
/** A postgres.js fragment, not a string: a nested tagged template composes safely and never reaches
 *  `sql.unsafe`, which contracts §3.3 confines to three homes, none of them a route file. */
const columns = (tx: Sql) =>
  tx`id, code, name_en, name_ar, type::text as type, parent_id, is_group, currency, archived_at, created_at`;

accountRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["accounting"],
    middleware: [manage] as const,
    summary: "Create an account",
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateAccountBody } } },
    },
    responses: {
      201: {
        description: "The account",
        content: { "application/json": { schema: AccountSchema } },
      },
      404: {
        description: "Parent not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "Code already used",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const id = newUuidV7();
    const row = await c.var.withTenant(async (tx) => {
      if (body.parentId) {
        const [parent] = await tx<{ id: string }[]>`
          select id from app.account where id = ${body.parentId} and company_id = ${companyId}`;
        if (!parent) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `no account ${body.parentId} in company ${companyId}`,
          );
        }
      }
      await tx`insert into app.account (id, tenant_id, company_id, code, name_en, name_ar, type, parent_id, is_group, currency)
               values (${id}, ${c.var.ctx.tenantId}, ${companyId}, ${body.code}, ${body.nameEn}, ${body.nameAr ?? null},
                       ${body.type}::app.account_type, ${body.parentId ?? null}, ${body.isGroup}, ${body.currency ?? null})`;
      const [created] = await tx<Row[]>`select ${columns(tx)} from app.account where id = ${id}`;
      return created!;
    });
    return c.json(toAccount(row), 201);
  },
);

accountRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["accounting"],
    middleware: [membershipOnly()] as const,
    summary: "List accounts (membership only)",
    request: { params: z.object({ companyId: UuidSchema }), query: AccountQuery },
    responses: {
      200: {
        description: "A page of accounts",
        content: { "application/json": { schema: AccountList } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { cursor, limit, type, includeArchived } = c.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await c.var.withTenant(
      (tx) => tx<Row[]>`
      select ${columns(tx)} from app.account
       where company_id = ${companyId}
         and (${includeArchived} or archived_at is null)
         and (${type ?? null}::text is null or type::text = ${type ?? null})
         and (${after ? after.id : null}::uuid is null or id > ${after ? after.id : null}::uuid)
       order by id limit ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page.map(toAccount),
        next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.id }) : null,
      },
      200,
    );
  },
);

accountRoutes.openapi(
  createRoute({
    method: "get",
    path: "/tree",
    tags: ["accounting"],
    middleware: [membershipOnly()] as const,
    summary: "The chart as a tree, in one recursive CTE (SAH-071)",
    request: { params: z.object({ companyId: UuidSchema }) },
    responses: {
      200: {
        description: "Every account with its depth and code path",
        content: { "application/json": { schema: AccountTree } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    // One statement for the whole tree. SAH-071 is the legacy system running a recursive check per row inside
    // a trigger; the depth cap is a belt-and-braces guard, since the PATCH handler already refuses a cycle.
    const rows = await c.var.withTenant(
      (tx) => tx<(Row & { depth: number; path: string[] })[]>`
      with recursive node as (
        select a.*, 0 as depth, array[a.code] as path
          from app.account a
         where a.company_id = ${companyId} and a.parent_id is null and a.archived_at is null
        union all
        select a.*, n.depth + 1, n.path || a.code
          from app.account a join node n on a.parent_id = n.id
         where a.company_id = ${companyId} and a.archived_at is null and n.depth < 32
      )
      select id, code, name_en, name_ar, type::text as type, parent_id, is_group, currency, archived_at,
             created_at, depth, path
        from node order by path`,
    );
    return c.json(
      {
        items: rows.map((row) => ({ ...toAccount(row), depth: row.depth, path: row.path })),
      },
      200,
    );
  },
);

accountRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{accountId}",
    tags: ["accounting"],
    middleware: [manage] as const,
    summary: "Rename or re-parent an account",
    request: {
      params: z.object({ companyId: UuidSchema, accountId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdateAccountBody } } },
    },
    responses: {
      200: {
        description: "The account",
        content: { "application/json": { schema: AccountSchema } },
      },
      400: {
        description: "Cycle",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, accountId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      if (body.parentId) {
        if (body.parentId === accountId) {
          throw new AppError(
            "ERR_VALIDATION_FAILED",
            `account ${accountId} cannot be its own parent`,
          );
        }
        // Same check as POST: the FK is (tenant_id, parent_id), so without it an account of ANOTHER company
        // in the tenant is accepted as the parent, the cycle CTE below (filtered to this company) finds no
        // rows, and the account vanishes from this company's tree while still holding balances.
        const [parent] = await tx<{ id: string }[]>`
          select id from app.account where id = ${body.parentId} and company_id = ${companyId}`;
        if (!parent) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `no account ${body.parentId} in company ${companyId}`,
          );
        }
        const [cycle] = await tx<{ n: number }[]>`
          with recursive up as (
            select id, parent_id, 0 as depth from app.account where id = ${body.parentId} and company_id = ${companyId}
            union all
            select a.id, a.parent_id, up.depth + 1 from app.account a join up on a.id = up.parent_id where up.depth < 32
          ) select count(*)::int as n from up where id = ${accountId}`;
        if (cycle!.n > 0) {
          throw new AppError(
            "ERR_VALIDATION_FAILED",
            `making ${body.parentId} the parent of ${accountId} would create a cycle`,
          );
        }
      }
      const updated = await tx<Row[]>`
        update app.account
           set name_en   = coalesce(${body.nameEn ?? null}, name_en),
               name_ar   = case when ${body.nameAr === undefined} then name_ar else ${body.nameAr ?? null} end,
               parent_id = case when ${body.parentId === undefined} then parent_id else ${body.parentId ?? null} end,
               currency  = case when ${body.currency === undefined} then currency else ${body.currency ?? null} end
         where id = ${accountId} and company_id = ${companyId}
        returning ${columns(tx)}`;
      if (updated.length === 0) {
        throw new AppError("ERR_NOT_FOUND", `no account ${accountId} in company ${companyId}`);
      }
      return updated[0]!;
    });
    return c.json(toAccount(row), 200);
  },
);

accountRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{accountId}/archive",
    tags: ["accounting"],
    middleware: [manage] as const,
    summary: "Archive an account — accounts are never deleted (spec:2049, SAH-021)",
    request: {
      params: z.object({ companyId: UuidSchema, accountId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: z.object({}) } } },
    },
    responses: {
      200: {
        description: "The archived account",
        content: { "application/json": { schema: AccountSchema } },
      },
      404: {
        description: "Not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, accountId } = c.req.valid("param");
    const row = await c.var.withTenant(async (tx) => {
      const updated = await tx<Row[]>`
        update app.account set archived_at = coalesce(archived_at, now())
         where id = ${accountId} and company_id = ${companyId}
        returning ${columns(tx)}`;
      if (updated.length === 0) {
        throw new AppError("ERR_NOT_FOUND", `no account ${accountId} in company ${companyId}`);
      }
      return updated[0]!;
    });
    return c.json(toAccount(row), 200);
  },
);
