import { z } from "zod";
import {
  ListEnvelope,
  PositiveQuantitySchema,
  QuantitySchema,
  TimestampSchema,
  UuidSchema,
} from "../common";

export const LinkKindSchema = z.enum([
  "fulfils",
  "converts_to",
  "receives_against",
  "returns",
  "settles",
]);

export const DocumentLinkSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  sourceDocumentId: UuidSchema,
  sourceLineId: UuidSchema.nullable(),
  targetDocumentId: UuidSchema,
  targetLineId: UuidSchema.nullable(),
  linkKind: LinkKindSchema,
  quantity: QuantitySchema.nullable(),
  /** A 4-dp decimal string and NOT `MoneySchema`, under the exception §4.2.8 registers for this slice:
   *  `app.document_link` has no currency column, and the currency is the one named by the `{documentId}`
   *  in this route's own path. The figure is still computed in `Money` and still scale 4. */
  amount: z
    .string()
    .regex(/^-?\d+\.\d{4}$/)
    .nullable(),
  createdAt: TimestampSchema,
});

export const CreateDocumentLinksBody = z.object({
  sourceDocumentId: UuidSchema,
  linkKind: LinkKindSchema,
  /** Copy the source line's unit price onto an unpriced target line (spec:1050). Default true. 5A: a copy
   *  between documents of different `taxInclusive` is refused (400), and for `fulfils` and `receives_against`
   *  the source line's tax code rides the copy onto a target line naming none. */
  priceFromSource: z.boolean().default(true),
  lines: z
    .array(
      z.object({
        sourceLineId: UuidSchema,
        targetLineId: UuidSchema,
        quantity: PositiveQuantitySchema,
      }),
    )
    .min(1),
});

export const DocumentLinkList = ListEnvelope(DocumentLinkSchema);

export const OpenQuantitySchema = z.object({
  documentId: UuidSchema,
  documentLineId: UuidSchema,
  lineNo: z.number().int().positive(),
  itemId: UuidSchema.nullable(),
  orderedQuantity: QuantitySchema,
  linkedQuantity: QuantitySchema,
  openQuantity: QuantitySchema,
});

export const OpenQuantityList = ListEnvelope(OpenQuantitySchema);
