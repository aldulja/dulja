import {
  bigint,
  customType,
  date,
  index,
  integer,
  numeric,
  pgSchema,
  timestamp,
  uuid,
  unique,
} from "drizzle-orm/pg-core";

const app = pgSchema("app");
/** `bytea` has no first-class Drizzle type; the return's sha is read as a Buffer. Declared once, here,
 *  because tax-return.ts imports it rather than declaring a second one. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Mirror of app.tax_transaction (0054). READ ONLY from every module except packages/db/src/posting/tax.ts —
 *  the table is on the `posting-only-tables` list (§3.7.5) and immutable in the database besides. */
export const taxTransaction = app.table(
  "tax_transaction",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id").notNull(),
    lineNo: integer("line_no").notNull(),
    taxCodeId: uuid("tax_code_id").notNull(),
    regimeId: uuid("regime_id").notNull(),
    base: numeric("base", { precision: 19, scale: 4 }).notNull(),
    tax: numeric("tax", { precision: 19, scale: 4 }).notNull(),
    baseBase: numeric("base_base", { precision: 19, scale: 4 }).notNull(),
    taxBase: numeric("tax_base", { precision: 19, scale: 4 }).notNull(),
    effectiveDate: date("effective_date").notNull(),
    fiscalPeriodId: uuid("fiscal_period_id").notNull(),
    postingSeq: bigint("posting_seq", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    perLine: unique("tax_transaction_document_id_line_no_tax_code_id_key").on(
      t.documentId,
      t.lineNo,
      t.taxCodeId,
    ),
    // 0077, 7C's filters — accounting.tax_return_view's required fiscal period.
    companyPeriod: index("tax_transaction_company_period_idx").on(t.companyId, t.fiscalPeriodId),
  }),
);
