import { numeric, pgSchema, smallint, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8D, migration 0096 — ⚠️ OD-13. A yearly figure ENTERED by HR; there is no accrual engine (spec:2085). READS
 *  ONLY (ADR 0002). */
export const leaveEntitlement = app.table("leave_entitlement", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  year: smallint("year").notNull(),
  leaveTypeId: uuid("leave_type_id").notNull(),
  days: numeric("days", { precision: 6, scale: 2 }).notNull(),
  enteredBy: uuid("entered_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
