import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const AccountTypeSchema = z.enum(["asset", "liability", "equity", "income", "expense"]);

export const AccountSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  nameEn: z.string(),
  nameAr: z.string().nullable(),
  type: AccountTypeSchema,
  parentId: UuidSchema.nullable(),
  isGroup: z.boolean(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

export const CreateAccountBody = z.object({
  code: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9._-]+$/),
  nameEn: z.string().min(1),
  nameAr: z.string().min(1).optional(),
  type: AccountTypeSchema,
  parentId: UuidSchema.optional(),
  isGroup: z.boolean().default(false),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

export const UpdateAccountBody = z.object({
  nameEn: z.string().min(1).optional(),
  nameAr: z.string().min(1).optional(),
  parentId: UuidSchema.nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
});

/** Filterable and sortable fields are declared, never taken as text — no field name reaches SQL (test 27). */
export const AccountQuery = ListQuery.extend({
  type: AccountTypeSchema.optional(),
  // `z.stringbool()`, not `z.coerce.boolean()`: coerce is `Boolean("false")`, which is true, so
  // `?includeArchived=false` used to return the archived rows. stringbool reads true/false/1/0/yes/no.
  includeArchived: z.stringbool().default(false),
});

export const AccountList = ListEnvelope(AccountSchema);

export const AccountNodeSchema = AccountSchema.extend({
  depth: z.number().int().min(0),
  path: z.array(z.string()),
});
export const AccountTree = z.object({ items: z.array(AccountNodeSchema) });
