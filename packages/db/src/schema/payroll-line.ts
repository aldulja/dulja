import { integer, numeric, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8B, migration 0087 — §4.12.6. A 1:1 extension of `app.document_line`, keyed on document_line_id (no-id set).
 *  Reads only (§3.4.9). */
export const payrollLine = app.table("payroll_line", {
  documentLineId: uuid("document_line_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  componentId: uuid("component_id"),
  schemeId: uuid("scheme_id"),
  share: text("share").$type<"employee" | "employer">(),
  // numeric columns are read as STRINGS and become Money at the boundary — never `number` (§3.7.5).
  quantity: numeric("quantity"),
  amount: numeric("amount").notNull(),
  rateTableId: uuid("rate_table_id"),
  rateTableVersion: integer("rate_table_version"),
  overrideReason: text("override_reason"),
  enteredBy: uuid("entered_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
