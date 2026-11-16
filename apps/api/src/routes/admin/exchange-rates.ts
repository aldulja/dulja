import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import {
  AppError,
  decodeCursor,
  encodeCursor,
  PERMISSION,
  ProblemSchema,
  UuidSchema,
} from "@dulja/contracts";
import {
  CreateExchangeRateBody,
  ExchangeRateList,
  ExchangeRateQuery,
  ExchangeRateSchema,
  RateLookupQuery,
  RateLookupResponse,
} from "@dulja/contracts/admin/exchange-rate";
import { rateFor } from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

export const exchangeRatesRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const PathParams = z.object({ companyId: UuidSchema });
/** One gate for the module, reads included: a rate is a company's own figure, not tenant-wide data. */
const gate = requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" });
const problem = (status: 400 | 404 | 409 | 422) => ({
  [status]: {
    content: { "application/problem+json": { schema: ProblemSchema } },
    description: "Problem",
  },
});

async function companyExists(tx: Sql, companyId: string): Promise<boolean> {
  return (await tx`select 1 from app.company where id = ${companyId}`).length > 0;
}

exchangeRatesRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["admin"],
    middleware: [gate],
    request: {
      params: PathParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateExchangeRateBody } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: ExchangeRateSchema } },
        description: "Created",
      },
      ...problem(400),
      ...problem(409),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const [created] = await tx<
        {
          id: string;
          company_id: string;
          from_currency: string;
          to_currency: string;
          rate: string;
          effective_from: string;
          source: string;
          entered_by: string;
        }[]
      >`
        insert into app.exchange_rate
          (tenant_id, company_id, from_currency, to_currency, rate, effective_from, source)
        values
          (${c.var.ctx.tenantId}, ${companyId}, ${body.fromCurrency}, ${body.toCurrency},
           ${body.rate}, ${body.effectiveFrom}, ${body.source})
        returning id, company_id, from_currency, to_currency, rate::text,
                  effective_from::text, source, entered_by`;
      return created!;
    });
    return c.json(
      {
        id: row.id,
        companyId: row.company_id,
        fromCurrency: row.from_currency,
        toCurrency: row.to_currency,
        rate: row.rate,
        effectiveFrom: row.effective_from,
        source: row.source,
        enteredBy: row.entered_by,
      },
      201,
    );
  },
);

exchangeRatesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["admin"],
    middleware: [gate],
    request: { params: PathParams, query: ExchangeRateQuery },
    responses: {
      200: { content: { "application/json": { schema: ExchangeRateList } }, description: "Rates" },
      ...problem(404),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const query = c.req.valid("query");
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await c.var.withTenant(async (tx) => {
      if (!(await companyExists(tx, companyId))) return null;
      return tx<
        {
          id: string;
          company_id: string;
          from_currency: string;
          to_currency: string;
          rate: string;
          effective_from: string;
          source: string;
          entered_by: string;
        }[]
      >`
        select id, company_id, from_currency, to_currency, rate::text,
               effective_from::text, source, entered_by
          from app.exchange_rate
         where company_id = ${companyId}
           and (${query.from ?? null}::char(3) is null or from_currency = ${query.from ?? null})
           and (${query.to ?? null}::char(3) is null or to_currency = ${query.to ?? null})
           and (${after ? (after.k[0] as string) : null}::date is null
                or (effective_from, id) < (${after ? (after.k[0] as string) : null}::date,
                                           ${after ? after.id : null}::uuid))
         order by effective_from desc, id desc
         limit ${query.limit + 1}`;
    });
    if (rows === null)
      throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page.map((row) => ({
          id: row.id,
          companyId: row.company_id,
          fromCurrency: row.from_currency,
          toCurrency: row.to_currency,
          rate: row.rate,
          effectiveFrom: row.effective_from,
          source: row.source,
          enteredBy: row.entered_by,
        })),
        next_cursor:
          rows.length > query.limit && last
            ? encodeCursor({ k: [last.effective_from], id: last.id })
            : null,
      },
      200,
    );
  },
);

exchangeRatesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/lookup",
    tags: ["admin"],
    middleware: [gate],
    request: { params: PathParams, query: RateLookupQuery },
    responses: {
      200: { content: { "application/json": { schema: RateLookupResponse } }, description: "Rate" },
      ...problem(404),
      ...problem(422),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { from, to, on } = c.req.valid("query");
    const found = await c.var.withTenant(async (tx) => {
      if (!(await companyExists(tx, companyId))) return "no-company" as const;
      return rateFor(tx, companyId, from, to, on);
    });
    if (found === "no-company") {
      throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
    }
    if (!found) {
      throw new AppError(
        "ERR_RATE_NOT_FOUND",
        ["no exchange rate is effective for ", from, " → ", to, " on ", on].join(""),
      );
    }
    return c.json(
      {
        from: found.from,
        to: found.to,
        rate: found.rate,
        effectiveFrom: found.effectiveFrom,
        source: found.source,
      },
      200,
    );
  },
);
