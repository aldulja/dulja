import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import {
  AppError,
  CountSheetBody,
  CountSheetResultSchema,
  fromDatabaseError,
  ProblemSchema,
  RecordCountsBody,
  TransferDraftSchema,
  TransferReceiptBody,
  UuidSchema,
} from "@dulja/contracts";
import {
  draftTransferReceipt,
  readCountSheet,
  recordCounts,
  snapshotCountSheet,
  type CountSheetLine as DbCountSheetLine,
} from "@dulja/db";
import type { AppEnv } from "../context";
import { refuseServiceOnlyType } from "../documents/service-only-type";
import { requireDocumentModuleRead } from "../middleware/require-attachment-read";
import {
  requireDocumentPermission,
  type GateBranch,
} from "../middleware/require-document-permission";
import { IdempotencyHeader } from "../routes/idempotency-header";

/** The tagged-template handle `c.var.withTenant` hands its callback. */
type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];
/** The wire shape: the service's line with `expectedQuantity` widened to nullable, which is what the
 *  projection below may set it to. */
type CountSheetLine = Omit<DbCountSheetLine, "expectedQuantity"> & {
  expectedQuantity: string | null;
};

/**
 * 3D T8 — the three stock-count sub-paths and the transfer **receipt** sub-path, all mounted on 1A's
 * generic `documents` module. All four are sub-paths of an already-registered, already-probed module, so
 * this slice adds **no `RouteModule` and no `PROBES` entry** (§4.2.7, hazard 31) and test 12's
 * tenant-isolation walk covers them for free.
 */

/** 3C's `asAppError`, verbatim and for the same reason: `packages/db` may not import `@dulja/contracts`
 *  (§3.1), so `snapshotCountSheet`, `recordCounts` and `draftTransferReceipt` raise `Error("ERR_…: detail")`
 *  and the translation happens here. An `AppError` this file raised itself passes through untouched —
 *  handing it to `fromDatabaseError` would turn a deliberate 404 into a 500. */
function asAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Error && /^ERR_[A-Z_]+: /.test(e.message)) {
    const [code, ...rest] = e.message.split(": ");
    return new AppError(code as never, rest.join(": "));
  }
  return fromDatabaseError(e);
}

/**
 * **The runbook's one control, and it is on the server.** A principal who does not hold
 * `inventory.adjustment.approve` never sees `expected_quantity` on a count line: a counter who can see the
 * expected figure confirms it instead of counting, which is the one control the legacy process lacked. The
 * approver reviewing a variance does see it — that is the whole of reviewing one.
 *
 * Applied to BOTH the snapshot response and the read-back, because the sheet is handed to the counter at
 * the moment it is drawn and a control that only covers the second call is not a control. The SERVICE
 * always returns the column (the DB-tier suite asserts on it, and 4A's reviewer needs it); the projection
 * is the route's.
 *
 * `app.actor_has(code, company_id, branch_id)` is asked at the SHEET's branch (2026-11-15 review, API-05),
 * read from the sheet's own lines and bound to the path company, so an approver restricted to that branch
 * sees the figure. A sheet the caller cannot resolve is asked company-wide, which fails closed.
 *
 * `variance` is masked with it (API-12): it is `counted − expected`, so a counter who entered any figure
 * would read the expected one back from it.
 */
async function projectExpected(
  tx: Tx,
  companyId: string,
  rows: readonly CountSheetLine[],
): Promise<CountSheetLine[]> {
  const first = rows[0];
  if (first === undefined) return [];
  const [sheet] = await tx<{ branch_id: string }[]>`
    select d.branch_id from app.document_line dl
      join app.document d on d.tenant_id = dl.tenant_id and d.id = dl.document_id
     where dl.id = ${first.documentLineId} and d.company_id = ${companyId}`;
  const [gate] = await tx<{ ok: boolean }[]>`
    select app.actor_has('inventory.adjustment.approve', ${companyId}::uuid,
                         ${sheet?.branch_id ?? null}::uuid) as ok`;
  return gate?.ok === true
    ? [...rows]
    : rows.map((l) => ({ ...l, expectedQuantity: null, variance: null }));
}

/**
 * ADR 0043's branch-gate pattern (`transferSourceBranch`) applied to the count sheet (2026-11-15 review,
 * API-05): the `create` stage is asked at the WAREHOUSE's branch — the branch `snapshotCountSheet` stamps on
 * the sheet — since `CountSheetBody` is `.strict()` and names none. The warehouse is read under the caller's
 * own row policies and bound to the path company; one the caller cannot resolve asks for company-wide
 * authority, and whoever holds it gets the handler's 404.
 */
