import { z } from "zod";
import { DateSchema, NonNegativeQuantitySchema, QuantitySchema, UuidSchema } from "../common";

/**
 * 3D T8 — the stock-count wire contracts (spec:1052, 2026).
 *
 * A count sheet is a `STOCK_COUNT` document whose lines carry migration 0040's two columns. The three
 * routes are sub-paths of 1A's generic `documents` module, so this slice adds no `RouteModule` and no
 * `PROBES` entry (§4.2.7).
 */

export const CountSheetLineSchema = z.object({
  documentLineId: UuidSchema,
  lineNo: z.number().int().positive(),
  itemId: UuidSchema,
  itemCode: z.string(),
  warehouseId: UuidSchema,
  lotId: UuidSchema,
  lotCode: z.string(),
  /** Nullable on the wire, and **nulled by the route** for a principal who does not hold
   *  `inventory.adjustment.approve`: a counter who can see the expected figure confirms it instead of
   *  counting, which is the one control the legacy process lacked. The accountant reviewing the sheet sees
   *  it; the counter does not. The service always returns it — the projection is the route's. */
  expectedQuantity: QuantitySchema.nullable(),
  countedQuantity: QuantitySchema.nullable(),
  /** `counted − expected`, null while `countedQuantity` is. Signed: a shortfall is negative. */
  variance: QuantitySchema.nullable(),
});

export const CountSheetBody = z
  .object({
    /** A §4.14 CODE, not an id. The handler resolves it against the PATH company, so a sibling company's
     *  type of the same code is not reachable. §4.5.4's `create` stage resolves the gate from it. */
    documentTypeCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    series: z.string().regex(/^[A-Z0-9-]{1,16}$/),
    effectiveDate: DateSchema,
    warehouseId: UuidSchema,
    /** A cycle count over a subset; omitted or empty means every key with stock in the warehouse. */
    itemIds: z.array(UuidSchema).optional(),
    /** Include keys whose projected quantity is zero. Default false. */
    includeZero: z.boolean().optional(),
  })
  .strict();

export const RecordCountsBody = z
  .object({
    counts: z
      .array(z.object({ documentLineId: UuidSchema, countedQuantity: NonNegativeQuantitySchema }))
      .min(1),
  })
  .strict();

export const CountSheetResultSchema = z.object({
  documentId: UuidSchema,
  lines: z.array(CountSheetLineSchema),
});
