import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  decodeCursor,
  encodeCursor,
  PERMISSION,
  ProblemSchema,
  UuidSchema,
} from "@dulja/contracts";
import {
  CreateCurrencyBody,
  CurrencyList,
  CurrencyQuery,
  CurrencySchema,
  UpdateCurrencyBody,
} from "@dulja/contracts/admin/currency";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

export const currenciesRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

interface Row {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  minor_units: number;
  pos_rounding_increment: string;
  rounding_mode: "HALF_AWAY_FROM_ZERO" | "HALF_EVEN" | "TOWARD_ZERO" | "AWAY_FROM_ZERO";
  archived_at: string | null;
}
const toJson = (row: Row) => ({
  id: row.id,
  code: row.code,
  nameEn: row.name_en,
  nameAr: row.name_ar,
  minorUnits: row.minor_units,
  posRoundingIncrement: row.pos_rounding_increment,
  roundingMode: row.rounding_mode,
  archivedAt: row.archived_at,
});
const problem = (status: 400 | 404 | 409) => ({
  [status]: {
    content: { "application/problem+json": { schema: ProblemSchema } },
    description: "Problem",
  },
});
/**
 * `app.currency` is keyed by tenant, not company — the writes take a `companyId` from the body only
 * to name a company the caller must administer. The list has no body and no path company, so the
 * question it can ask is the tenant-wide one: does this principal administer ANY company here.
 */
const listGate = requirePermission(PERMISSION["admin.company.manage"], { company: "any" });

currenciesRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["admin"],
    middleware: [
      requirePermission(PERMISSION["admin.company.manage"], { company: "body:companyId" }),
    ],
    request: {
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateCurrencyBody } } },
    },
    responses: {
      201: { content: { "application/json": { schema: CurrencySchema } }, description: "Created" },
      ...problem(400),
      ...problem(409),
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const [created] = await tx<Row[]>`
        insert into app.currency
          (tenant_id, code, name_en, name_ar, minor_units, pos_rounding_increment, rounding_mode)
        values
          (${c.var.ctx.tenantId}, ${body.code}, ${body.nameEn}, ${body.nameAr ?? null},
           ${body.minorUnits ?? 2}, ${body.posRoundingIncrement ?? "0.0100"},
           ${body.roundingMode ?? "HALF_AWAY_FROM_ZERO"})
        returning id, code, name_en, name_ar, minor_units,
                  pos_rounding_increment::text, rounding_mode, archived_at`;
      return created!;
    });
    return c.json(toJson(row), 201);
  },
);

currenciesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["admin"],
    middleware: [listGate],
    request: { query: CurrencyQuery },
    responses: {
      200: { content: { "application/json": { schema: CurrencyList } }, description: "Currencies" },
    },
  }),
  async (c) => {
    const query = c.req.valid("query");
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await c.var.withTenant(
      (tx) => tx<Row[]>`
      select id, code, name_en, name_ar, minor_units,
             pos_rounding_increment::text, rounding_mode, archived_at
        from app.currency
       where (${query.includeArchived}::boolean or archived_at is null)
         and (${after ? (after.k[0] as string) : null}::text is null
              or (code, id) > (${after ? (after.k[0] as string) : null}::char(3),
                               ${after ? after.id : null}::uuid))
       order by code, id
       limit ${query.limit + 1}`,
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page.map(toJson),
        next_cursor:
          rows.length > query.limit && last ? encodeCursor({ k: [last.code], id: last.id }) : null,
      },
      200,
    );
  },
);

currenciesRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{currencyId}",
    tags: ["admin"],
    middleware: [
      requirePermission(PERMISSION["admin.company.manage"], { company: "body:companyId" }),
    ],
    request: {
      params: z.object({ currencyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdateCurrencyBody } } },
    },
    responses: {
      200: { content: { "application/json": { schema: CurrencySchema } }, description: "Updated" },
      ...problem(400),
      ...problem(404),
    },
  }),
  async (c) => {
    const { currencyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const [updated] = await tx<Row[]>`
        update app.currency set
          name_en = coalesce(${body.nameEn ?? null}, name_en),
          name_ar = case when ${body.nameAr === undefined} then name_ar else ${body.nameAr ?? null} end,
          minor_units = coalesce(${body.minorUnits ?? null}, minor_units),
          pos_rounding_increment = coalesce(${body.posRoundingIncrement ?? null}::numeric, pos_rounding_increment),
          rounding_mode = coalesce(${body.roundingMode ?? null}, rounding_mode),
          archived_at = case
            when ${body.archived === undefined} then archived_at
            when ${body.archived === true} then coalesce(archived_at, now())
            else null
          end
        where id = ${currencyId}
        returning id, code, name_en, name_ar, minor_units,
                  pos_rounding_increment::text, rounding_mode, archived_at`;
      return updated;
    });
    if (!row) throw new AppError("ERR_NOT_FOUND", `no currency ${currencyId} in this tenant`);
    return c.json(toJson(row), 200);
  },
);
