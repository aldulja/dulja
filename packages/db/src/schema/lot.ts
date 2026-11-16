import { date, index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — the lot, with expiry (3A, migration 0029). spec:1022 makes batch/lot with
 * expiry a v1 row: FEFO picking and the near-expiry alert both read `expires_on`. Every
 * `app.item` insert creates one companion row here with `code = 'NONE'` by the
 * `item_sentinel_lot` trigger, which is what lets `inventory_movement.lot_id` and
 * `stock_on_hand.lot_id` both be NOT NULL (ADR 0034, LEGACY-050).
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const lot = app.table(
  "lot",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    itemId: uuid("item_id").notNull(),
    code: text("code").notNull(),
    // `mode: "string"` on every date: a JavaScript Date would carry a timezone into an accounting date.
    expiresOn: date("expires_on", { mode: "string" }),
    manufacturedOn: date("manufactured_on", { mode: "string" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // 9B, migration 0101 (contracts §4.13.3) — the legacy batch code.
    legacyRef: text("legacy_ref"),
  },
  (table) => [
    unique("lot_item_id_code_key").on(table.itemId, table.code),
    unique("lot_tenant_id_id_key").on(table.tenantId, table.id),
    // `where expires_on is not null and archived_at is null` lives in the migration only, for the
    // reason `warehouse_parent_idx` gives: a Drizzle predicate needs the `sql` tag `no-bare-db` refuses.
    index("lot_expiry_idx").on(table.companyId, table.expiresOn),
    index("lot_item_idx").on(table.itemId),
    // 7B, migration 0077 (LEGACY-070) — NOT partial, unlike lot_expiry_idx: a report filter cannot state
    // `archived_at is null`, so inventory.expiry_list could never use the partial one.
    index("lot_company_expires_idx").on(table.companyId, table.expiresOn),
    // 9B, migration 0101 — partial (`where legacy_ref is not null`) in the migration only.
    index("lot_legacy_ref_idx").on(table.companyId, table.legacyRef),
  ],
);
