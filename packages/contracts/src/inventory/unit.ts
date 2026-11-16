import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const UnitSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  code: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  createdAt: TimestampSchema,
});

export const CreateUnitBody = z
  .object({
    code: z.string().min(1).max(64),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).optional(),
  })
  .strict();

/** A unit has no `archived_at` (§4.6.1) and no archive route: there is nothing to filter on. */
export const UnitQuery = ListQuery;

export const UnitList = ListEnvelope(UnitSchema);

/**
 * "1 <unit> = numerator / denominator base units" (SAH-066). Both parts are `bigint` in SQL and cross this
 * boundary as digit STRINGS — never `number`, which loses precision above 2^53 and is what `no-number-money`
 * forbids for a rate (assumption 13).
 *
 * The two regexes are what make `denominator: "0"` a 400 with a JSON Pointer rather than a 500 raised by
 * `unit_conversion_denominator_check` — SAH-063 answered at the wire as well as in the schema. Negatives are
 * meaningless for a package factor, so neither part admits a sign.
 */
export const UnitConversionSchema = z.object({
  itemId: UuidSchema,
  unitId: UuidSchema,
  unitCode: z.string(),
  numerator: z.string().regex(/^[1-9][0-9]{0,17}$/),
  denominator: z.string().regex(/^[1-9][0-9]{0,17}$/),
});

export const ReplaceUnitConversionsBody = z
  .object({
    conversions: z
      .array(UnitConversionSchema.pick({ unitId: true, numerator: true, denominator: true }))
      .max(50),
  })
  .strict();

export const UnitConversionList = ListEnvelope(UnitConversionSchema);
