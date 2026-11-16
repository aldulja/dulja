import { date, numeric, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8D, migration 0096 — ⚠️ OD-13. READS ONLY (ADR 0002). `approvedBy` is NULL exactly while the record is
 *  `requested` (0096's CHECK) and is stamped from the session actor by `app.stamp_actor`; a mirror states the
 *  column, never the rule. */
export const leaveRecord = app.table("leave_record", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  leaveTypeId: uuid("leave_type_id").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  days: numeric("days", { precision: 6, scale: 2 }).notNull(),
  status: text("status").$type<"requested" | "approved" | "rejected">().notNull(),
  approvedBy: uuid("approved_by"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
