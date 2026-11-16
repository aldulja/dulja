import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { v7 as newUuidV7 } from "uuid";
import {
  AppError,
  CompanyList,
  CompanySchema,
  CreateCompanyBody,
  decodeCursor,
  encodeCursor,
  ListQuery,
  ProblemSchema,
  UpdateCompanyBody,
  UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../context";
import { requirePermission } from "../middleware/require-permission";
import { IdempotencyHeader } from "./idempotency-header";

export const companyRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const anyCompany = requirePermission(PERMISSION["admin.company.manage"], { company: "any" });
const thisCompany = requirePermission(PERMISSION["admin.company.manage"], {
  company: "path:companyId",
});

type CompanyRow = {
  id: string;
  code: string;
  name: string;
  base_currency: string;
  timezone: string;
  created_at: Date;
};
const toCompany = (row: CompanyRow) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  baseCurrency: row.base_currency,
  timezone: row.timezone,
  createdAt: row.created_at.toISOString(),
});

type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

/**
 * ADR 0097 (full review PRD-06): the creator administers the company they created. Before it a new company was a
 * shell nobody held a code in — `admin.role.assign` there is needed to assign the first role, and no one had it.
 * The creator gets the tenant's `admin` role at the new company's scope, in the create's own transaction, exactly
 * as `bootstrapOwner` grants the first company's owner: with the tenant's SYSTEM principal as the actor, because
 * `forbid_self_grant` (R5) refuses a principal granting a role to themselves, and the caller's actor is restored
 * straight after (0067's `refresh_pos_cashier` and 0093's swap). It widens nothing the caller could not reach: the
 * gate already admitted them to create companies, and the grant is bounded to the one company this request made.
 * A tenant with no `admin` role (only a test fixture; the roles loader always seeds one) gets the company alone.
 *
 * The rest of the seed's company bootstrap — the chart, document types, templates, tax, reports, statutory packs
 * and the BRANCH dimension — is pack data the serving image deliberately does not carry (infra/Dockerfile), so it
 * stays the seed's (`bun run seed --tenant <id> --only …`); which packs a new company gets is the owner's (OD-21).
 * Its fiscal periods and payroll wiring have routes of their own (`…/fiscal-years`, `…/payroll-accounts`).
 */
async function assignCreatorAdmin(tx: Tx, companyId: string, creatorId: string): Promise<void> {
  const [admin] = await tx<{ id: string }[]>`
    select id::text as id from app.role where tenant_id = app.current_tenant() and code = 'admin'`;
  if (!admin) return;
  const [system] = await tx<{ id: string }[]>`
    select p.id::text as id from app.principal p join app.membership m on m.principal_id = p.id
     where p.kind = 'system' and m.tenant_id = app.current_tenant()`;
  if (!system)
    throw new AppError("ERR_TENANT_CONTEXT_MISSING", "the tenant has no system principal");
  await tx`select set_config('app.actor_id', ${system.id}, true)`;
  await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
           values (app.current_tenant(), ${creatorId}, ${admin.id}, ${companyId})`;
  await tx`select set_config('app.actor_id', ${creatorId}, true)`;
}

companyRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["admin"],
    middleware: [anyCompany] as const,
    summary: "Create a company",
    request: {
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateCompanyBody } } },
    },
    responses: {
      201: {
        description: "The company",
        content: { "application/json": { schema: CompanySchema } },
      },
      400: {
        description: "Invalid",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (context) => {
    const body = context.req.valid("json");
    const id = newUuidV7();
    const row = await context.var.withTenant(async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency, timezone)
               values (${id}, ${context.var.ctx.tenantId}, ${body.code}, ${body.name}, ${body.baseCurrency}, ${body.timezone})`;
      await assignCreatorAdmin(tx, id, context.var.ctx.actorId);
      const [created] = await tx<CompanyRow[]>`
        select id, code, name, base_currency, timezone, created_at from app.company where id = ${id}`;
      return created!;
    });
    return context.json(toCompany(row), 201);
  },
);

companyRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["admin"],
    middleware: [anyCompany] as const,
    summary: "List companies",
    request: { query: ListQuery },
    responses: {
      200: {
        description: "A page of companies",
        content: { "application/json": { schema: CompanyList } },
      },
    },
  }),
  async (context) => {
    const { cursor, limit } = context.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await context.var.withTenant(
      (tx) => tx<CompanyRow[]>`
      select id, code, name, base_currency, timezone, created_at from app.company
       where (${after ? after.id : null}::uuid is null or id > ${after ? after.id : null}::uuid)
       order by id limit ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return context.json({
      items: page.map(toCompany),
      next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.id }) : null,
    });
  },
);

companyRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{companyId}",
    tags: ["admin"],
    middleware: [anyCompany] as const,
    summary: "Read one company",
    request: { params: z.object({ companyId: UuidSchema }) },
    responses: {
      200: {
        description: "The company",
        content: { "application/json": { schema: CompanySchema } },
      },
      404: {
        description: "Not in this tenant",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (context) => {
    const { companyId } = context.req.valid("param");
    const row = await context.var.withTenant(async (tx) => {
      const [found] = await tx<CompanyRow[]>`
        select id, code, name, base_currency, timezone, created_at from app.company where id = ${companyId}`;
      if (!found) throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
      return found;
    });
    return context.json(toCompany(row), 200);
  },
);

companyRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{companyId}",
    tags: ["admin"],
    middleware: [thisCompany] as const,
    summary: "Rename a company or change its timezone",
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema }),
      body: { content: { "application/json": { schema: UpdateCompanyBody } } },
    },
    responses: {
      200: {
        description: "The company",
        content: { "application/json": { schema: CompanySchema } },
      },
      404: {
        description: "Not in this tenant",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (context) => {
    const { companyId } = context.req.valid("param");
    const body = context.req.valid("json");
    const row = await context.var.withTenant(async (tx) => {
      const updated = await tx<CompanyRow[]>`
        update app.company set name = coalesce(${body.name ?? null}, name),
                               timezone = coalesce(${body.timezone ?? null}, timezone)
         where id = ${companyId}
         returning id, code, name, base_currency, timezone, created_at`;
      if (updated.length === 0)
        throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
      return updated[0]!;
    });
    return context.json(toCompany(row), 200);
  },
);

import { einvoiceSettingsRoutes } from "./accounting/einvoice-transmissions";
companyRoutes.route("/", einvoiceSettingsRoutes);
