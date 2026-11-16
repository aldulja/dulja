import { char, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";
export const companyTable = app.table("company", {
  einvoiceTransmitter: text("einvoice_transmitter"),
  einvoiceClientId: text("einvoice_client_id"),
  einvoiceCredentialRef: text("einvoice_credential_ref"),

  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  baseCurrency: char("base_currency", { length: 3 }).notNull(),
  timezone: text("timezone").notNull(),
  fxRoundingAccountId: uuid("fx_rounding_account_id"),
  // 3B / migration 0035 — OD-06's switch. `text` with a CHECK, not an enum (contracts §3.2); the mirror
  // carries no CHECK because a Drizzle mirror is a read shape, not the constraint's home.
  costingMethod: text("costing_method").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
