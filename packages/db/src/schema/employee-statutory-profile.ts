import {
  boolean,
  date,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8A, migration 0082 — §3.10.1 spec:2077, ⚠️ OD-28. Effective-dated; the history is the closed rows (ADR 0072). */
export const employeeStatutoryProfile = app.table("employee_statutory_profile", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  maritalStatus: text("marital_status"),
  spouseWorking: boolean("spouse_working"),
  childReliefCount: integer("child_relief_count"),
  residencyCategory: text("residency_category"),
  extra: jsonb("extra").notNull(),
  enteredBy: uuid("entered_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
