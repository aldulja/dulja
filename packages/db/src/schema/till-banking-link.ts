// packages/db/src/schema/till-banking-link.ts — a READ mirror (§3.4.9) of migration 0071's
// app.till_banking_link (⚠️ OD-10, answered yes 2026-11-04; contracts amendment A16).
import {
  boolean,
  char,
  date,
  index,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const tillBankingLink = app.table(
  "till_banking_link",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    bankingDocumentId: uuid("banking_document_id").notNull(),
    shiftId: uuid("shift_id").notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    fromSafe: boolean("from_safe").notNull(),
    valueDate: date("value_date").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    reference: text("reference"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tenantRow: unique("till_banking_link_tenant_id_id_key").on(t.tenantId, t.id),
    // One link per banking document.
    bankingDocument: unique("till_banking_link_banking_document_id_key").on(t.bankingDocumentId),
    bankDateIdx: index("till_banking_link_bank_date_idx").on(
      t.companyId,
      t.bankAccountId,
      t.valueDate,
    ),
    shiftIdx: index("till_banking_link_shift_idx").on(t.shiftId),
  }),
);
