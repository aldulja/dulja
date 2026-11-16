import { bigint, date, index, numeric, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.7.3 — a cost layer (3B, migration 0034). One layer per inventory RECEIPT, keyed to the
 * movement that produced it by `unique (movement_id)`: a recost UPDATEs the layer in place rather than
 * inserting a second one, which is why `app_rw` holds UPDATE here and no DELETE (§3.5.4). "Valid" means
 * `invalidated_at is null` in every read, every rebuild and every golden compare; `qty_remaining` is
 * mutable precisely because the table is derived state (spec:1210).
 *
 * The costing scope is (company, item, warehouse) — not the lot: AVCO has no per-lot average and FIFO
 * walks the oldest layer whatever lot it belongs to. `lot_id` is on the row because `stock_on_hand`'s key
 * needs it and because a consumption must say which lot left.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const costLayer = app.table(
  "cost_layer",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    itemId: uuid("item_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    lotId: uuid("lot_id").notNull(),
    movementId: uuid("movement_id").notNull(),
    qtyIn: numeric("qty_in", { precision: 19, scale: 6 }).notNull(),
    value: numeric("value", { precision: 19, scale: 4 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 19, scale: 4 }).notNull(),
    qtyRemaining: numeric("qty_remaining", { precision: 19, scale: 6 }).notNull(),
    // `mode: "string"`, as every other accounting date in these mirrors: a JavaScript Date would carry a
    // timezone into a date the user entered (spec:2039). It equals the movement's effective_date.
    effectiveAt: date("effective_at", { mode: "string" }).notNull(),
    // `bigint(…, { mode: "bigint" })` and NOT `numeric()`, matching `inventory_movement.posting_seq`:
    // migration 0034 declares `sequence bigint`, and a numeric mirror would generate a spurious diff.
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // Table-level UNIQUE CONSTRAINTS named exactly as Postgres names them, in 3A's mirror style —
    // `unique(...)`, never `uniqueIndex(...)`: a constraint and a bare unique index are different
    // objects and a Drizzle diff would report the swap.
    unique("cost_layer_movement_id_key").on(table.movementId),
    unique("cost_layer_tenant_id_id_key").on(table.tenantId, table.id),
    // Both indexes are PARTIAL in migration 0034. Their predicates (`invalidated_at is null and
    // qty_remaining > 0`, `invalidated_at is not null`) stay in the migration, exactly as
    // `attachment_lot_idx`'s and `lot_expiry_idx`'s do: a Drizzle `.where(...)` needs the `sql` tag,
    // which `no-bare-db` refuses anywhere under `packages/*/src` outside a `withTenant` tx. The mirror
    // carries the columns; the migration carries the predicate. The three CHECK constraints
    // (`cost_layer_unit_cost_check`, `cost_layer_qty_remaining_check`, `cost_layer_value_check`) take the same split.
    index("cost_layer_open_idx").on(
      table.companyId,
      table.itemId,
      table.warehouseId,
      table.effectiveAt,
      table.sequence,
      table.movementId,
    ),
    index("cost_layer_invalid_idx").on(
      table.companyId,
      table.itemId,
      table.effectiveAt,
      table.sequence,
    ),
    // 7B, migration 0077 (LEGACY-070) — NOT partial: inventory.stock_ageing reads every layer of an item.
    index("cost_layer_company_item_warehouse_idx").on(
      table.companyId,
      table.itemId,
      table.warehouseId,
    ),
  ],
);
