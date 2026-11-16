import { z } from "zod";
import {
  CurrencySchema,
  DateSchema,
  ListEnvelope,
  ListQuery,
  QuantitySchema,
  UuidSchema,
} from "../common";

/**
 * A four-decimal money STRING, the shape `accounting/document.ts` already uses for a line amount. `MoneySchema`
 * is the `{ amount, currency }` pair and does not fit here: a price-list line carries no currency of its own —
 * the LIST carries it (migration 0030), so repeating it per line would let the two disagree.
 */
const UnitPriceSchema = z.string().regex(/^\d+\.\d{4}$/);

/**
 * The 3A data layer returns `timestamptz` columns as `created_at::text` (`packages/db/src/inventory/prices.ts`),
 * which is Postgres' own text form — `2026-09-20 10:00:00+00`, a space rather than a `T`. `TimestampSchema`
 * (`z.string().datetime({ offset: true })`) would reject it. Normalising those columns to RFC 3339 is a change
 * to functions Task 4 shipped and to every caller of them, so the wire contract states what the layer actually
 * produces rather than a shape nothing emits. Recorded in the task report as a deviation to settle in 3D.
 */
const PgTimestampSchema = z.string().min(1);

export const PriceListSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  code: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  currency: CurrencySchema,
  /** The trade level. Migration 0030 deliberately puts no CHECK on it: the levels are the tenant's own and
   *  no code branches on them, so the wire schema does not close the vocabulary either. */
  customerKind: z.string().max(64).nullable(),
  /** null = every branch (spec:1312). */
  branchId: UuidSchema.nullable(),
  validFrom: DateSchema.nullable(),
  validTo: DateSchema.nullable(),
  archivedAt: PgTimestampSchema.nullable(),
  createdAt: PgTimestampSchema,
});

export const CreatePriceListBody = z
  .object({
    code: z.string().min(1).max(64),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).optional(),
    currency: CurrencySchema,
    customerKind: z.string().max(64).optional(),
    branchId: UuidSchema.optional(),
    validFrom: DateSchema.optional(),
    validTo: DateSchema.optional(),
  })
  .strict()
  // Mirrors `price_list_window_check` so a reversed window is a 400 naming `validTo` rather than a 500 from a
  // check_violation the handler cannot pre-empt — the same reasoning 2C's attachment owner refine gives.
  .refine((b) => !b.validFrom || !b.validTo || b.validTo >= b.validFrom, {
    message: "validTo must not be before validFrom",
    path: ["validTo"],
  });

/** `code`, `currency` and `branchId` are absent: a list's identity, its money and the branch it belongs to are
 *  set once. `.strict()` turns an attempt into ERR_VALIDATION_FAILED rather than a silent no-op. */
export const UpdatePriceListBody = z
  .object({
    nameEn: z.string().min(1).max(200).optional(),
    nameAr: z.string().max(200).nullable().optional(),
    customerKind: z.string().max(64).nullable().optional(),
    validFrom: DateSchema.nullable().optional(),
    validTo: DateSchema.nullable().optional(),
  })
  .strict()
  .refine((b) => !b.validFrom || !b.validTo || b.validTo >= b.validFrom, {
    message: "validTo must not be before validFrom",
    path: ["validTo"],
  });

export const PriceListQuery = ListQuery.extend({
  /** A branch's lists PLUS the company-wide ones, which is what `listPriceLists` resolves (spec:1312). */
  branchId: UuidSchema.optional(),
  // `z.stringbool()`, not `z.coerce.boolean()`: coerce is `Boolean("false")`, which is true, so
  // `?includeArchived=false` would return the archived lists.
  includeArchived: z.stringbool().default(false),
});
export const PriceListList = ListEnvelope(PriceListSchema);

export const PriceListLineSchema = z.object({
  id: UuidSchema,
  priceListId: UuidSchema,
  itemId: UuidSchema,
  /** null = the item's base unit. */
  unitId: UuidSchema.nullable(),
  minQuantity: QuantitySchema,
  unitPrice: UnitPriceSchema,
  archivedAt: PgTimestampSchema.nullable(),
  createdAt: PgTimestampSchema,
});

/**
 * A replace: the body is the COMPLETE set, the same shape as 1A's `PUT …/documents/{id}/lines`. An omitted
 * line is archived rather than deleted — contracts §3.5.4 pins the `app_rw` DELETE grant list — which is why
 * the response is the surviving set rather than an echo of the request.
 */
export const ReplacePriceListLinesBody = z
  .object({
    lines: z
      .array(
        z
          .object({
            itemId: UuidSchema,
            unitId: UuidSchema.nullable().optional(),
            minQuantity: QuantitySchema.optional(),
            unitPrice: UnitPriceSchema,
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export const PriceListLineList = ListEnvelope(PriceListLineSchema);

export const ResolvedPriceSchema = z.object({
  priceListId: UuidSchema,
  priceListCode: z.string(),
  priceListLineId: UuidSchema,
  unitId: UuidSchema.nullable(),
  minQuantity: QuantitySchema,
  unitPrice: UnitPriceSchema,
});

/**
 * `currency` is REQUIRED, not defaulted: `resolvePrice` filters on it, and a resolver that silently picked the
 * company's base currency would answer a question the caller did not ask. `on` is likewise required — the
 * accounting date is the user's (spec:2039) and is never derived server-side.
 */
export const PriceQuerySchema = z.object({
  itemId: UuidSchema,
  currency: CurrencySchema,
  quantity: QuantitySchema,
  on: DateSchema,
  unitId: UuidSchema.optional(),
  customerKind: z.string().max(64).optional(),
  branchId: UuidSchema.optional(),
});

/** An object wrapping a nullable member rather than a bare nullable body: `{ "price": null }` is a document a
 *  client can validate, `null` is not. "No applicable price" is a SUCCESSFUL answer a screen renders as an
 *  empty price field; a 404 would make an ordinary catalogue gap look like a client error. */
export const ResolvedPriceEnvelope = z.object({ price: ResolvedPriceSchema.nullable() });
