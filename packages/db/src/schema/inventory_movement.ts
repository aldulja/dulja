import {
  bigint,
  date,
  index,
  integer,
  numeric,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.7.3 — the movement ledger (3A, migration 0031). Append-only and signed exactly as
 * `ledger_entry` is: + receipt, − issue, `value` mandatory (LEGACY-007), `lot_id` NOT NULL because
 * `stock_on_hand`'s primary key contains it (LEGACY-050, ADR 0034). Written only by
 * `packages/db/src/costing/apply-movements.ts`, which `posting-only-tables` (§3.7.5) enforces.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const inventoryMovement = app.table(
  "inventory_movement",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id").notNull(),
    lineNo: integer("line_no").notNull(),
    movementNo: integer("movement_no").notNull(),
    itemId: uuid("item_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    lotId: uuid("lot_id").notNull(),
    unitId: uuid("unit_id").notNull(),
    quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull(),
    value: numeric("value", { precision: 19, scale: 4 }).notNull(),
    // `mode: "string"`, as every other accounting date in these mirrors: a JavaScript Date would carry
    // a timezone into a date the user entered (spec:2039).
    effectiveDate: date("effective_date", { mode: "string" }).notNull(),
    // `bigint(…, { mode: "bigint" })` and NOT `numeric()`: migration 0031 declares `posting_seq bigint`,
    // and a `numeric` mirror would generate a diff altering a bigint column to numeric. `mode: "bigint"`
    // is what keeps it off `number` in TypeScript — the same form `unit_conversion` uses (Task 1).
    postingSeq: bigint("posting_seq", { mode: "bigint" }).notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    postedBy: uuid("posted_by").notNull(),
  },
  (table) => [
    unique("inventory_movement_document_id_movement_no_key").on(table.documentId, table.movementNo),
    unique("inventory_movement_tenant_id_id_key").on(table.tenantId, table.id),
    // The total chronological key of spec:1225 and §4.3.5 (LEGACY-067). The two CHECK constraints
    // (`inventory_movement_movement_no_check`, `inventory_movement_quantity_check`) stay in the
    // migration only, as `lot_expiry_after_manufacture_check` does for `app.lot`.
    index("inventory_movement_chrono_idx").on(
      table.companyId,
      table.itemId,
      table.warehouseId,
      table.effectiveDate,
      table.postingSeq,
      table.lineNo,
      table.movementNo,
    ),
    // 7B, migration 0077 (LEGACY-070) — report-filter indexes the 7B EXPLAIN gate found unserved.
    index("inventory_movement_company_date_idx").on(
      table.companyId,
      table.effectiveDate,
      table.postingSeq,
    ),
    index("inventory_movement_company_warehouse_date_idx").on(
      table.companyId,
      table.warehouseId,
      table.effectiveDate,
    ),
  ],
);
