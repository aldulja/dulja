// packages/contracts/src/pos/reports.ts
import { z } from "zod";
import { DateSchema, ListEnvelope, ListQuery, MoneySchema, UuidSchema } from "../common";
import { ShiftSchema } from "./shift";

export const ZReportTenderSchema = z
  .object({
    method: z.enum(["cash", "card", "transfer", "store_credit"]),
    accountCode: z.string().regex(/^[1-5][0-9]{3}$/),
    amount: MoneySchema,
  })
  .meta({ id: "ZReportTender" });

export const ZReportCashLineSchema = z
  .object({
    documentTypeCode: z.string(),
    amount: MoneySchema,
  })
  .meta({ id: "ZReportCashLine" });

/** The Z-report is the shift PLUS its ledger sections, so it extends `ShiftSchema` rather than restating
 *  eleven fields — one schema for one row shape (§4.2.8's naming convention applied). */
export const ZReportSchema = ShiftSchema.extend({
  ticketCount: z.number().int(),
  returnCount: z.number().int(),
  tenders: z.array(ZReportTenderSchema),
  cashControl: z.array(ZReportCashLineSchema),
  tillEvents: z.array(z.object({ kind: z.string(), count: z.number().int() })),
}).meta({ id: "ZReport" });
export const ZReportList = ListEnvelope(ZReportSchema);

/**
 * One code, two shapes (§4.16.1): `shiftId` for one report, `from`/`to` for the history.
 *
 * **It stays a plain `ZodObject`, and the either/or check lives in the handler.** An earlier draft wrote
 * `.refine((q) => q.shiftId !== undefined || (q.from !== undefined && q.to !== undefined))` here, which
 * wraps the schema in a `ZodEffects`. 0B settled that exact question in the same words for
 * `AuditLogQuery` (0b:4317): *"`@hono/zod-openapi` generates query parameters from a `ZodObject`, and a
 * `.refine` would wrap the schema in `ZodEffects`"* — so a refined query schema can fail parameter
 * generation and the OpenAPI diff check of Step 8. §4.18 makes 0B the authority on its own convention.
 * `.strict()` is likewise not used: 1B applies it to a report query, but `legacy-036` sends undeclared
 * `where=` / `filter=` keys and expects them stripped (0b:4318), and this route is on that path.
 */
export const ZReportQuery = ListQuery.extend({
  shiftId: UuidSchema.optional(),
  branchId: UuidSchema.optional(),
  from: DateSchema.optional(),
  to: DateSchema.optional(),
});

/** **Four deliberate renames between the db tier and the wire**, stated here and again in the handler:
 *  `salesByCashier` returns `netSalesBase` / `discountBase` / `cashRoundingBase` / `overShortBase` — the
 *  `Base` suffix records that the figure is in the company's base currency, which matters inside
 *  `packages/db` where a caller could otherwise mistake it for a document-currency amount. On the wire every
 *  money member is already a `{ amount, currency }` pair carrying `baseCurrency`, so the suffix is redundant
 *  noise in a DTO. The mapping is `netSalesBase → netSales`, `discountBase → discount`,
 *  `cashRoundingBase → cashRounding`, `overShortBase → overShort`, and it lives in exactly one place: Step 4's
 *  `pos.sales_by_cashier` handler.
 *
 *  `discount` is manual discounts only; `cashRounding` is the automatic cash rounding, signed as rounded
 *  payable − original gross, so positive when rounding raised the takings (ADR 0059, owner direction
 *  2026-10-22). The ledger is unchanged: the rounding still posts inside the line discount. */
export const SalesByCashierRowSchema = z
  .object({
    cashierPrincipalId: UuidSchema,
    cashierName: z.string(),
    branchId: UuidSchema,
    ticketCount: z.number().int(),
    returnCount: z.number().int(),
    netSales: MoneySchema,
    discount: MoneySchema,
    cashRounding: MoneySchema,
    overShort: MoneySchema,
  })
  .meta({ id: "SalesByCashierRow" });
export const SalesByCashierList = ListEnvelope(SalesByCashierRowSchema);

export const SalesByCashierQuery = ListQuery.extend({
  from: DateSchema,
  to: DateSchema,
  branchId: UuidSchema.optional(),
  cashierPrincipalId: UuidSchema.optional(),
});
