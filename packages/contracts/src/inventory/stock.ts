import { z } from "zod";
import { DateSchema, ListEnvelope, ListQuery, QuantitySchema, UuidSchema } from "../common";

/** See the note in `price-list.ts`: `listStockOnHand` returns `updated_at::text`, Postgres' own text form,
 *  which `TimestampSchema` (`datetime({ offset: true })`) rejects. */
const PgTimestampSchema = z.string().min(1);

export const StockOnHandSchema = z.object({
  companyId: UuidSchema,
  itemId: UuidSchema,
  itemCode: z.string(),
  itemNameEn: z.string(),
  warehouseId: UuidSchema,
  warehouseCode: z.string(),
  lotId: UuidSchema,
  lotCode: z.string(),
  expiresOn: DateSchema.nullable(),
  /** A fixed-6-dp STRING; no JSON number holds a quantity (spec:2043, assumption 13). */
  quantity: QuantitySchema,
  updatedAt: PgTimestampSchema,
});

export const StockOnHandQuery = ListQuery.extend({
  "filter[itemId][eq]": UuidSchema.optional(),
  "filter[warehouseId][eq]": UuidSchema.optional(),
  "filter[lotId][eq]": UuidSchema.optional(),
  // `z.stringbool()`, not `z.coerce.boolean()`: coerce is `Boolean("false")`, which is true, so
  // `?nonZeroOnly=false` would drop the settled rows the caller asked to see.
  nonZeroOnly: z.stringbool().default(false),
});
export const StockOnHandList = ListEnvelope(StockOnHandSchema);

export const FefoPickSchema = z.object({ lotId: UuidSchema, quantity: QuantitySchema });
/** Not a `ListEnvelope`: a pick is one answer to one quantity, returned whole. A page of it would be a
 *  partial allocation the caller cannot reassemble. */
export const FefoPickList = z.object({ items: z.array(FefoPickSchema) });

/**
 * `.refine` is the one place in this slice where a quantity string reaches `Number.parseFloat`, and it is
 * legal: the value is compared against zero for a VALIDATION decision and is never stored, returned or
 * arithmetically combined. `no-number-money` targets a property, parameter or variable *typed* `number`
 * (§3.7.5) and this is neither. It exists so `app.pick_lots_fefo`'s own `ERR_VALIDATION_FAILED` raise is a
 * defence in depth rather than the caller's error message.
 */
export const FefoQuery = z.object({
  itemId: UuidSchema,
  warehouseId: UuidSchema,
  quantity: QuantitySchema.refine((q) => Number.parseFloat(q) > 0, {
    message: "quantity must be positive",
  }),
});
