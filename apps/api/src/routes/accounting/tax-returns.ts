// apps/api/src/routes/accounting/tax-returns.ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createTaxReturn,
  findRegime,
  generateTaxReturn,
  getTaxReturn,
  listTaxReturns,
  taxReturnTieOut,
  type TaxReturnRow,
} from "@dulja/db";
import { AppError } from "@dulja/contracts";
import {
  CreateTaxReturnBody,
  TaxReturnDetail,
  TaxReturnList,
  TaxReturnQuery,
  TaxReturnSchema,
  type TaxReturnDto,
} from "@dulja/contracts/accounting/tax";
import { decodeCursor, encodeCursor, ProblemSchema, UuidSchema } from "@dulja/contracts";
// The kernel path 4B's own route module uses (phase-4b:7600). `tax-codes.ts` — written in this same task —
// imports the identical set; if the merged tree names it differently, correct BOTH files, never one.
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";
import { TAX_PERMISSION } from "./tax-codes";

export const taxReturnRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

const scope = { company: "path:companyId" } as const;
const params = z.object({ companyId: UuidSchema });
const detailParams = z.object({ companyId: UuidSchema, taxReturnId: UuidSchema });

/** `TaxReturnRow` → the wire row. `payload` is deliberately NOT on `TaxReturnSchema` — a list of returns
 *  would otherwise carry a full payload per item; the detail response has its own `payload` member. */
function toTaxReturnDto(row: TaxReturnRow): TaxReturnDto {
  return {
    id: row.id,
    regimeId: row.regimeId,
    regimeCode: row.regimeCode,
    regimeVersion: row.regimeVersion,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    payloadSha256: row.payloadSha256,
    generatedBy: row.generatedBy,
    filedAt: row.filedAt === null ? null : new Date(row.filedAt).toISOString(),
    attachmentId: row.attachmentId,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

// ── GET / — the list ───────────────────────────────────────────────────────────────────────────────────
taxReturnRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    request: { params, query: TaxReturnQuery },
    responses: {
      200: {
        content: { "application/json": { schema: TaxReturnList } },
        description: "Tax returns",
      },
      403: {
        content: { "application/problem+json": { schema: ProblemSchema } },
        description: "Forbidden",
      },
    },
    middleware: [requirePermission(TAX_PERMISSION.manage, scope)],
    tags: ["accounting"],
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await c.var.withTenant((tx) =>
      listTaxReturns(tx, {
        companyId,
        ...(q["filter[regimeCode][eq]"] === undefined
          ? {}
          : { regimeCode: q["filter[regimeCode][eq]"] }),
        cursor: cursor ? { periodStart: cursor.k[0] as string, id: cursor.id } : null,
        limit: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const next =
      rows.length > q.limit && page.length > 0
        ? encodeCursor({ k: [page[page.length - 1]!.periodStart], id: page[page.length - 1]!.id })
        : null;
    return c.json({ items: page.map(toTaxReturnDto), next_cursor: next }, 200);
  },
);

// ── POST / — reserve the period ────────────────────────────────────────────────────────────────────────
taxReturnRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    request: {
      params,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateTaxReturnBody } } },
    },
    responses: {
      201: { content: { "application/json": { schema: TaxReturnSchema } }, description: "Created" },
      404: {
        content: { "application/problem+json": { schema: ProblemSchema } },
        description: "No such regime",
      },
      409: {
        content: { "application/problem+json": { schema: ProblemSchema } },
        description: "Period overlaps one already reserved for the regime",
      },
      422: {
        content: { "application/problem+json": { schema: ProblemSchema } },
        description: "Partial fiscal period",
      },
    },
    middleware: [requirePermission(TAX_PERMISSION.manage, scope)],
    tags: ["accounting"],
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      // 404, never 403 and never 422: RLS bounds the lookup, so another tenant's regime is indistinguishable
      // from one that does not exist, and a probe learns nothing from the status code.
      const regimeId = await findRegime(tx, companyId, body.regimeCode, body.regimeVersion);
      if (regimeId === null) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `no tax regime ${body.regimeCode} v${body.regimeVersion} for this company`,
        );
      }
      // A range overlapping another return of this regime is a coded ERR_CONFLICT_UNIQUE naming that
      // return, lifted to 409 by fromDomainError (the unique key behind it still surfaces as the same 409
      // through fromDatabaseError); the partial-period refusal is a
      // PostingError("ERR_POLICY_REQUIRES_MISSING") and reaches 422 through the branch
      // apps/api/src/problem.ts already has. Neither is caught here.
      return createTaxReturn(tx, c.var.ctx, {
        companyId,
        regimeId,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
      });
    });
    return c.json(toTaxReturnDto(row), 201);
  },
);

