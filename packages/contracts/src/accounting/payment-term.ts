import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

/**
 * A fraction, 6 dp, exclusive of 0 and 1 — the DDL says so (`payment_term_discount_pct_check`, migration 0044)
 * and the wire says so. Never a `number`: `0.020000` is two per cent, and a float would round wrongly at the
 * fourth decimal of a discount on a large invoice.
 */
const DiscountPctSchema = z
  .string()
  .regex(/^0\.\d{6}$/)
  .refine((pct) => pct !== "0.000000", {
    message: "a discount percentage must be greater than zero",
  });

const CodeSchema = z.string().min(1).max(32);
const NameSchema = z.string().min(1).max(200);
const DaysSchema = z.number().int().min(0);

/** contracts §4.6.1 — one payment term as the API returns it (4A, migration 0044). */
export const PaymentTermSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  code: CodeSchema,
  nameEn: NameSchema,
  nameAr: z.string().max(200).nullable(),
  dueDays: DaysSchema,
  discountDays: DaysSchema.nullable(),
  discountPct: DiscountPctSchema.nullable(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

export const CreatePaymentTermBody = z
  .object({
    code: CodeSchema.regex(/^[A-Z0-9-]+$/),
    nameEn: NameSchema,
    nameAr: z.string().max(200).nullish(),
    dueDays: DaysSchema,
    discountDays: DaysSchema.nullish(),
    discountPct: DiscountPctSchema.nullish(),
  })
  .strict()
  .refine((b) => (b.discountDays == null) === (b.discountPct == null), {
    message: "discountDays and discountPct are supplied together or not at all",
    path: ["discountPct"],
  })
  .refine((b) => b.discountDays == null || b.discountDays <= b.dueDays, {
    message: "discountDays cannot exceed dueDays",
    path: ["discountDays"],
  });

/** `code` is absent by design — a term's code is never renamed (spec:2049 applied to identifiers), and
 *  `.strict()` turns an attempt into ERR_VALIDATION_FAILED rather than a silent no-op. The cross-field window
 *  rule is the database's here (`payment_term_discount_window_check`), because a partial body cannot see the
 *  stored half of the pair. */
export const UpdatePaymentTermBody = z
  .object({
    nameEn: NameSchema.optional(),
    nameAr: z.string().max(200).nullish(),
    dueDays: DaysSchema.optional(),
    discountDays: DaysSchema.nullish(),
    discountPct: DiscountPctSchema.nullish(),
  })
  .strict();

/** §4.2.8 layer 2: a literal `filter[<field>][<op>]` key — one field, one operator, so `parseFilters` is not
 *  the mechanism here. `true` lists archived terms beside live ones; absent or `false` hides them. */
export const PaymentTermQuery = ListQuery.extend({
  "filter[archived][eq]": z.enum(["true", "false"]).optional(),
}).strict();

export const PaymentTermList = ListEnvelope(PaymentTermSchema);
export type PaymentTermDto = z.infer<typeof PaymentTermSchema>;
