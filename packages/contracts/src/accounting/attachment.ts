import { z } from "zod";
import { ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/** contracts §4.5.8. `objectKey` is '<tenant_id>/<id>' — server-derived (LEGACY-038) — and is returned so a
 *  support engineer can find the object without a second query. */
export const AttachmentSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  documentId: UuidSchema.nullable(),
  /** 3A — spec:1067's "3 (lot link)". Exactly one of `documentId` / `lotId` is non-null. */
  lotId: UuidSchema.nullable(),
  objectKey: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploadedBy: UuidSchema,
  createdAt: TimestampSchema,
});

/**
 * multipart/form-data. `file` is the binary part. 3A made the owner EXACTLY-ONE-OF: a certificate or a
 * permit belongs to a lot (spec:1067), an invoice scan to a document, and never to both. The `.refine`
 * mirrors migration 0031's `attachment_owner_check` so a bad body is a 400 from Zod rather than a 500 from
 * a `check_violation` the handler cannot pre-empt.
 */
export const UploadAttachmentBody = z
  .object({
    documentId: UuidSchema.optional(),
    lotId: UuidSchema.optional(),
    file: z.any(),
  })
  .refine((b) => (b.documentId === undefined) !== (b.lotId === undefined), {
    message: "an attachment belongs to exactly one of a document or a lot",
  });

export const AttachmentQuery = z.object({
  documentId: UuidSchema.optional(),
  /** Literal `filter[<field>][eq]` key — the §4.2.8 layer-2 default; naming it here IS the declaration
   *  that `lotId` is filterable, and no field name ever reaches SQL as text (test 27). */
  "filter[lotId][eq]": UuidSchema.optional(),
  // `z.stringbool()`, not `z.coerce.boolean()`: coerce is `Boolean("false")`, which is true, so
  // `?includeLots=false` would return the lot rows. Defaults to false, which is what keeps 2C's own
  // list assertions unchanged.
  includeLots: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export const AttachmentList = ListEnvelope(AttachmentSchema);
export type AttachmentDto = z.infer<typeof AttachmentSchema>;
