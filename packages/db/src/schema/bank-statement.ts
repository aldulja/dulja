import {
  char,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * Mirrors of app.bank_statement and app.bank_statement_line (4B, migration 0049; contracts §4.8.3,
 * ADR 0048). Reads only — every write goes through `importStatement` in
 * packages/db/src/ar-ap/reconciliation.ts, and nothing there or anywhere else in the slice writes a
 * ledger row from a statement line.
 *
 * `bank_statement_line.amount` is SIGNED, positive meaning money IN — the bank's own convention. The two
 * CHECKs (`bank_statement_line_line_no_check`, `bank_statement_line_amount_check`) live in the migration
 * only: Drizzle spells a table CHECK with its `sql` tag, which `no-bare-db` refuses outside a `tx`.
 *
 * These mirrors are the diff source for the next slice that alters either table (ADR-0002, §3.4.9).
 */
export const bankStatement = app.table(
  "bank_statement",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    statementDate: date("statement_date").notNull(),
    openingBalance: numeric("opening_balance", { precision: 19, scale: 4 }).notNull(),
    closingBalance: numeric("closing_balance", { precision: 19, scale: 4 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    sourceFileAttachmentId: uuid("source_file_attachment_id"),
    importedBy: uuid("imported_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("bank_statement_company_id_bank_account_id_statement_date_key").on(
      table.companyId,
      table.bankAccountId,
      table.statementDate,
    ),
    unique("bank_statement_tenant_id_id_key").on(table.tenantId, table.id),
    unique("bank_statement_tenant_id_company_id_id_key").on(
      table.tenantId,
      table.companyId,
      table.id,
    ),
  ],
);

export const bankStatementLine = app.table(
  "bank_statement_line",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    statementId: uuid("statement_id").notNull(),
    lineNo: integer("line_no").notNull(),
    valueDate: date("value_date").notNull(),
    description: text("description").notNull(),
    reference: text("reference"),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("bank_statement_line_statement_id_line_no_key").on(table.statementId, table.lineNo),
    unique("bank_statement_line_tenant_id_id_key").on(table.tenantId, table.id),
    // 4B T7, migration 0050: the target of bank_match's company-binding key.
    unique("bank_statement_line_tenant_id_company_id_id_key").on(
      table.tenantId,
      table.companyId,
      table.id,
    ),
    index("bank_statement_line_value_date_idx").on(table.companyId, table.valueDate),
  ],
);
