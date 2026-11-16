import { z } from "zod";
import { CurrencySchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/** An IANA zone the runtime knows. The first `at time zone company.timezone` on an unknown name would raise
 *  22023, which `fromDatabaseError` does not map — a 500 for a typo made at company creation. */
export function isTimeZone(value: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}
const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, "must be an IANA time zone name");

export const CompanySchema = z.object({
  id: UuidSchema,
  code: z.string(),
  name: z.string(),
  baseCurrency: CurrencySchema,
  timezone: z.string(),
  createdAt: TimestampSchema,
});
export const CreateCompanyBody = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{1,20}$/),
  name: z.string().min(1).max(200),
  baseCurrency: CurrencySchema,
  timezone: TimeZoneSchema.default("Asia/Kuala_Lumpur"),
});
export const UpdateCompanyBody = z.object({
  name: z.string().min(1).max(200).optional(),
  timezone: TimeZoneSchema.optional(),
});
export const CompanyList = ListEnvelope(CompanySchema);
