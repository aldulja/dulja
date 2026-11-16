import { char, date, numeric, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8C, migration 0091 — §4.6.1 plus round 18 B11. One row per scheme per period per run, generated from posted
 *  payroll lines (spec:2083): a record, not a lodgement state machine. Reads only (§3.4.9). */
export const statutorySchedule = app.table("statutory_schedule", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  schemeId: uuid("scheme_id").notNull(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  payrollDocumentId: uuid("payroll_document_id").notNull(),
  totalEmployee: numeric("total_employee", { precision: 19, scale: 4 }).notNull(),
  totalEmployer: numeric("total_employer", { precision: 19, scale: 4 }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  attachmentId: uuid("attachment_id"),
  remittanceDocumentId: uuid("remittance_document_id"),
  generatedBy: uuid("generated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
