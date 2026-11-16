import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import {
  AllocateLandedCostBody,
  AppError,
  fromDatabaseError,
  LandedCostAllocationSchema,
  LandedCostSummarySchema,
  ProblemSchema,
  UuidSchema,
} from "@dulja/contracts";
import {
  allocateLandedCostForDocument,
  landedCostSummary,
  LandedCostError,
  listLandedCost,
  resolvePolicy,
} from "@dulja/db";
import type { AppEnv } from "../context";
// 2C's file, and the ONLY home of `requireDocumentModuleRead` — §4.5.8's prose says
// `routes/accounting/attachments.ts`; the merged tree has it here, as Task 4's handlers record.
import { requireDocumentModuleRead } from "../middleware/require-attachment-read";
import { requireDocumentPermission } from "../middleware/require-document-permission";
// 0B's home for this schema, never `@dulja/contracts`, and never through `../routes/index` (an import cycle).
import { IdempotencyHeader } from "../routes/idempotency-header";

const PathParams = z.object({ companyId: UuidSchema, documentId: UuidSchema });

const ResponseBody = z.object({
  items: z.array(LandedCostAllocationSchema),
  summary: z.array(LandedCostSummarySchema),
});

/** Task 4's `asAppError`, verbatim and for the same reason: migration 0038's
 *  `landed_cost_allocation_draft_only` trigger raises `ERR_DOC_NOT_DRAFT: document … is …` as a
 *  `check_violation`, and `packages/db` cannot import `AppError` (§3.1), so the token is translated here.
 *  Without this the guard's refusal — an ordinary user error, 409 — would reach the client as an unmapped
 *  `ERR_INTERNAL` 500, and the 409 declared on `allocateLandedCostRoute` below would be a lie. An `AppError`
 *  raised by this file's own checks passes through untouched; anything else goes through `fromDatabaseError`
 *  exactly as §4.2.4 specifies. */
function asAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Error && /^ERR_[A-Z_]+: /.test(e.message)) {
    const [code, ...rest] = e.message.split(": ");
    return new AppError(code as never, rest.join(": "));
  }
  return fromDatabaseError(e);
}

export const allocateLandedCostRoute = createRoute({
  method: "post",
  // RELATIVE to `documentRoutes`' own `/v1/companies/:companyId/documents`, exactly like 2C's
  // `/{documentId}/print` and Task 4's `/{documentId}/links`.
  path: "/{documentId}/landed-cost",
  tags: ["inventory"],
  summary: "Allocate an import shipment's freight, duty and clearance across its goods lines",
  request: {
    params: PathParams,
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: AllocateLandedCostBody } } },
  },
  responses: {
    201: {
      description: "Allocated",
      content: { "application/json": { schema: ResponseBody } },
    },
    // 400 and NOT 422. Every refusal this route can produce below the gates is `ERR_VALIDATION_FAILED` —
    // the Zod method enum, the "policy does not receive stock" check, and every `LandedCostError` whose
    // code is `ERR_VALIDATION_FAILED` — and §4.2.4 fixes that code at 400. No code allocated to 422 is
    // raised on this path, so declaring 422 here would describe a status the route never returns.
    400: {
      description: "Refused",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "The document is not a draft (migration 0038's guard)",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
  // "submit" and not "create": both resolve `approval.create ?? approval.post` (§4.5.4), but the "create"
  // branch of `requireDocumentPermission` reads the document TYPE from the request body and 404s when it is
  // absent. This body carries allocations, not a type.
  middleware: [requireDocumentPermission("submit")] as const,
});

export const listLandedCostRoute = createRoute({
  method: "get",
  path: "/{documentId}/landed-cost",
  tags: ["inventory"],
  summary: "The stored allocation and the landed amount per goods line",
  request: { params: PathParams },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ResponseBody } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
  middleware: [requireDocumentModuleRead({ writeFree: false })] as const,
});

export const allocateLandedCostHandler: RouteHandler<
  typeof allocateLandedCostRoute,
  AppEnv
> = async (c) => {
  const { companyId, documentId } = c.req.valid("param");
  const { allocations } = c.req.valid("json");

  try {
    const payload = await c.var.withTenant(async (tx) => {
      // Generic over document types, per §4.2.7: the POLICY is asked whether this document receives
      // stock, and a refusal names the type and the effect it actually has. That admits GOODS_RECEIPT
      // and 9B's OPENING_STOCK and refuses a PURCHASE_ORDER, without a list of codes anywhere.
      //
      // `resolvePolicy(tx, documentTypeId, effectiveDate)` is THREE POSITIONAL arguments returning
      // `{ policyId, definition }` (§4.3.1) — it does not take a document. So the header is read first,
      // bound to the PATH COMPANY as well as the id, and the policy is resolved for the document's OWN
      // effective_date: a shipment dated before a policy version change must be allocated under the
      // version it will post under.
      const [head] = await tx<{ document_type_id: string; effective_date: string }[]>`
          select document_type_id, to_char(effective_date, 'YYYY-MM-DD') as effective_date
            from app.document where id = ${documentId} and company_id = ${companyId}`;
      if (!head) {
        throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      }
      const policy = await resolvePolicy(tx, head.document_type_id, head.effective_date);
      if (policy.definition.inventory.effect !== "receipt") {
        throw new AppError(
          "ERR_VALIDATION_FAILED",
          `${policy.definition.documentType} has inventory.effect '${policy.definition.inventory.effect}'; landed cost is allocated on a document that receives stock`,
        );
      }
      const items = await allocateLandedCostForDocument(tx, c.var.ctx, {
        documentId,
        allocations,
      });
      return { items, summary: await landedCostSummary(tx, documentId) };
    });
    return c.json(payload, 201);
  } catch (e) {
    // `packages/db` may not import `AppError` (§3.1), so `LandedCostError` carries a literal `ErrCode`
    // and reaches the same translation as `PolicyEvaluationError` and `PostingError` (§4.2.4). Two
    // arguments: `AppError` is `(code, detail, extra?)` — a `{ detail }` object would land in `detail`.
    if (e instanceof LandedCostError) throw new AppError(e.code, e.detail);
    // Not a `LandedCostError`: this is where migration 0038's draft-only trigger arrives, as a postgres
    // check_violation whose message starts `ERR_DOC_NOT_DRAFT: `. 409, per §4.2.4.
    throw asAppError(e);
  }
};

export const listLandedCostHandler: RouteHandler<typeof listLandedCostRoute, AppEnv> = async (
  c,
) => {
  const { documentId } = c.req.valid("param");
  // The gate bound `:documentId` to `:companyId` and answered 404 when the join found nothing, so both
  // reads below are already inside one company.
  try {
    const payload = await c.var.withTenant(async (tx) => ({
      items: await listLandedCost(tx, documentId),
      summary: await landedCostSummary(tx, documentId),
    }));
    return c.json(payload, 200);
  } catch (e) {
    // `landedCostSummary` raises ERR_NOT_FOUND when the document is invisible — which for another tenant's
    // id is exactly the right answer, and is what the isolation case asserts.
    if (e instanceof LandedCostError) throw new AppError(e.code, e.detail);
    throw asAppError(e);
  }
};
