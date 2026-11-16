import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const DimensionCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,31}$/, "must be 2–32 upper-case letters, digits or underscores");
export const DimensionTypeSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  code: DimensionCodeSchema,
  nameEn: z.string().min(1),
  nameAr: z.string().nullable(),
});
export const CreateDimensionTypeBody = z
  .object({
    code: DimensionCodeSchema,
    nameEn: z.string().min(1).max(120),
    nameAr: z.string().min(1).max(120).optional(),
  })
  .strict();
export const DimensionValueSchema = z.object({
  id: UuidSchema,
  dimensionTypeId: UuidSchema,
  code: DimensionCodeSchema,
  nameEn: z.string().min(1),
  nameAr: z.string().nullable(),
  parentId: UuidSchema.nullable(),
  archivedAt: TimestampSchema.nullable(),
});
export const CreateDimensionValueBody = z
  .object({
    code: DimensionCodeSchema,
    nameEn: z.string().min(1).max(120),
    nameAr: z.string().min(1).max(120).optional(),
    parentId: UuidSchema.optional(),
  })
  .strict();
export const UpdateDimensionValueBody = z
  .object({
    nameEn: z.string().min(1).max(120).optional(),
    nameAr: z.string().min(1).max(120).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export const DimensionValueQuery = ListQuery.extend({
  // `z.stringbool()`, not `z.coerce.boolean()`: coerce is `Boolean("false")`, which is true, so
  // `?includeArchived=false` used to return the archived rows. stringbool reads true/false/1/0/yes/no.
  includeArchived: z.stringbool().default(false),
});
export const DimensionTypeList = ListEnvelope(DimensionTypeSchema);
export const DimensionValueList = ListEnvelope(DimensionValueSchema);
