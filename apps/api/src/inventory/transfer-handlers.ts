import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import {
  AppError,
  fromDatabaseError,
  ProblemSchema,
  TransferDraftBody,
  TransferDraftSchema,
  UuidSchema,
} from "@dulja/contracts";
import { draftTransfer } from "@dulja/db";
import type { AppEnv } from "../context";
import { refuseServiceOnlyType } from "../documents/service-only-type";
import {
  requireDocumentPermission,
  type GateBranch,
} from "../middleware/require-document-permission";
import { IdempotencyHeader } from "../routes/idempotency-header";

/** The tagged-template handle `c.var.withTenant` hands its callback. */
type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

/** 3C's `asAppError`, verbatim and for the same reason: `packages/db` may not import `@dulja/contracts`
 *  (§3.1), so `draftTransfer` raises `Error("ERR_…: detail")` and the translation happens here. An
 *  `AppError` this file raised itself passes through untouched — handing it to `fromDatabaseError` would
 *  turn a deliberate 404 into a 500. */
function asAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Error && /^ERR_[A-Z_]+: /.test(e.message)) {
    const [code, ...rest] = e.message.split(": ");
    return new AppError(code as never, rest.join(": "));
  }
  return fromDatabaseError(e);
}

/**
 * ADR 0043's amendment (accepted by the owner 2026-11-04), decision 3: the dispatch's `create` stage is asked
 * at the SOURCE warehouse's branch — the branch `draftTransfer` stamps on the draft — and never at a branch
 * the body names (`TransferDraftBody` is `.strict()` and names none). The source is read under the caller's
 * own row policies and bound to the path company, so a source the caller cannot see, or another company's,
 * resolves no branch: the gate then asks for company-wide authority, and whoever holds it gets the handler's
 * 404. A principal restricted to the sending branch therefore drafts on its own authority there, and one
 * restricted elsewhere cannot steer the gate to a branch it holds.
 */
export const transferSourceBranch: GateBranch = async (tx, { companyId, body }) => {
  const from = UuidSchema.safeParse(body.fromWarehouseId);
  if (!from.success) return null;
  const [source] = await tx<{ branch_id: string }[]>`
    select branch_id from app.warehouse
     where id = ${from.data} and company_id = ${companyId} and archived_at is null`;
  return source?.branch_id ?? null;
};

const distinct = (ids: readonly (string | null | undefined)[]): string[] => [
  ...new Set(ids.filter((id): id is string => typeof id === "string")),
];

/**
 * 2026-11-15 review, INV-10. `document_line`'s item, unit and lot keys are composite on `(tenant_id, x)` and
 * bound the TENANT only, and `draftTransfer` inserts the ids as given — so each is bound to the PATH company
 * here, as the generic line route binds them (`assertLinesBelong`, `routes/accounting/documents.ts`), and a
 * lot to its line's ITEM as well: a lot of item Y under item X would, with a negative-stock override, write
 * a stock-on-hand row for X under Y's lot. Archived items and lots are refused; `unit_of_measure` has no
 * `archived_at`. 404, never 403: a row of another company is not confirmed to exist (§4.2.4).
 */
