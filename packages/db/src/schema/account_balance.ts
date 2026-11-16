import { char, index, numeric, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/** contracts §4.3.3 — derived from ledger_entry, keyed on the full grain, written only by the posting service. */
export const accountBalance = app.table(
  "account_balance",
  {
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    accountId: uuid("account_id").notNull(),
    fiscalPeriodId: uuid("fiscal_period_id").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    debit: numeric("debit", { precision: 19, scale: 4 }).notNull(),
    credit: numeric("credit", { precision: 19, scale: 4 }).notNull(),
    baseDebit: numeric("base_debit", { precision: 19, scale: 4 }).notNull(),
    baseCredit: numeric("base_credit", { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.companyId, table.accountId, table.fiscalPeriodId, table.currency],
    }),
    // 1B, migration 0016 (SAH-070) — accounting.trial_balance filters (company_id, fiscal_period_id
    // [, currency]); the primary key above puts account_id between the two filtered columns.
    index("account_balance_company_period_idx").on(
      table.companyId,
      table.fiscalPeriodId,
      table.currency,
    ),
  ],
);
