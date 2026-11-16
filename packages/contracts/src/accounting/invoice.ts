import { z } from "zod";
import { DateSchema, PositiveQuantitySchema, UuidSchema } from "../common";

/**
 * 4A Task 6 — the delivery-to-invoice conversion (spec:1051's "4 (invoice link)"). Task 8 appends the
 * credit-note bodies to this file: a conversion and a credit note are two shapes of one noun.
 *
 * The SOURCE document is the path parameter and the TARGET type is in the body, because the target does not
 * exist yet. Quantities are the 6-dp strings 3C's document sub-resources use (§4.2.8's registered exception).
 */
export const ConvertLineSchema = z
  .object({
    sourceLineId: UuidSchema,
    /** How much of the source line to invoice. Strictly positive; more than its open quantity is refused by
     *  3C's guard with ERR_DOC_LINK_OVER_FULFILLED. */
    quantity: PositiveQuantitySchema,
    /** 5A — this line's tax code, a code of the path company. Absent: the body's `taxCodeId`, else the
     *  source line's own code. `null` is an explicit "no code" for this line, never a fall-through. The tax
     *  itself is computed server-side at persist time (spec:2228). */
    taxCodeId: UuidSchema.nullable().optional(),
  })
  .strict();

export const ConvertToInvoiceBody = z
  .object({
    /** A document type of the path company — SALES_INVOICE for a delivery, PURCHASE_INVOICE for a receipt.
     *  The handler and the service both bind it to the path company, so a sibling company's type is 404. */
    targetDocumentTypeId: UuidSchema,
    targetSeries: z.string().regex(/^[A-Z0-9-]{1,16}$/),
    effectiveDate: DateSchema,
    /** 5A — the tax code of every converted line that names none of its own, so the empty-`lines` "convert
     *  everything" call can be taxed too. A code of the path company. Absent: each source line's own code.
     *  `null` is an explicit "no code" for those lines: the source lines' codes are then not inherited, which
     *  is how a tax-inclusive source whose lines carry codes is converted untaxed on purpose. */
    taxCodeId: UuidSchema.nullable().optional(),
    /** Empty means every open line at its full open quantity. One entry per source line. */
    lines: z.array(ConvertLineSchema).default([]),
  })
  .strict()
  .refine((b) => new Set(b.lines.map((l) => l.sourceLineId)).size === b.lines.length, {
    message: "each source line may be named once",
    path: ["lines"],
  });

export const ConvertToInvoiceResultSchema = z.object({
  /** The DRAFT invoice. Issuing and posting it is `POST …/documents/{documentId}/transitions`. */
  documentId: UuidSchema,
  lineIds: z.array(UuidSchema),
  /** 3C's `converts_to` rows, one per converted line. */
  linkIds: z.array(UuidSchema),
});

export type ConvertToInvoiceBodyDto = z.infer<typeof ConvertToInvoiceBody>;
export type ConvertToInvoiceResultDto = z.infer<typeof ConvertToInvoiceResultSchema>;

/**
 * 4A Task 8 — the PARTIAL credit note against a posted invoice (spec:2024). A full credit is 2B's
 * `POST …/documents/{documentId}/reverse`, which produces the same type through `reverseDocument`.
 */
export const CreditNoteLineSchema = z
  .object({
    settledLineId: UuidSchema,
    /** POSITIVE: how many come back. The service negates (§4.4.2 A9), so a caller never spells a minus; more
     *  than is still open on the invoice line is refused by 3C's guard with ERR_DOC_LINK_OVER_FULFILLED. */
    quantity: PositiveQuantitySchema,
  })
  .strict();

export const CreditNoteBody = z
  .object({
    /** The type the invoice's pinned policy reverses into — SALES_CREDIT_NOTE for a SALES_INVOICE,
     *  PURCHASE_CREDIT_NOTE for a PURCHASE_INVOICE — and a type of the path company. */
    targetDocumentTypeId: UuidSchema,
    targetSeries: z.string().regex(/^[A-Z0-9-]{1,16}$/),
    effectiveDate: DateSchema,
    /** REQUIRED, and not decoration: it reaches `document_event.reason` on the note's draft → issued row,
     *  which is why the route returns the note ISSUED rather than drafted. */
    reason: z.string().min(1).max(2000),
    /** Empty means every quantity-bearing line at its open quantity. One entry per invoice line. */
    lines: z.array(CreditNoteLineSchema).default([]),
  })
  .strict()
  .refine((b) => new Set(b.lines.map((l) => l.settledLineId)).size === b.lines.length, {
    message: "each invoice line may be named once",
    path: ["lines"],
  });

export const CreditNoteResultSchema = z.object({
  /** The ISSUED credit note. Posting it is `POST …/documents/{documentId}/transitions`. */
  documentId: UuidSchema,
  lineIds: z.array(UuidSchema),
  /** 3C's `returns` rows, one per credited line. */
  linkIds: z.array(UuidSchema),
});

export type CreditNoteBodyDto = z.infer<typeof CreditNoteBody>;
export type CreditNoteResultDto = z.infer<typeof CreditNoteResultSchema>;
