import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

/** §4.6.1 — `kind` is NOT NULL over these three: a service holds no stock and an asset is Phase 10's
 *  fixed-asset register (assumption 6). Nothing in 3A plans a movement for a non-product line. */
export const ItemKindSchema = z.enum(["product", "service", "asset"]);

export const ItemSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  code: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  kind: ItemKindSchema,
  baseUnitId: UuidSchema,
  barcode: z.string().max(64).nullable(),
  taxCodeId: UuidSchema.nullable(),
  revenueAccountId: UuidSchema.nullable(),
  inventoryAccountId: UuidSchema.nullable(),
  cogsAccountId: UuidSchema.nullable(),
  expenseAccountId: UuidSchema.nullable(),
  trackLots: z.boolean(),
  shelfLifeDays: z.number().int().positive().nullable(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

/** The four account ids are OMITTED, not accepted: §4.15's codes are the defaults and `resolveItemAccounts`
 *  resolves them. A caller that could post an arbitrary account id could point COGS at a revenue account. An
 *  override arrives as an account CODE in a later slice, if a tenant asks for one. */
export const CreateItemBody = z
  .object({
    code: z.string().min(1).max(64),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).optional(),
    kind: ItemKindSchema,
    baseUnitId: UuidSchema,
    barcode: z.string().max(64).optional(),
    taxCodeId: UuidSchema.nullable().optional(),
    trackLots: z.boolean().optional(),
    shelfLifeDays: z.number().int().positive().optional(),
  })
  .strict();

/** Identity and unit are set once: `code` is the natural key every price list and import batch points at,
 *  `kind` decides whether the item holds stock at all, and `base_unit_id` is the unit every stored quantity
 *  is already expressed in. `.strict()` turns an attempt into ERR_VALIDATION_FAILED, not a silent no-op. */
export const UpdateItemBody = CreateItemBody.omit({ code: true, kind: true, baseUnitId: true })
  .partial()
  .strict();

/** The `filter[<field>][<op>]` grammar of §4.2.8, with literal Zod keys — the default mechanism for a narrow
 *  surface. `parseFilters` is for a wide or open one, and never both on one route. */
export const ItemQuery = ListQuery.extend({
  "filter[code][eq]": z.string().optional(),
  "filter[kind][eq]": ItemKindSchema.optional(),
  "filter[barcode][eq]": z.string().optional(),
  includeArchived: z.enum(["true", "false"]).default("false"),
});

export const ItemList = ListEnvelope(ItemSchema);
