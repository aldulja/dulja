import { pgSchema, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8A, migration 0085 — ⚠️ OD-23. No `employerRegistrations` column and no jsonb anywhere: amendment A4,
 *  spec:2088 (the registrations live one per scheme on `statutory_scheme.employer_registration`). */
export const companyHrSetting = app.table("company_hr_setting", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  prorationRule: text("proration_rule").notNull().$type<"calendar_days" | "working_days">(),
  payDay: smallint("pay_day"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
