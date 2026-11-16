import { z } from "zod";
import { ListEnvelope, TimestampSchema, UuidSchema } from "../common";

export const CustomFieldEntitySchema = z.enum(["document", "party", "item", "employee"]);
export const CustomFieldKindSchema = z.enum([
  "text",
  "integer",
  "decimal",
  "money",
  "date",
  "boolean",
  "dimension_value",
  "enum",
]);
export const CustomFieldCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,31}$/, "must be 2–32 upper-case letters, digits or underscores");
export const CustomFieldOptionsSchema = z
  .object({
    enumValues: z.array(z.string().min(1)).min(1).optional(),
    scale: z.number().int().min(0).max(6).optional(),
    dimensionTypeId: UuidSchema.optional(),
    maxLength: z.number().int().min(1).max(4000).optional(),
  })
  .strict();
export const CustomFieldDefinitionSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  entity: CustomFieldEntitySchema,
  documentTypeId: UuidSchema.nullable(),
  code: CustomFieldCodeSchema,
  nameEn: z.string().min(1),
  nameAr: z.string().nullable(),
  kind: CustomFieldKindSchema,
  required: z.boolean(),
  options: CustomFieldOptionsSchema,
  indexed: z.boolean(),
  archivedAt: TimestampSchema.nullable(),
});
export const CreateCustomFieldDefinitionBody = z
  .object({
    entity: CustomFieldEntitySchema,
    documentTypeId: UuidSchema.optional(),
    code: CustomFieldCodeSchema,
    nameEn: z.string().min(1).max(120),
    nameAr: z.string().min(1).max(120).optional(),
    kind: CustomFieldKindSchema,
    required: z.boolean().optional(),
    options: CustomFieldOptionsSchema.optional(),
    indexed: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.kind !== "enum" || (body.options?.enumValues?.length ?? 0) > 0, {
    message: "an enum field must declare options.enumValues",
    path: ["options", "enumValues"],
  });
export const CustomFieldDefinitionQuery = z.object({ entity: CustomFieldEntitySchema });
export const CustomFieldDefinitionList = ListEnvelope(CustomFieldDefinitionSchema);
export const SetCustomFieldValuesBody = z
  .object({
    values: z.array(z.object({ definitionId: UuidSchema, value: z.unknown() })).max(100),
  })
  .strict();
export const CustomFieldValuesResponse = z.object({
  values: z.array(
    z.object({
      definitionId: UuidSchema,
      code: CustomFieldCodeSchema,
      value: z.unknown(),
    }),
  ),
});