async function assertTransferLinesBelong(
  tx: Tx,
  companyId: string,
  lines: readonly { itemId: string; unitId: string; lotId?: string | null | undefined }[],
): Promise<void> {
  const itemIds = distinct(lines.map((line) => line.itemId));
  const unitIds = distinct(lines.map((line) => line.unitId));
  const lotIds = distinct(lines.map((line) => line.lotId));
  const items = new Set(
    (
      await tx<{ id: string }[]>`
        select id from app.item
         where company_id = ${companyId} and archived_at is null and id = any(${itemIds}::uuid[])`
    ).map((row) => row.id),
  );
  const units = new Set(
    (
      await tx<{ id: string }[]>`
        select id from app.unit_of_measure
         where company_id = ${companyId} and id = any(${unitIds}::uuid[])`
    ).map((row) => row.id),
  );
  const lotItem = new Map(
    lotIds.length === 0
      ? []
      : (
          await tx<{ id: string; item_id: string }[]>`
            select id, item_id from app.lot
             where company_id = ${companyId} and archived_at is null and id = any(${lotIds}::uuid[])`
        ).map((row) => [row.id, row.item_id] as const),
  );
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (!items.has(line.itemId)) {
      throw new AppError(
        "ERR_NOT_FOUND",
        `${at}: no live item ${line.itemId} in company ${companyId}`,
      );
    }
    if (!units.has(line.unitId)) {
      throw new AppError(
        "ERR_NOT_FOUND",
        `${at}: no unit of measure ${line.unitId} in company ${companyId}`,
      );
    }
    if (typeof line.lotId === "string" && lotItem.get(line.lotId) !== line.itemId) {
      throw new AppError(
        "ERR_NOT_FOUND",
        `${at}: no live lot ${line.lotId} of item ${line.itemId} in company ${companyId}`,
      );
    }
  });
}

export const transferRoute = createRoute({
  method: "post",
  path: "/transfers",
  tags: ["accounting"],
  summary: "Draft a stock transfer (dispatch) into the receiving branch's in-transit warehouse",
  // §4.5.4's `create` stage: no `:documentId` exists yet, so the middleware resolves the policy of the type
  // named in the BODY — TRANSFER's `approval.create` (inventory.transfer.create) — and asks it at the source
  // warehouse's branch (`transferSourceBranch`).
  middleware: [requireDocumentPermission("create", { branch: transferSourceBranch })] as const,
  request: {
    params: z.object({ companyId: UuidSchema }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: TransferDraftBody } } },
  },
  responses: {
    201: {
      description: "The drafted transfer",
      content: { "application/json": { schema: TransferDraftSchema } },
    },
    400: {
      description:
        "Same source and destination, a non-stock source or destination, no in-transit warehouse for the destination's branch, a document type whose policy is not a transfer dispatch, or a type only its own service drafts (FX_REVALUATION)",
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
  },
});

export const transferHandler: RouteHandler<typeof transferRoute, AppEnv> = async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  // The type code is the body's, so a service-only type is refused before any read (code review 3, R6's
  // verification: this route drafted an FX_REVALUATION on c7d26b4).
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
          `document type ${body.documentTypeCode} is not configured in company ${companyId}`,
        );
      }
      // BOTH warehouses are bound to the PATH company. RLS bounds the tenant and nothing else, and
      // `draftTransfer` takes the company from the SOURCE warehouse — so without this a caller cleared for
      // company A could name company B's warehouses and draft, issue and post a document in company B. The
      // source is bound here, under the caller's own policies. The destination is bound by `draftTransfer`
      // itself, to the source's company: a principal restricted to the sending branch cannot see it (Form A″
      // shows a stock warehouse only to its own branch), and the service resolves its corridor through the
      // bounded, company-bound lookup of ADR 0043's amendment. 404, never 403: a row the caller may not see is
      // not confirmed to exist (§4.2.4).
      const [source] = await tx<{ id: string }[]>`
        select id from app.warehouse where id = ${body.fromWarehouseId} and company_id = ${companyId}`;
      if (source === undefined) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `no warehouse ${body.fromWarehouseId} in company ${companyId}`,
        );
      }
      await assertTransferLinesBelong(tx, companyId, body.lines);
      const drafted = await draftTransfer(tx, c.var.ctx, {
        documentTypeId: type.id,
        series: body.series,
        effectiveDate: body.effectiveDate,
        fromWarehouseId: body.fromWarehouseId,
        toWarehouseId: body.toWarehouseId,
        lines: body.lines.map((line) => ({
          itemId: line.itemId,
          unitId: line.unitId,
          lotId: line.lotId ?? null,
          quantity: line.quantity,
        })),
      });
      return { ...drafted, finalWarehouseId: null };
    });
    return c.json(result, 201);
  } catch (e) {
    throw asAppError(e);
  }
};
