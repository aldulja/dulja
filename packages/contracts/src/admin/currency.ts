import { z } from "zod";
import {
  CurrencySchema as CurrencyCodeSchema,
  ListEnvelope,
  ListQuery,
  TimestampSchema,
  UuidSchema,
} from "../common";

export const RoundingModeSchema = z.enum([
  "HALF_AWAY_FROM_ZERO",
  "HALF_EVEN",
  "TOWARD_ZERO",
  "AWAY_FROM_ZERO",
]);
/** Four decimals, and never zero: the first consumer (6B's tender path) divides by it, and migration 0107
 *  holds the same rule on the column. */
const IncrementSchema = z
  .string()
  .regex(/^\d+\.\d{4}$/, "must have exactly four decimal places")
  .refine((value) => !/^0+\.0000$/.test(value), "must be greater than zero");

export const CurrencySchema = z.object({
  id: UuidSchema,
  code: CurrencyCodeSchema,
  nameEn: z.string().min(1),
  nameAr: z.string().nullable(),
  minorUnits: z.number().int().min(0).max(4),
  posRoundingIncrement: IncrementSchema,
  roundingMode: RoundingModeSchema,
  archivedAt: TimestampSchema.nullable(),
});

export const CreateCurrencyBody = z.object({
  companyId: UuidSchema,
  code: CurrencyCodeSchema,
  nameEn: z.string().min(1).max(120),
  nameAr: z.string().min(1).max(120).optional(),
  minorUnits: z.number().int().min(0).max(4).optional(),
  posRoundingIncrement: IncrementSchema.optional(),
  roundingMode: RoundingModeSchema.optional(),
});

export const UpdateCurrencyBody = z.object({
  companyId: UuidSchema,
  nameEn: z.string().min(1).max(120).optional(),
  nameAr: z.string().min(1).max(120).nullable().optional(),
  minorUnits: z.number().int().min(0).max(4).optional(),
  posRoundingIncrement: IncrementSchema.optional(),
  roundingMode: RoundingModeSchema.optional(),
  archived: z.boolean().optional(),
});

export const CurrencyQuery = ListQuery.extend({
  // `z.stringbool()`, not `z.coerce.boolean()`: coerce is `Boolean("false")`, which is true, so
  // `?includeArchived=false` used to return the archived rows. stringbool reads true/false/1/0/yes/no.
  includeArchived: z.stringbool().default(false),
});
export const CurrencyList = ListEnvelope(CurrencySchema);
