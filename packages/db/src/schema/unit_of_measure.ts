import { text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — the unit of measure (3A, migration 0028). A quantity is stored once, in the item's
 * base unit (spec:2043); this table names the units, and `app.unit_conversion` carries the exact rational
 * factor between a non-base unit and that base. This mirror is the diff source for the next slice that
 * alters the table (ADR-0002, contracts §3.4.9) — extend it, never rewrite it.
 */
export const unitOfMeasure = app.table(
  "unit_of_measure",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("unit_of_measure_company_id_code_key").on(table.companyId, table.code),
    unique("unit_of_measure_tenant_id_id_key").on(table.tenantId, table.id),
  ],
);
