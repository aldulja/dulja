import { index, numeric, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.7.3 — the synchronous stock projection (3A, migration 0031). MERGEd inside the posting
 * transaction at §4.3.2 step 12 (D14), never asynchronously. There is no `id` column: the natural key
 * `(company_id, item_id, warehouse_id, lot_id)` IS the key, which is why `lint-schema.ts` carries the
 * table in `NO_ID_TABLES` and in `AUDIT_EXEMPT` (§3.5.3).
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const stockOnHand = app.table(
  "stock_on_hand",
  {
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    itemId: uuid("item_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    lotId: uuid("lot_id").notNull(),
    quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.companyId, table.itemId, table.warehouseId, table.lotId] }),
    // 7B, migration 0077 (SAH-070) — report-filter indexes the 7B EXPLAIN gate found unserved.
    index("stock_on_hand_company_warehouse_idx").on(table.companyId, table.warehouseId),
  ],
);