export const countSheetBranch: GateBranch = async (tx, { companyId, body }) => {
  const warehouse = UuidSchema.safeParse(body.warehouseId);
  if (!warehouse.success) return null;
  const [row] = await tx<{ branch_id: string }[]>`
    select branch_id from app.warehouse
     where id = ${warehouse.data} and company_id = ${companyId} and archived_at is null`;
  return row?.branch_id ?? null;
};

export const countSheetRoute = createRoute({
  method: "post",
  path: "/count-sheet",
  tags: ["accounting"],
  summary: "Snapshot a stock-count sheet from stock_on_hand (the document IS the sheet)",
  // §4.5.4's `create` stage: no `:documentId` exists yet, so the middleware resolves the policy of the type
  // named in the BODY — STOCK_COUNT's `approval.create` (inventory.count.create) — and asks it at the
  // warehouse's branch (`countSheetBranch`).
  middleware: [requireDocumentPermission("create", { branch: countSheetBranch })] as const,
  request: {
    params: z.object({ companyId: UuidSchema }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: CountSheetBody } } },
  },
  responses: {
    201: {
      description: "The drafted sheet",
      content: { "application/json": { schema: CountSheetResultSchema } },
    },
    400: {
      description: "Not a stock warehouse, or a type only its own service drafts (FX_REVALUATION)",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "Warehouse or document type not found",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "The warehouse has no stock to count (ERR_DOC_NO_LINES)",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export const countSheetHandler: RouteHandler<typeof countSheetRoute, AppEnv> = async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  // The type code is the body's, so a service-only type is refused before any read (code review 3, R6's
  // verification: this route drafted an FX_REVALUATION on c7d26b4).
  refuseServiceOnlyType(body.documentTypeCode);
  try {
    const result = await c.var.withTenant(async (tx) => {
      // Bound to the PATH company: `document_type` is unique on (company_id, code), so an unbound lookup
      // would hand a caller authorised for company A the sibling company B's type of the same code.
      const [type] = await tx<{ id: string }[]>`
        select id from app.document_type
         where code = ${body.documentTypeCode} and company_id = ${companyId}
           and archived_at is null`;
      if (type === undefined) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `no document type ${body.documentTypeCode} in company ${companyId}`,
        );
      }
      // The warehouse the sheet is taken over, bound to the PATH company for the same reason: RLS bounds
      // the tenant and nothing else, and `snapshotCountSheet` takes the company FROM the warehouse.
      const [warehouse] = await tx<{ id: string }[]>`
        select id from app.warehouse
         where id = ${body.warehouseId} and company_id = ${companyId} and archived_at is null`;
      if (warehouse === undefined) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `no warehouse ${body.warehouseId} in company ${companyId}`,
        );
      }
      const sheet = await snapshotCountSheet(tx, c.var.ctx, {
        documentTypeId: type.id,
        series: body.series,
        effectiveDate: body.effectiveDate,
        warehouseId: body.warehouseId,
        ...(body.itemIds === undefined ? {} : { itemIds: body.itemIds }),
        ...(body.includeZero === undefined ? {} : { includeZero: body.includeZero }),
      });
      return {
        documentId: sheet.documentId,
        lines: await projectExpected(tx, companyId, sheet.lines),
      };
    });
    return c.json(result, 201);
  } catch (e) {
    throw asAppError(e);
  }
};

