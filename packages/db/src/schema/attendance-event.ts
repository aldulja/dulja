import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const attendanceEventTable = app.table("attendance_event", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  branchId: uuid("branch_id").notNull(),
  kind: text("kind").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  terminalId: uuid("terminal_id"),
  recordedBy: uuid("recorded_by").notNull(),
  note: text("note"),
  correctsEventId: uuid("corrects_event_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
