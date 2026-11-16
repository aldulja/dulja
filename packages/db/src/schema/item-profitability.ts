import { numeric, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — revenue, COGS and margin per item per fiscal period (4B, migration 0048). An
 * ASYNCHRONOUS projection (spec:1204): rebuilt by `accounting.projection.rebuild` from
 * `app.item_profitability_rows`, the one definition of the item split (amendments 6 and 7), and compared
 * row for row. 7B's "profit by item" reads it. There is no `id` column — the natural key
 * `(company_id, item_id, fiscal_period_id)` IS the key, which is why `lint-schema.ts` carries the table in
 * `NO_ID_TABLES` and in `AUDIT_EXEMPT` (§3.5.3).
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const itemProfitability = app.table(
  "item_profitability",
  {
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    itemId: uuid("item_id").notNull(),
    fiscalPeriodId: uuid("fiscal_period_id").notNull(),
    quantitySold: numeric("quantity_sold", { precision: 19, scale: 6 }).notNull().default("0"),
    revenueBase: numeric("revenue_base", { precision: 19, scale: 4 }).notNull().default("0"),
    cogsBase: numeric("cogs_base", { precision: 19, scale: 4 }).notNull().default("0"),
    marginBase: numeric("margin_base", { precision: 19, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "item_profitability_pkey",
      columns: [table.companyId, table.itemId, table.fiscalPeriodId],
    }),
  ],
);
