import { date, numeric, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8A, migration 0083 — effective-dated; the history IS the closed rows (ADR 0072). */
export const compensationLine = app.table("compensation_line", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  componentId: uuid("component_id").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  // numeric(19,4) and numeric(19,6) reach TypeScript as STRINGS and are wrapped in Money/Quantity by the service
  // (packages/db/src/hr/compensation.ts). A `number` here would be caught by `no-number-money` (§3.7.5).
  amount: numeric("amount", { precision: 19, scale: 4 }),
  quantity: numeric("quantity", { precision: 19, scale: 6 }),
  enteredBy: uuid("entered_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
