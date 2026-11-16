import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  CreatePaymentTermBody,
  decodeCursor,
  encodeCursor,
  PaymentTermList,
  PaymentTermQuery,
  PaymentTermSchema,
  ProblemSchema,
  UpdatePaymentTermBody,
  UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  archivePaymentTerm,
  createPaymentTerm,
  listPaymentTerms,
  updatePaymentTerm,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission, type ScopeSource } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
// Type-only, so nothing circular survives to runtime (the same shape `valuationRouteModule` uses).
import type { RouteModule } from "../index";

/**
 * `/v1/companies/{companyId}/payment-terms` (4A, contracts §4.2.7) — the one new route module slice 4A mounts.
 *
 * Gated `accounting.party.manage`, not `admin.company.manage`: §3.6.2's "uses fixed by this document" list gives
 * that code document types, posting policies, print templates, dimensions, custom fields and exchange rates,
 * and payment terms are none of them; spec:2158 gives the `user` role "maintain customers and vendors (credit
 * terms included)", and `accounting.party.manage` is the code it holds for exactly that. No new code.
 *
 * Master data: created, edited, ARCHIVED, never deleted (spec:2049). There is no DELETE route and no DELETE
 * grant — contracts §3.5.4 pins the list and this slice leaves it unchanged.
 */
export const paymentTermRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

/** Declared once and used by all four routes. The gate clearing this company is what keeps the `companyId`
 *  passed to every service below an authorised id rather than a claimed one (AGENTS.md). */
export const PAYMENT_TERM_PAGE: ScopeSource = { company: "path:companyId" };
const gate = () => requirePermission(PERMISSION["accounting.party.manage"], PAYMENT_TERM_PAGE);

const Params = z.object({ companyId: UuidSchema });
const ItemParams = Params.extend({ paymentTermId: UuidSchema });

const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/** `listPaymentTerms` orders by `code`, so its cursor is `k: [code]` plus the term's id (the shared codec,
 *  §4.2.8). Validated as the bank-statement and ageing keysets validate theirs (code review 2026-09-29): a
 *  decoded `k` of the wrong shape used to become the string "undefined" or a stringified number and page from
 *  there. */
function termCursor(raw: string): { code: string } {
  const decoded = decodeCursor(raw);
  const [code] = decoded.k;
  if (
    decoded.k.length !== 1 ||
    typeof code !== "string" ||
    code === "" ||
    !UuidSchema.safeParse(decoded.id).success
  ) {
    throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid payment-term cursor");
  }
  return { code };
}

paymentTermRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "List payment terms, keyset-paged on code",
    request: { params: Params, query: PaymentTermQuery },
    responses: {
      200: {
        description: "Payment terms",
        content: { "application/json": { schema: PaymentTermList } },
      },
      400: problem("Invalid query or cursor"),
      403: problem("Forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    // The shared cursor codec (§4.2.8); a second base64url round-trip here would be two spellings of one thing.
    const after = q.cursor ? termCursor(q.cursor) : null;
    // One row past the page decides whether there IS a next page, so a page that is exactly full does not
    // hand the caller a cursor to an empty one.
    const rows = await c.var.withTenant((tx) =>
      listPaymentTerms(tx, {
        companyId,
        includeArchived: q["filter[archived][eq]"] === "true",
        cursor: after,
        limit: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page,
        next_cursor:
          rows.length > q.limit && last ? encodeCursor({ k: [last.code], id: last.id }) : null,
      },
      200,
    );
  },
);

paymentTermRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "Create a payment term",
    request: {
      params: Params,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreatePaymentTermBody } } },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: PaymentTermSchema } },
      },
      400: problem("Invalid body"),
      409: problem("Duplicate code"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant((tx) =>
      createPaymentTerm(tx, c.var.ctx, { companyId, ...body }),
    );
    return c.json(row, 201);
  },
);

paymentTermRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{paymentTermId}",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "Edit a payment term's names, days or discount — never its code",
    request: {
      params: ItemParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdatePaymentTermBody } } },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: PaymentTermSchema } },
      },
      400: problem("Invalid body, or a discount window the stored term cannot take"),
      404: problem("Not found"),
      409: problem(
        "The days or discount of a term a non-draft document pins (ERR_CONFLICT_REFERENCE, SAH-013) — create a new term",
      ),
    },
  }),
  async (c) => {
    const { companyId, paymentTermId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant((tx) =>
      updatePaymentTerm(tx, c.var.ctx, { companyId, paymentTermId, ...body }),
    );
    return c.json(row, 200);
  },
);

/** Archive is a POST, never a DELETE (spec:2049). `archivePaymentTerm` is idempotent. */
paymentTermRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{paymentTermId}/archive",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "Archive a payment term",
    request: { params: ItemParams, headers: IdempotencyHeader },
    responses: {
      200: {
        description: "Archived",
        content: { "application/json": { schema: PaymentTermSchema } },
      },
      404: problem("Not found"),
    },
  }),
  async (c) => {
    const { companyId, paymentTermId } = c.req.valid("param");
    const row = await c.var.withTenant((tx) =>
      archivePaymentTerm(tx, c.var.ctx, { companyId, paymentTermId }),
    );
    return c.json(row, 200);
  },
);

/** `PROBES` (tests/invariants/probes.ts) is keyed by this `path`; the three sub-paths need no key of their own
 *  (hazard 31). */
export const paymentTermRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/payment-terms",
  router: paymentTermRoutes,
  permissions: [PERMISSION["accounting.party.manage"]],
  auth: "human",
};
