import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8A, migration 0084 — §3.10.1 spec:2080. A scheme is a ROW with a free-text code, never an enum. */
export const statutoryScheme = app.table("statutory_scheme", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  payableAccountId: uuid("payable_account_id"),
  employerExpenseAccountId: uuid("employer_expense_account_id"),
  authorityPartyId: uuid("authority_party_id"),
  employerRegistration: text("employer_registration"),
  roundingMode: text("rounding_mode").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