// ── POST /{id}/generate ────────────────────────────────────────────────────────────────────────────────
taxReturnRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{taxReturnId}/generate",
    request: { params: detailParams, headers: IdempotencyHeader },
    responses: {
      200: {
        content: { "application/json": { schema: TaxReturnDetail } },
        description: "Generated",
      },
      404: {
        content: { "application/problem+json": { schema: ProblemSchema } },
        description: "Not found",
      },
      422: {
        content: { "application/problem+json": { schema: ProblemSchema } },
        description: "Regime mismatch or filed",
      },
    },
    middleware: [requirePermission(TAX_PERMISSION.manage, scope)],
    tags: ["accounting"],
  }),
  async (c) => {
    const { companyId, taxReturnId } = c.req.valid("param");
    // The path company is part of each service's own statement (AGENTS.md's company-binding rule), so a
    // sibling company's return is the 404 an unknown id gets, with nothing read first.
    const out = await c.var.withTenant(async (tx) => {
      const g = await generateTaxReturn(tx, c.var.ctx, taxReturnId, companyId);
      return { ...g, tieOut: await taxReturnTieOut(tx, taxReturnId, companyId) };
    });
    return c.json(
      {
        taxReturn: toTaxReturnDto(out.row),
        boxes: out.boxes.map((b) => ({
          code: b.code,
          label: b.label,
          amount: b.amount.toString(),
        })),
        payload: out.row.payload,
        tieOut: out.tieOut,
        currency: out.currency,
      },
      200,
    );
  },
);

// ── GET /{id} ──────────────────────────────────────────────────────────────────────────────────────────
taxReturnRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{taxReturnId}",
    request: { params: detailParams },
    responses: {
      200: {
        content: { "application/json": { schema: TaxReturnDetail } },
        description: "Tax return",
      },
      404: {
        content: { "application/problem+json": { schema: ProblemSchema } },
        description: "Not found",
      },
    },
    middleware: [requirePermission(TAX_PERMISSION.manage, scope)],
    tags: ["accounting"],
  }),
  async (c) => {
    const { companyId, taxReturnId } = c.req.valid("param");
    const out = await c.var.withTenant(async (tx) => {
      const g = await getTaxReturn(tx, taxReturnId, companyId);
      // A draft has no payload, so there is nothing to reconcile — `taxReturnTieOut` refuses it by design
      // (ERR_DOC_STATUS_ILLEGAL), and a GET must not 422 for the ordinary state of a new row.
      return {
        ...g,
        tieOut: g.row.payload === null ? [] : await taxReturnTieOut(tx, taxReturnId, companyId),
      };
    });
    return c.json(
      {
        taxReturn: toTaxReturnDto(out.row),
        boxes: out.boxes.map((b) => ({
          code: b.code,
          label: b.label,
          amount: b.amount.toString(),
        })),
        payload: out.row.payload,
        tieOut: out.tieOut,
        currency: out.currency,
      },
      200,
    );
  },
);

export const taxReturnRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/tax-returns",
  router: taxReturnRoutes,
  permissions: [TAX_PERMISSION.manage, EINVOICE_PERMISSION.file],
  auth: "human",
};

import { fileTaxReturn } from "@dulja/db";
import { FileTaxReturnBody } from "@dulja/contracts";
import { EINVOICE_PERMISSION } from "./einvoice-transmissions";

taxReturnRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{taxReturnId}/file",
    tags: ["accounting"],
    summary: "File a generated tax return",
    description:
      'The `generated → filed` transition. Gated by accounting.tax.file, not by accounting.tax.manage: filing is the act the spec\'s `accountant` row calls "tax returns" and it is separable from maintaining codes.',
    request: {
      params: z.object({ companyId: UuidSchema, taxReturnId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: FileTaxReturnBody } } },
    },
    middleware: [requirePermission(EINVOICE_PERMISSION.file, { company: "path:companyId" })],
    responses: {
      200: {
        description: "The filed return",
        content: { "application/json": { schema: TaxReturnDetail } },
      },
      404: {
        description: "Not found",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "Not generated, or stale: a post into its period since it was generated",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, taxReturnId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant((tx) =>
      fileTaxReturn(tx, c.var.ctx, {
        taxReturnId,
        companyId,
        ...(body.filedAt === undefined ? {} : { filedAt: body.filedAt }),
        ...(body.attachmentId === undefined ? {} : { attachmentId: body.attachmentId }),
      }),
    );
    const detail = await c.var.withTenant(async (tx) => ({
      ...(await getTaxReturn(tx, taxReturnId, companyId)),
      tieOut: await taxReturnTieOut(tx, taxReturnId, companyId),
    }));
    // `TaxReturnDetail` is 5A's and has FIVE members — `taxReturn`, `boxes`, `payload`, `tieOut`,
    // `currency` — and 5A's own `/generate` and `GET /{id}` handlers build exactly this shape. The
    // entity key is `taxReturn`, not `row`; `payload` comes off the row 5A already read back; and
    // `tieOut` is 5A's `taxReturnTieOut`, never `[]` — a filed return is precisely the one an auditor
    // asks to see reconciled. `toTaxReturnDto`, `getTaxReturn` and `taxReturnTieOut` are already in
    // this file (5A wrote them), so the appended import line above adds only `fileTaxReturn`.
    return c.json(
      {
        taxReturn: toTaxReturnDto(row),
        boxes: detail.boxes.map((b) => ({
          code: b.code,
          label: b.label,
          amount: b.amount.toString(),
        })),
        payload: detail.row.payload,
        tieOut: detail.tieOut,
        currency: detail.currency,
      },
      200,
    );
  },
);
