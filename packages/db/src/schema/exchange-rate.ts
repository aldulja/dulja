import { char, date, index, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const exchangeRate = app.table(
  "exchange_rate",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    fromCurrency: char("from_currency", { length: 3 }).notNull(),
    toCurrency: char("to_currency", { length: 3 }).notNull(),
    rate: numeric("rate", { precision: 19, scale: 8 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    source: text("source").notNull(),
    enteredBy: uuid("entered_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("exchange_rate_company_id_from_currency_to_currency_effective_from_key").on(
      table.companyId,
      table.fromCurrency,
      table.toCurrency,
      table.effectiveFrom,
    ),
    index("exchange_rate_lookup_idx").on(
      table.companyId,
      table.fromCurrency,
      table.toCurrency,
      table.effectiveFrom.desc(),
    ),
  ],
);
