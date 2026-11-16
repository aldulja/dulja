import { z } from "zod";
import {
  DateSchema,
  NonNegativeQuantitySchema,
  PositiveQuantitySchema,
  UuidSchema,
} from "../common";

/**
 * 3D T7 — the dispatch leg of the two-step transfer (spec:1053).
 *
 * `toWarehouseId` is the FINAL destination — a `kind = 'stock'` warehouse at the receiving branch — and the
 * corridor is resolved server-side by `resolveInTransitWarehouse` (ADR 0043). A client never names an
 * in-transit warehouse, which is what stops a caller posting straight into the destination and making the
 * definition-of-done clause quietly false.
 *
 * `documentTypeCode` and `effectiveDate` are not decoration: §4.5.4's `create` stage resolves this route's
 * permission code from the policy of the type this body names, at this date, because no document exists yet.
 *
 * `.strict()`, as 3D Task 7 specified: this body declares no `branchId`, because the draft carries the source
 * warehouse's branch. Stripped instead of refused, a stray `branchId` once steered the create gate to a branch
 * the draft would not carry (Phase 6 plan audit, 2026-10-23). Since ADR 0043's amendment (accepted by the owner
 * 2026-11-04) that gate no longer reads a body `branchId` for this route at all: it asks at the source
 * warehouse's branch (`transferSourceBranch` in apps/api), and a body naming one is still refused here.
 */
export const TransferDraftBody = z
  .object({
    documentTypeCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    series: z.string().regex(/^[A-Z0-9-]{1,16}$/),
    effectiveDate: DateSchema,
    fromWarehouseId: UuidSchema,
    toWarehouseId: UuidSchema,
    lines: z
      .array(
        z.object({
          itemId: UuidSchema,
          unitId: UuidSchema,
          lotId: UuidSchema.nullable().optional(),
          quantity: PositiveQuantitySchema,
        }),
      )
      .min(1),
  })
  .strict();

/**
 * The response of both transfer sub-paths — the dispatch here and the receipt at Task 8. Both drafting
 * services return a document, its line ids and the warehouse the caller could not have known:
 * `inTransitWarehouseId` on dispatch, `finalWarehouseId` on receipt. One schema with both members nullable
 * keeps Task 13's `transfer-api.ts` to one parser.
 */
export const TransferDraftSchema = z.object({
  documentId: UuidSchema,
  lineIds: z.array(UuidSchema),
  inTransitWarehouseId: UuidSchema.nullable(),
  finalWarehouseId: UuidSchema.nullable(),
});

/**
 * 3D T8 — the receive leg's body (spec:1053). `{documentId}` in the path is the posted `TRANSFER` being
 * received; the corridor and the final destination are read from it server-side, exactly as the dispatch
 * resolves the corridor rather than accepting one.
 *
 * `received` is optional because a line omitted arrives IN FULL, which is the common case. A `countedQuantity`
 * that differs from the dispatched quantity is spec:1053's "variance on receipt", and the difference lands on
 * `5110` through the policy's two conditional leg pairs.
 */
export const TransferReceiptBody = z
  .object({
    documentTypeCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    series: z.string().regex(/^[A-Z0-9-]{1,16}$/),
    effectiveDate: DateSchema,
    received: z
      .array(z.object({ transferLineId: UuidSchema, countedQuantity: NonNegativeQuantitySchema }))
      .optional(),
  })
  .strict();
