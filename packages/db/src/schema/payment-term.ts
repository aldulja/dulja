import { integer, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — the terms an invoice is aged on (4A, migration 0044; spec:1042). Master data: archived,
 * never deleted (spec:2049). `discount_pct` is a FRACTION at numeric(9,6) — `0.020000` is two per cent — and
 * nothing in 4A computes with it; 4B ages on `due_days` alone (§4.8.2).
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const paymentTerm = app.table(
  "payment_term",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    dueDays: integer("due_days").notNull(),
    discountDays: integer("discount_days"),
    discountPct: numeric("discount_pct", { precision: 9, scale: 6 }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("payment_term_company_id_code_key").on(table.companyId, table.code),
    unique("payment_term_tenant_id_id_key").on(table.tenantId, table.id),
    // The three CHECKs (`payment_term_due_days_check`, `payment_term_discount_pct_check`,
    // `payment_term_discount_window_check`) live in the migration only: Drizzle spells a table CHECK with its
    // `sql` tag, which `no-bare-db` refuses outside a `tx` — the split `price_list_window_check` makes.
  ],
);
