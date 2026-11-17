import { z } from "zod";
import {
  DateSchema,
  ListEnvelope,
  ListQuery,
  MoneySchema,
  QuantitySchema,
  UuidSchema,
} from "../common";

/**
 * Slice 3D: the DTOs of two of §4.16.1's three inventory report codes — `inventory.stock_on_hand` and
 * `inventory.sales_by_item` — mounted as GETs on 1B's `reports` module.
 *
 * The third, `inventory.valuation`, deliberately declares NOTHING here: `ValuationRowSchema`,
 * `ValuationQuery` and `ValuationList` are 3B's, in `inventory/valuation.ts`, and its route imports them
 * unchanged. One valuation row type, one valuation read (`valuationAsOf`) — which is the whole answer to
 * LEGACY-009 and the reason this file is not the place to declare a second.
 *
 * Every name carries `Report` because 3A's `StockOnHandSchema` / `StockOnHandQuery` / `StockOnHandList`
 * already leave the contracts barrel from `inventory/stock.ts` for its master-data list route. A duplicate
 * export from one barrel is a TypeScript error, and a duplicate OpenAPI component name downstream.
 */

export const StockOnHandReportRowSchema = z.object({
  itemId: UuidSchema,
  itemCode: z.string(),
  itemNameEn: z.string(),
  warehouseId: UuidSchema,
  warehouseCode: z.string(),
  /** On every row, so "is this stock on a shelf or in a corridor?" is answered by the output rather than
   *  inferred from the query that produced it. */
  warehouseKind: z.enum(["stock", "in_transit"]),
  lotId: UuidSchema,
  lotCode: z.string(),
  lotExpiresOn: DateSchema.nullable(),
  quantity: QuantitySchema,
});
export type StockOnHandReportRowDto = z.infer<typeof StockOnHandReportRowSchema>;

/**
 * `.strict()` for the reason `accounting/reports.ts` gives: `ListQuery` is a plain `z.object`, which STRIPS
 * unknown keys, so without it a misspelled `filter[…]` would be dropped silently and answer 200.
 *
 * `z.stringbool()`, not `z.coerce.boolean()`: coerce is `Boolean("false")`, which is true, so
 * `?includeInTransit=false` would turn the corridor rows back on. The default is `false` because the Phase 3
 * definition-of-done clause is that goods in transit are in NEITHER warehouse's on-hand.
 */
export const StockOnHandReportQuery = ListQuery.extend({
  "filter[item_id][eq]": UuidSchema.optional(),
  "filter[warehouse_id][eq]": UuidSchema.optional(),
  includeInTransit: z.stringbool().default(false),
}).strict();

export const StockOnHandReportList = ListEnvelope(StockOnHandReportRowSchema);

/**
 * "Sales by item" under one code, three shipments (§4.16.1). 3D shipped DELIVERED QUANTITY AND ITS COST,
 * because no document type posted revenue before 4A's SALES_INVOICE; 4A grows the row by exactly two members,
 * `revenue` and `margin` (contracts §4.16.3 amendment 13), in the PR that ships that type, and changes
 * neither the query nor 3D's two members. `cost` is cut on deliveries and `revenue` on invoices, so a range
 * with goods delivered and not yet invoiced shows cost with no revenue — the `1250` balance, not a gap.
 */
export const SalesByItemRowSchema = z.object({
  itemId: UuidSchema,
  itemCode: z.string(),
  itemNameEn: z.string(),
  deliveredQuantity: QuantitySchema,
  /** Every wire amount is `{ amount, currency }` (spec:2043); the currency is the company's base.
   *  **Null** when the caller does not hold `inventory.cost.read` at the report's scope — company-wide, or
   *  the `filter[branch_id]` branch (code review 2, S1): the route is gated by `inventory.stock.read`,
   *  which the clerk holds, and spec:2158 denies the clerk costs. The db `SalesByItemRow` is unchanged. */
  cost: MoneySchema.nullable(),
  /** 4A — Σ over the posted SALES_INVOICE and SALES_CREDIT_NOTE item lines, each converted on its own
   *  document's rate; in base, and negative when returns exceed sales in the range. */
  revenue: MoneySchema,
  /** 4A — `revenue − cost`, in base. Null exactly when `cost` is: revenue minus margin would be the cost. */
  margin: MoneySchema.nullable(),
});
export type SalesByItemRowDto = z.infer<typeof SalesByItemRowSchema>;

/** `fromDate` and `toDate` are REQUIRED and inclusive, on `effective_date` (spec:2039). A sales report with
 *  no range is a question with no answer, and defaulting one would make the same request mean something
 *  different tomorrow — the rule 3B's `ValuationQuery.asOf` states for the same reason. */
export const SalesByItemQuery = ListQuery.extend({
  fromDate: DateSchema,
  toDate: DateSchema,
  "filter[item_id][eq]": UuidSchema.optional(),
  "filter[branch_id][eq]": UuidSchema.optional(),
}).strict();

export const SalesByItemList = ListEnvelope(SalesByItemRowSchema);