export const recordCountsRoute = createRoute({
  method: "patch",
  path: "/{documentId}/counts",
  tags: ["accounting"],
  summary: "Enter counted quantities on a draft stock-count sheet",
  // `PATCH`, not `PUT`: a counter enters part of a sheet at a time, and a line this call does not name
  // keeps its NULL counted quantity. The gate resolves the SHEET's own policy from the path (§4.5.4).
  middleware: [requireDocumentPermission("create")] as const,
  request: {
    params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: RecordCountsBody } } },
  },
  responses: {
    200: {
      description: "The sheet after the entry",
      content: { "application/json": { schema: CountSheetResultSchema } },
    },
    400: {
      description:
        "The document is not a stock-count sheet — a transfer receipt's counted quantities are fixed when it is drafted (ERR_VALIDATION_FAILED)",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "Sheet or line not found",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "The sheet is not a draft (ERR_DOC_STATUS_ILLEGAL)",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export const recordCountsHandler: RouteHandler<typeof recordCountsRoute, AppEnv> = async (c) => {
  const { companyId, documentId } = c.req.valid("param");
  const { counts } = c.req.valid("json");
  try {
    const lines = await c.var.withTenant(async (tx) => {
      // The sheet, bound to the PATH company. The gate already answered 404 for another company's
      // document, but an entity id in a path is bound here as well — that is the rule, not the gate's
      // side effect.
      const [sheet] = await tx<{ id: string }[]>`
        select id from app.document where id = ${documentId} and company_id = ${companyId}`;
      if (sheet === undefined) {
        throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      }
      const rows = await recordCounts(tx, c.var.ctx, { documentId, counts });
      return projectExpected(tx, companyId, rows);
    });
    return c.json({ documentId, lines }, 200);
  } catch (e) {
    throw asAppError(e);
  }
};

export const readCountSheetRoute = createRoute({
  method: "get",
  path: "/{documentId}/count-sheet",
  tags: ["accounting"],
  summary: "Read a stock-count sheet in line order",
  middleware: [requireDocumentModuleRead({ writeFree: false })] as const,
  request: { params: z.object({ companyId: UuidSchema, documentId: UuidSchema }) },
  responses: {
    200: {
      description: "The sheet",
      content: { "application/json": { schema: CountSheetResultSchema } },
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
});

export const readCountSheetHandler: RouteHandler<typeof readCountSheetRoute, AppEnv> = async (
  c,
) => {
  const { companyId, documentId } = c.req.valid("param");
  try {
    const lines = await c.var.withTenant(async (tx) => {
      const rows = await readCountSheet(tx, documentId);
      return projectExpected(tx, companyId, rows);
    });
    return c.json({ documentId, lines }, 200);
  } catch (e) {
    throw asAppError(e);
  }
};

/**
 * ADR 0043's amendment (accepted by the owner 2026-11-04), decision 1: the receipt is asked at the branch it
 * will CARRY — its corridor's, the RECEIVING branch — and not at the dispatch's. The path document's
 * `to_warehouse_id` names the corridor, read under the caller's own row policies and bound to the path
 * company; a principal restricted to the receiving branch reads the dispatch at all only because it is a
 * POSTED document into that branch's corridor (migration 0119). A path document carrying no corridor is asked
 * at its own branch, as before, and `draftTransferReceipt` refuses it.
 */
export const transferReceiptBranch: GateBranch = async (
  tx,
  { companyId, documentId, fallback },
) => {
  const [corridor] = await tx<{ branch_id: string }[]>`
    select w.branch_id from app.document d
      join app.warehouse w
        on w.tenant_id = d.tenant_id and w.company_id = d.company_id and w.id = d.to_warehouse_id
     where d.id = ${documentId} and d.company_id = ${companyId} and w.kind = 'in_transit'`;
  return corridor?.branch_id ?? fallback;
};

export const transferReceiptRoute = createRoute({
  method: "post",
  path: "/{documentId}/receipt",
  tags: ["accounting"],
  summary: "Draft the receipt of a posted stock transfer, with the variance on receipt (spec:1053)",
  // `{documentId}` is the posted TRANSFER, so the middleware resolves ITS policy from the path — which is
  // the same `inventory.transfer.create` TRANSFER_RECEIPT's `approval.create` names. The `submit` stage is
  // what a POST sub-path of an existing document is gated on (`create` is the draft-creation stage and
  // resolves the same code, `approval.create ?? approval.post`). The BRANCH asked about is the receipt's own,
  // its corridor's (`transferReceiptBranch`), not the dispatch's.
  middleware: [requireDocumentPermission("submit", { branch: transferReceiptBranch })] as const,
  request: {
    params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: TransferReceiptBody } } },
  },
  responses: {
    201: {
      description: "The drafted receipt",
      content: { "application/json": { schema: TransferDraftSchema } },
    },
    400: {
      description:
        "The transfer is not posted or was not drafted by draftTransfer, the document type's policy is not a transfer receipt, or the type is one only its own service drafts (FX_REVALUATION)",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "Transfer, line or document type not found",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "Over-fulfilment of the dispatch (ERR_DOC_LINK_OVER_FULFILLED)",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export const transferReceiptHandler: RouteHandler<typeof transferReceiptRoute, AppEnv> = async (
  c,
) => {
  const { companyId, documentId } = c.req.valid("param");
  const body = c.req.valid("json");
  // As `countSheetHandler`: the receipt's type code is the body's.
  refuseServiceOnlyType(body.documentTypeCode);
  try {
    const result = await c.var.withTenant(async (tx) => {
      const [type] = await tx<{ id: string }[]>`
        select id from app.document_type
         where code = ${body.documentTypeCode} and company_id = ${companyId}
           and archived_at is null`;
      if (type === undefined) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `no document type ${body.documentTypeCode} in company ${companyId}`,
        );
      }
      const [transfer] = await tx<{ id: string }[]>`
        select id from app.document where id = ${documentId} and company_id = ${companyId}`;
      if (transfer === undefined) {
        throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      }
      const drafted = await draftTransferReceipt(tx, c.var.ctx, {
        transferDocumentId: documentId,
        documentTypeId: type.id,
        series: body.series,
        effectiveDate: body.effectiveDate,
        ...(body.received === undefined ? {} : { received: body.received }),
      });
      return { ...drafted, inTransitWarehouseId: null };
    });
    return c.json(result, 201);
  } catch (e) {
    throw asAppError(e);
  }
};
