import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { AppError, decodeCursor, encodeCursor, ProblemSchema, UuidSchema } from "@dulja/contracts";
import {
  ClosePeriodBody,
  CreateFiscalYearBody,
  FiscalYearSchema,
  FiscalPeriodList,
  FiscalPeriodQuery,
  FiscalPeriodSchema,
  ReopenPeriodBody,
} from "@dulja/contracts/accounting/fiscal-period";
import { PERMISSION } from "@dulja/contracts/permissions";
import { createFiscalYear, FiscalYearOverlapError, fiscalYearStartMonth } from "@dulja/db";
import type { AppEnv } from "../../context";
import { membershipOnly, requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

export const fiscalPeriodRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const close = requirePermission(PERMISSION["accounting.period.close"], {
  company: "path:companyId",
});
const reopen = requirePermission(PERMISSION["accounting.period.reopen"], {
  company: "path:companyId",
});

type PeriodStatus = "open" | "closed" | "locked";
interface Row {
  id: string;
  starts_on: string;
  ends_on: string;
  status: PeriodStatus;
  closed_by: string | null;
  closed_at: Date | null;
  reopen_reason: string | null;
  created_at: Date;
}
/** A nested postgres.js fragment, never `sql.unsafe` — contracts §3.3 confines that to three homes. */
const columns = (tx: Sql) =>
  tx`id, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on,
     status::text as status, closed_by, closed_at, reopen_reason, created_at`;
const toPeriod = (row: Row) => ({
  id: row.id,
  startsOn: row.starts_on,
  endsOn: row.ends_on,
  status: row.status,
  closedBy: row.closed_by,
  closedAt: row.closed_at?.toISOString() ?? null,
  reopenReason: row.reopen_reason,
  createdAt: row.created_at.toISOString(),
});

type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

/** A zero-row status-guarded update is one of two things: no such period here (404), or a period in the
 *  wrong status for this transition (409). The second read tells them apart. */
async function refusal(
  tx: Tx,
  companyId: string,
  periodId: string,
  rule: string,
): Promise<AppError> {
  const [existing] = await tx<{ status: string }[]>`
    select status::text as status from app.fiscal_period where id = ${periodId} and company_id = ${companyId}`;
  if (!existing) {
    return new AppError("ERR_NOT_FOUND", `no fiscal period ${periodId} in company ${companyId}`);
  }
  return new AppError(
    "ERR_PERIOD_STATUS_ILLEGAL",
    `fiscal period ${periodId} is ${existing.status}; ${rule}`,
  );
}

fiscalPeriodRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["accounting"],
    middleware: [membershipOnly()] as const,
    summary: "List fiscal periods (membership only)",
    request: { params: z.object({ companyId: UuidSchema }), query: FiscalPeriodQuery },
    responses: {
      200: {
        description: "A page of periods",
        content: { "application/json": { schema: FiscalPeriodList } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { cursor, limit, status } = c.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await c.var.withTenant(
      (tx) => tx<Row[]>`
      select ${columns(tx)} from app.fiscal_period
       where company_id = ${companyId}
         and (${status ?? null}::text is null or status::text = ${status ?? null})
         and (${after ? after.id : null}::uuid is null or id > ${after ? after.id : null}::uuid)
       order by id limit ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page.map(toPeriod),
        next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.id }) : null,
      },
      200,
    );
  },
);

fiscalPeriodRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{periodId}/close",
    tags: ["accounting"],
    middleware: [close] as const,
    summary: "Close a period — uniform for all roles (spec:2223)",
    request: {
      params: z.object({ companyId: UuidSchema, periodId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: ClosePeriodBody } } },
    },
    responses: {
      200: {
        description: "The period",
        content: { "application/json": { schema: FiscalPeriodSchema } },
      },
      404: {
        description: "Not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "Not open",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, periodId } = c.req.valid("param");
    const row = await c.var.withTenant(async (tx) => {
      // closed_by is coalesced, never reassigned: app.stamp_actor raises ERR_ACTOR_IMMUTABLE on any change to
      // a non-null *_by value, so a close after a reopen by a different principal would fail. The column holds
      // the first closer; app.audit_log holds every close with its own stamped actor (ADR 0023).
      // `status = 'open'` is load-bearing: without it this route DOWNGRADED a locked period to closed under
      // accounting.period.close alone (weakening the lock with no reason and no reopen authority), and a
      // repeat close rewrote closed_at over the original close time. A period that is not open is 409.
      const updated = await tx<Row[]>`
        update app.fiscal_period
           set status = 'closed', closed_at = now(), closed_by = coalesce(closed_by, app.current_actor())
         where id = ${periodId} and company_id = ${companyId} and status = 'open'
        returning ${columns(tx)}`;
      if (updated.length === 0) {
        throw await refusal(tx, companyId, periodId, "only an open period is closed");
      }
      return updated[0]!;
    });
    return c.json(toPeriod(row), 200);
  },
);

fiscalPeriodRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{periodId}/reopen",
    tags: ["accounting"],
    middleware: [reopen] as const,
    summary: "Reopen a closed or locked period with a mandatory reason (spec:2179 R8)",
    request: {
      params: z.object({ companyId: UuidSchema, periodId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: ReopenPeriodBody } } },
    },
    responses: {
      200: {
        description: "The period",
        content: { "application/json": { schema: FiscalPeriodSchema } },
      },
      404: {
        description: "Not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "Already open",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, periodId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      // Only a closed or locked period reopens; reopening an open one would overwrite reopen_reason and
      // leave an audit row that reads as a reopen of nothing.
      const updated = await tx<Row[]>`
        update app.fiscal_period set status = 'open', reopen_reason = ${reason}
         where id = ${periodId} and company_id = ${companyId} and status in ('closed', 'locked')
        returning ${columns(tx)}`;
      if (updated.length === 0) {
        throw await refusal(tx, companyId, periodId, "only a closed or locked period is reopened");
      }
      return updated[0]!;
    });
    return c.json(toPeriod(row), 200);
  },
);

/**
 * ADR 0097 (full review PRD-05): `POST /v1/companies/{companyId}/fiscal-years` — a company's next year, without an
 * engineer running `bun run seed --fiscal-year N`. Its own module (a sibling path, not a period sub-resource) under
 * `accounting.period.close`, the code that already governs the period lifecycle; the periods it writes are `open`
 * and closing them is the existing route's. The rule is `createFiscalYear`, the seed's own, with an overlap refused.
 */
export const fiscalYearRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

fiscalYearRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["accounting"],
    middleware: [close] as const,
    summary: "Create a fiscal year's twelve open monthly periods (idempotent)",
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateFiscalYearBody } } },
    },
    responses: {
      200: {
        description: "Every period of the year already existed; nothing was created",
        content: { "application/json": { schema: FiscalYearSchema } },
      },
      201: {
        description: "The year's periods, some or all of them created by this request",
        content: { "application/json": { schema: FiscalYearSchema } },
      },
      400: {
        description: "Invalid, or no start month to take from the company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "A period of the year overlaps an existing period with other bounds",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await c.var.withTenant(async (tx) => {
      const startMonth = body.startMonth ?? (await fiscalYearStartMonth(tx, companyId));
      if (startMonth === null) {
        throw new AppError(
          "ERR_VALIDATION_FAILED",
          "the company has no fiscal period to take the start month from; send startMonth",
        );
      }
      try {
        const year = await createFiscalYear(tx, companyId, {
          fiscalYear: body.fiscalYear,
          startMonth,
          overlap: "refuse",
        });
        const rows = await tx<Row[]>`
          select ${columns(tx)} from app.fiscal_period
           where company_id = ${companyId} and id = any(${year.periodIds}::uuid[])
           order by starts_on`;
        return { inserted: year.inserted, items: rows.map(toPeriod) };
      } catch (e) {
        if (e instanceof FiscalYearOverlapError)
          throw new AppError("ERR_CONFLICT_UNIQUE", e.message);
        throw e;
      }
    });
    return c.json(result, result.inserted > 0 ? 201 : 200);
  },
);
