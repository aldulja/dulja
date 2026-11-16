import { z } from "zod";
import { DateSchema, ListEnvelope, ListQuery, QuantitySchema, UuidSchema } from "../common";

/**
 * Slice 3B, amendment A8: an ORDINARY LIST module at `/v1/companies/{companyId}/valuation`, gated by
 * `inventory.cost.read`. This is NOT §4.16.1's `inventory.valuation` ReportCode — that is 3D's, mounted on
 * 1B's `reports` module at a different path, and it reads `valuationAsOf` rather than re-deriving anything.
 */

/** A money-scaled STRING at 4 dp; no JSON number holds money (§3.7.5, spec:2043). */
const MoneyAmountSchema = z.string().regex(/^-?\d+\.\d{4}$/);

export const ValuationRowSchema = z.object({
  itemId: UuidSchema,
  itemCode: z.string(),
  itemNameEn: z.string(),
  warehouseId: UuidSchema,
  warehouseCode: z.string(),
  quantity: QuantitySchema,
  value: MoneyAmountSchema,
  unitCost: MoneyAmountSchema,
});
export type ValuationRowDto = z.infer<typeof ValuationRowSchema>;

/**
 * `asOf` is REQUIRED, deliberately: a valuation with no date is a question with no answer, and defaulting it
 * to "today" would make the same request mean something different tomorrow. A missing one is
 * `ERR_VALIDATION_FAILED`, not a silent default.
 *
 * `.strict()` for the reason `accounting/reports.ts` gives: `ListQuery` is a plain `z.object`, which STRIPS
 * unknown keys, so without it a misspelled `filter[…]` would be dropped silently and answer 200.
 */
export const ValuationQuery = ListQuery.extend({
  asOf: DateSchema,
  "filter[item_id][eq]": UuidSchema.optional(),
  "filter[warehouse_id][eq]": UuidSchema.optional(),
}).strict();

export const ValuationList = ListEnvelope(ValuationRowSchema);

export const CostLayerRowSchema = z.object({
  layerId: UuidSchema,
  movementId: UuidSchema,
  documentId: UuidSchema,
  documentTypeCode: z.string(),
  number: z.string().nullable(),
  warehouseId: UuidSchema,
  warehouseCode: z.string(),
  lotId: UuidSchema,
  lotCode: z.string(),
  lotExpiresOn: DateSchema.nullable(),
  qtyIn: QuantitySchema,
  qtyRemaining: QuantitySchema,
  unitCost: MoneyAmountSchema,
  value: MoneyAmountSchema,
  effectiveAt: DateSchema,
  /** `cost_layer.sequence` is a bigint — a string, never a JSON number. */
  sequence: z.string(),
});
export type CostLayerRowDto = z.infer<typeof CostLayerRowSchema>;

/** Layers are read ONE ITEM AT A TIME, so the item filter is required here where the valuation makes it
 *  optional. A page of every item's layers is not a list anybody reads. */
export const CostLayerQuery = ValuationQuery.extend({
  "filter[item_id][eq]": UuidSchema,
}).strict();

export const CostLayerList = ListEnvelope(CostLayerRowSchema);
