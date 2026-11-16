import { z } from "zod";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const PeriodStatusSchema = z.enum(["open", "closed", "locked"]);

export const FiscalPeriodSchema = z.object({
  id: UuidSchema,
  startsOn: DateSchema,
  endsOn: DateSchema,
  status: PeriodStatusSchema,
  closedBy: UuidSchema.nullable(),
  closedAt: TimestampSchema.nullable(),
  reopenReason: z.string().nullable(),
  createdAt: TimestampSchema,
});

export const FiscalPeriodQuery = ListQuery.extend({ status: PeriodStatusSchema.optional() });
export const FiscalPeriodList = ListEnvelope(FiscalPeriodSchema);
export const ClosePeriodBody = z.object({});
/** spec:2179 — reopening "requires a reason written to the audit row". `.trim().min(1)` refuses whitespace. */
export const ReopenPeriodBody = z.object({ reason: z.string().trim().min(1).max(500) });

/** ADR 0097 (full review PRD-05) — `POST /v1/companies/{companyId}/fiscal-years`. `startMonth` is the month the
 *  fiscal year starts in (1–12); omitted, it is the month the company's earliest period starts in, and a company
 *  with no period must state it. A year that starts after January runs into the next calendar year. */
export const CreateFiscalYearBody = z
  .object({
    fiscalYear: z.number().int().min(2000).max(2100),
    startMonth: z.number().int().min(1).max(12).optional(),
  })
  .strict();
/** The year's twelve periods in date order, and how many of them this request created (0 on a repeat). */
export const FiscalYearSchema = z.object({
  inserted: z.number().int().min(0).max(12),
  items: z.array(FiscalPeriodSchema),
});
