import { z } from "zod";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

/** contracts §4.5.8: which module's READ permission may download this document's attachments. It is NOT the
 *  module segment of approval.post — PAYROLL_PAYMENT posts under accounting.payment.post and is 'hr'. */
export const DocumentTypeModuleSchema = z.enum(["accounting", "inventory", "hr", "pos"]);

export const DocumentTypeSchema = z.object({
  id: UuidSchema,
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  module: DocumentTypeModuleSchema,
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

export const CreateDocumentTypeBody = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).optional(),
    module: DocumentTypeModuleSchema,
  })
  .strict();

/** Literal `filter[<field>][eq]` keys — the §4.2.8 layer-2 default: a literal key IS the declaration of a
 *  filterable field, typed and checked by Zod, visible in the OpenAPI document. */
export const DocumentTypeQuery = ListQuery.extend({
  "filter[code][eq]": z.string().optional(),
  "filter[module][eq]": DocumentTypeModuleSchema.optional(),
  includeArchived: z.enum(["true", "false"]).default("false"),
});
export const DocumentTypeList = ListEnvelope(DocumentTypeSchema);

export const PostingPolicySchema = z.object({
  id: UuidSchema,
  documentTypeId: UuidSchema,
  version: z.number().int().positive(),
  effectiveFrom: DateSchema,
  /** Validated against posting-policy.schema.json (ADR 0022, ADR 0026), not by Zod — a second Zod
   *  transcription of the JSON Schema would be a second spelling of one thing. */
  definition: z.unknown(),
  createdAt: TimestampSchema,
});

export const CreatePostingPolicyBody = z
  .object({
    version: z.number().int().positive(),
    effectiveFrom: DateSchema,
    definition: z.unknown(),
  })
  .strict();

export const PostingPolicyList = ListEnvelope(PostingPolicySchema);
