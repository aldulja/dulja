import { char, date, integer, numeric, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/** The ledger (0001 §7). Immutable; read mirror for the Phase 1 ledger read and the 1B reports. */
export const ledgerEntry = app.table(
  "ledger_entry",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id").notNull(),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id").notNull(),
    debit: numeric("debit", { precision: 19, scale: 4 }).notNull(),
    credit: numeric("credit", { precision: 19, scale: 4 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    exchangeRate: numeric("exchange_rate", { precision: 19, scale: 8 }).notNull(),
    baseDebit: numeric("base_debit", { precision: 19, scale: 4 }).notNull(),
    baseCredit: numeric("base_credit", { precision: 19, scale: 4 }).notNull(),
    effectiveDate: date("effective_date").notNull(),
    fiscalPeriodId: uuid("fiscal_period_id").notNull(),
    postingPolicyId: uuid("posting_policy_id").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    postedBy: uuid("posted_by").notNull(),
  },
  (table) => [unique("ledger_entry_document_id_line_no_key").on(table.documentId, table.lineNo)],
);
