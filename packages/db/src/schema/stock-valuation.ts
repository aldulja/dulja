import { date, index, numeric, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — the as-of stock valuation snapshot (3B, migration 0034). An ASYNCHRONOUS projection
 * (spec:1204): rebuilt by the `inventory.projection.rebuild` job and compared row for row, never MERGEd
 * in the posting transaction the way `stock_on_hand` is. There is no `id` column — the natural key
 * `(company_id, item_id, warehouse_id, as_of)` IS the key, which is why `lint-schema.ts` carries the
 * table in `NO_ID_TABLES` and in `AUDIT_EXEMPT` (§3.5.3).
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const stockValuation = app.table(
  "stock_valuation",
  {
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    itemId: uuid("item_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    // `mode: "string"`: the snapshot date is a calendar date, not an instant (spec:2039).
    asOf: date("as_of", { mode: "string" }).notNull(),
    quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull().default("0"),
    value: numeric("value", { precision: 19, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "stock_valuation_pkey",
      columns: [table.companyId, table.itemId, table.warehouseId, table.asOf],
    }),
    // 7B, migration 0077 (SAH-070) — report-filter indexes the 7B EXPLAIN gate found unserved.
    index("stock_valuation_company_as_of_idx").on(table.companyId, table.asOf, table.warehouseId),
  ],
);
