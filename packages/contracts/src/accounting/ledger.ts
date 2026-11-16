import { z } from "zod";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const LedgerEntrySchema = z.object({
  id: UuidSchema,
  documentId: UuidSchema,
  lineNo: z.number().int().positive(),
  accountId: UuidSchema,
  debit: z.string(),
  credit: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  exchangeRate: z.string(),
  baseDebit: z.string(),
  baseCredit: z.string(),
  effectiveDate: DateSchema,
  fiscalPeriodId: UuidSchema,
  postingPolicyId: UuidSchema,
  postedAt: TimestampSchema,
  postedBy: UuidSchema,
});

export const LedgerEntryQuery = ListQuery.extend({
  accountId: UuidSchema.optional(),
  fiscalPeriodId: UuidSchema.optional(),
  documentId: UuidSchema.optional(),
  from: DateSchema.optional(),
  to: DateSchema.optional(),
});
export const LedgerEntryList = ListEnvelope(LedgerEntrySchema);
