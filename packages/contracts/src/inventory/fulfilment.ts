import { z } from "zod";
import { DateSchema, QuantitySchema, UuidSchema, PositiveQuantitySchema } from "../common";
import { DocumentLinkSchema, OpenQuantitySchema } from "../accounting/document-link";

/**
 * 3D T5 — the order-to-fulfilment conversion body (SALES_ORDER → DELIVERY_ORDER, spec:1050-1051).
 *
 * The SOURCE order is the path parameter and the TARGET type is in the body, because the target does not
 * exist yet: there is nothing to name in the path. §4.5.4 covers exactly this shape for the `create` stage.
 */
export const ConvertDocumentBody = z.object({
  /** A §4.14 CODE, not an id: a client has no way to know a `document_type` uuid. The handler resolves it
   *  against the path company, so a sibling company's type of the same code is not reachable. */
  targetDocumentTypeCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  targetSeries: z.string().regex(/^[A-Z0-9-]{1,16}$/),
  effectiveDate: DateSchema,
  /** The warehouse every drafted line ships from. Required, and never defaulted from the header: the
   *  costing engine needs a warehouse per line and a null one is an `ERR_POLICY_REQUIRES_MISSING` at post. */
  warehouseId: UuidSchema,
  /** Resolve each drafted line's lot through `app.pick_lots_fefo`, splitting one order line into one
   *  drafted line per lot (the Phase 3 definition-of-done clause on FEFO picking). */
  fefo: z.boolean().default(true),
  /** A line omitted here stays fully open — a back-order (spec:1050). */
  lines: z.array(z.object({ sourceLineId: UuidSchema, quantity: PositiveQuantitySchema })).min(1),
});

export const ConvertResultLineSchema = z.object({
  targetLineId: UuidSchema,
  sourceLineId: UuidSchema,
  lineNo: z.number().int().positive(),
  itemId: UuidSchema,
  warehouseId: UuidSchema,
  lotId: UuidSchema.nullable(),
  quantity: QuantitySchema,
});

export const ConvertResultSchema = z.object({
  documentId: UuidSchema,
  lines: z.array(ConvertResultLineSchema),
  links: z.array(DocumentLinkSchema),
  /** The source order's open quantity AFTER the links were written, read back from 3C's view and never
   *  computed (SAH-017, SAH-018: a remaining quantity is a projection, never a stored column). */
  remaining: z.array(OpenQuantitySchema),
});
