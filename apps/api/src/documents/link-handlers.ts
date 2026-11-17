import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import {
  AppError,
  CreateDocumentLinksBody,
  DocumentLinkList,
  fromDatabaseError,
  OpenQuantityList,
  ProblemSchema,
  UuidSchema,
} from "@dulja/contracts";
import { linkFulfilment, listLinks, openQuantity } from "@dulja/db";
import type { AppEnv } from "../context";
// 2C's file, and the ONLY home of MODULE_READ_CODE and its two middlewares. §4.5.8's prose says
// `routes/accounting/attachments.ts`; the merged tree has it here, which is what the 3C plan records.
import { requireDocumentModuleRead } from "../middleware/require-attachment-read";
import { requireDocumentPermission } from "../middleware/require-document-permission";
import { IdempotencyHeader } from "../routes/idempotency-header";

const PathParams = z.object({ companyId: UuidSchema, documentId: UuidSchema });

/** Any error whose message starts with a token is turned into that AppError; anything else goes through
 *  `fromDatabaseError`. `packages/db` cannot import AppError (§3.1), so the translation happens here. An
 *  AppError raised by this file's own checks passes through untouched — handing it to `fromDatabaseError`
 *  would turn a deliberate 404 into a 500. */
function asAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Error && /^ERR_[A-Z_]+: /.test(e.message)) {
    const [code, ...rest] = e.message.split(": ");
    return new AppError(code as never, rest.join(": "));
  }
  return fromDatabaseError(e);
}

export const createDocumentLinksRoute = createRoute({
  method: "post",
  path: "/{documentId}/links",
  tags: ["accounting"],
  summary: "Record fulfilment links from an issued source document onto this draft",
  request: {
    params: PathParams,
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: CreateDocumentLinksBody } } },
  },
  responses: {
    201: {
      description: "The links created",
      content: { "application/json": { schema: DocumentLinkList } },
    },
    400: {
      description:
        "A line id is not a line of the document it is paired with (ERR_VALIDATION_FAILED, migration 0109); or a price would be copied between documents whose taxInclusive differs (ERR_VALIDATION_FAILED) — draft the target with its order's taxInclusive",
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
      description: "The target is not a draft, or the source is not issued",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "Over-fulfilled",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
  // "submit", not "create": both resolve `approval.create ?? approval.post` (§4.5.4), but the "create"
  // branch of `requireDocumentPermission` finds the type in the request BODY and 404s when it is absent.
  // This body names a source document, not a type.
  middleware: [requireDocumentPermission("submit")] as const,
});

export const createDocumentLinks: RouteHandler<typeof createDocumentLinksRoute, AppEnv> = async (
  c,
) => {
  const { companyId, documentId } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    const items = await c.var.withTenant(async (tx) => {
      // The gate bound `:documentId` to `:companyId`; the SOURCE arrives in the body and is bound here.
      // `document_link`'s foreign keys are composite on `(tenant_id, …)` and bound the TENANT only, so
      // without this a caller authorised for company A links A's draft receipt against company B's order
      // — and then prices A's line from B's, and consumes B's open quantity. 404, never 403: a document id
      // the caller may not see is not confirmed to exist (§4.2.4).
      const [source] = await tx<{ id: string }[]>`
        select id from app.document
         where id = ${body.sourceDocumentId} and company_id = ${companyId}`;
      if (!source) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `no document ${body.sourceDocumentId} in company ${companyId}`,
        );
      }
      return linkFulfilment(tx, c.var.ctx, {
        sourceDocumentId: body.sourceDocumentId,
        targetDocumentId: documentId,
        linkKind: body.linkKind,
        lines: body.lines,
        priceFromSource: body.priceFromSource,
      });
    });
    return c.json({ items, next_cursor: null }, 201);
  } catch (e) {
    throw asAppError(e);
  }
};

export const listDocumentLinksRoute = createRoute({
  method: "get",
  path: "/{documentId}/links",
  tags: ["accounting"],
  summary: "Every link into or out of this document",
  request: { params: PathParams },
  responses: {
    200: {
      description: "Every link into or out of this document",
      content: { "application/json": { schema: DocumentLinkList } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
  middleware: [requireDocumentModuleRead({ writeFree: false })] as const,
});

export const listDocumentLinks: RouteHandler<typeof listDocumentLinksRoute, AppEnv> = async (c) => {
  const { documentId } = c.req.valid("param");
  // Deliberately unpaged: a document's own links are bounded by its line count (§4.2.8, 2B's precedent
  // on `GET …/events`). `next_cursor` is a constant null, which is honest because the route declares
  // neither `limit` nor `cursor` to honour.
  const items = await c.var.withTenant((tx) => listLinks(tx, documentId));
  return c.json({ items, next_cursor: null }, 200);
};

export const openQuantityRoute = createRoute({
  method: "get",
  path: "/{documentId}/open-quantity",
  tags: ["accounting"],
  summary: "Ordered, linked and open quantity per line (LEGACY-017, LEGACY-018)",
  request: { params: PathParams },
  responses: {
    200: {
      description: "Ordered, linked and open quantity per line",
      content: { "application/json": { schema: OpenQuantityList } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
  middleware: [requireDocumentModuleRead({ writeFree: false })] as const,
});

export const getOpenQuantity: RouteHandler<typeof openQuantityRoute, AppEnv> = async (c) => {
  const { documentId } = c.req.valid("param");
  const items = await c.var.withTenant((tx) => openQuantity(tx, documentId));
  return c.json({ items, next_cursor: null }, 200);
};
