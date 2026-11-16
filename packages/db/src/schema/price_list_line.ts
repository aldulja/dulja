import { bigint } from "drizzle-orm/pg-core";
import { index, numeric, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — one priced row of a price list: item × unit × quantity break (3A, migration 0030).
 * `unit_id` null means the item's base unit; `min_quantity` 0 is the no-break price.
 *
 * `archived_at` is an addition to §4.6.1's row and it is necessary rather than convenient: contracts
 * §3.5.4 pins the `app_rw` DELETE grant list and names 2B as its only extender, so
 * `replacePriceListLines` archives a line the new payload omits instead of deleting it — which is also
 * what spec:2049 wants of master data.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const priceListLine = app.table(
  "price_list_line",
  {
    id: uuid("id").primaryKey(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    tenantId: uuid("tenant_id").notNull(),
    priceListId: uuid("price_list_id").notNull(),
    itemId: uuid("item_id").notNull(),
    unitId: uuid("unit_id"),
    minQuantity: numeric("min_quantity", { precision: 19, scale: 6 }).notNull().default("0"),
    unitPrice: numeric("unit_price", { precision: 19, scale: 4 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // `nullsNotDistinct()` mirrors the DDL, and it is load-bearing: `unit_id` is nullable, and under the
    // default NULLS DISTINCT two rows for (list, item, null, 0) would both be accepted and `resolvePrice`
    // would have two answers for one query. Without the modifier here the mirror and migration 0030 would
    // disagree about that one key and the generated diff would propose replacing it with the weaker form.
    unique("price_list_line_price_list_id_item_id_unit_id_min_quantity_key")
      .on(table.priceListId, table.itemId, table.unitId, table.minQuantity)
      .nullsNotDistinct(),
    unique("price_list_line_tenant_id_id_key").on(table.tenantId, table.id),
    // The migration declares this one `where archived_at is null`. The predicate is not repeated here:
    // Drizzle spells a partial index with its `sql` tag, which `no-bare-db` refuses outside a `tx`, and
    // `item_barcode_idx` (Task 1), `lot_expiry_idx` (Task 2) and `attachment_document_idx` (2C) are
    // mirrored the same way — the migration owns the predicate. The two CHECK constraints
    // (`price_list_line_min_quantity_check`, `price_list_line_unit_price_check`) are split the same way.
    index("price_list_line_item_idx").on(table.itemId, table.priceListId),
    // 7B, migration 0077 (SAH-070) — NOT partial: inventory.price_list's item cut, archived lines included.
    index("price_list_line_item_any_idx").on(table.itemId),
  ],
);
