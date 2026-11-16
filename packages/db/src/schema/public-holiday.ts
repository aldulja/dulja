import { date, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8D, migration 0096 — ⚠️ OD-13. READS ONLY (ADR 0002). A NULL `branchId` is a company-wide holiday
 *  (spec:2085), which is why 0096's unique constraint is `nulls not distinct`. */
export const publicHoliday = app.table("public_holiday", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  branchId: uuid("branch_id"),
  holidayOn: date("holiday_on").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
