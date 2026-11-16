import { date, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8B, migration 0087 — §4.12.6. A 1:1 extension of `app.document`, keyed on document_id (no-id set). Reads only
 *  (§3.4.9); writes are postgres.js tagged templates. */
export const payrollRun = app.table("payroll_run", {
  documentId: uuid("document_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  kind: text("kind").$type<"regular" | "supplementary" | "final">().notNull(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  payDate: date("pay_date").notNull(),
  pinnedTables: jsonb("pinned_tables").$type<{ schemeId: string; version: number }[]>().notNull(),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull(),
  calculatedBy: uuid("calculated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
