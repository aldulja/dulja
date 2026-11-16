import { bigint } from "drizzle-orm/pg-core";
import { boolean, index, integer, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — the item master (3A, migration 0028). `kind` is total over
 * `product | service | asset` because §4.4.1's `when: { "item.kind": … }` filter and §4.4.2's
 * `ItemRef.kind` both read it; the four account columns are the policy paths
 * `item.revenue_account` / `inventory_account` / `cogs_account` / `expense_account`, filled at create
 * by `resolveItemAccounts` from the §4.15 codes 4000 / 1300 / 5000 / 5900.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const item = app.table(
  "item",
  {
    id: uuid("id").primaryKey(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    kind: text("kind").notNull().$type<"product" | "service" | "asset">(),
    baseUnitId: uuid("base_unit_id").notNull(),
    barcode: text("barcode"),
    taxCodeId: uuid("tax_code_id"),
    revenueAccountId: uuid("revenue_account_id"),
    inventoryAccountId: uuid("inventory_account_id"),
    cogsAccountId: uuid("cogs_account_id"),
    expenseAccountId: uuid("expense_account_id"),
    trackLots: boolean("track_lots").notNull().default(true),
    shelfLifeDays: integer("shelf_life_days"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // 9B, migration 0101 (contracts §4.13.3) — the legacy material code.
    legacyRef: text("legacy_ref"),
  },
  (table) => [
    unique("item_company_id_code_key").on(table.companyId, table.code),
    unique("item_tenant_id_id_key").on(table.tenantId, table.id),
    // The migration declares this one `where barcode is not null`. The predicate is not repeated here:
    // Drizzle spells a partial index with its `sql` tag, which `no-bare-db` refuses outside a `tx`, and
    // `attachment_document_idx` (2C) is mirrored the same way — the migration owns the predicate.
    index("item_barcode_idx").on(table.companyId, table.barcode),
    // 0063 declares this one `where tax_code_id is not null`; the predicate is the migration's, as above.
    index("item_tax_code_idx").on(table.taxCodeId),
    // 9B, migration 0101 — partial (`where legacy_ref is not null`) in the migration only.
    index("item_legacy_ref_idx").on(table.companyId, table.legacyRef),
  ],
);
