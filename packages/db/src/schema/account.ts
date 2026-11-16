import { boolean, char, index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/** The chart-of-accounts node (0001 §5). Read mirror for the Phase 1 accounts API. */
export const account = app.table(
  "account",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    type: text("type").notNull(),
    parentId: uuid("parent_id"),
    isGroup: boolean("is_group").notNull(),
    currency: char("currency", { length: 3 }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // 9B, migration 0101 (contracts §4.13.3) — the legacy chart-of-accounts code.
    legacyRef: text("legacy_ref"),
  },
  (table) => [
    unique("account_company_id_code_key").on(table.companyId, table.code),
    // 9B, migration 0101 — partial (`where legacy_ref is not null`) in the migration only.
    index("account_legacy_ref_idx").on(table.companyId, table.legacyRef),
  ],
);
