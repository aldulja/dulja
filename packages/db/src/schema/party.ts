import { bigint } from "drizzle-orm/pg-core";
import {
  boolean,
  char,
  index,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.5.7 — the party (2A, migration 0017). One table, one `kind` discriminator (SAH-072). This
 * mirror is the diff source for the next slice that alters the table (4A added `credit_limit`,
 * `payment_term_id`, `credit_hold` and `price_list_id` in 0045; 9B adds `legacy_ref`) — extend it, never
 * rewrite it (ADR-0002, contracts §3.4.9).
 */
export const party = app.table(
  "party",
  {
    id: uuid("id").primaryKey(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    kind: text("kind").notNull().$type<"customer" | "vendor" | "employee" | "student" | "dealer">(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    receivableAccountId: uuid("receivable_account_id"),
    payableAccountId: uuid("payable_account_id"),
    currency: char("currency", { length: 3 }),
    taxRegistration: text("tax_registration"),
    email: text("email"),
    phone: text("phone"),
    address: jsonb("address").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // 4A / migration 0045 (contracts §4.5.7). `credit_limit` is in the company's BASE currency; null is no
    // limit. The composite FKs and `party_credit_limit_check` live in the migration only.
    creditLimit: numeric("credit_limit", { precision: 19, scale: 4 }),
    paymentTermId: uuid("payment_term_id"),
    creditHold: boolean("credit_hold").notNull(),
    // 6B's A10(b); 4A never reads it, but the mirror is the diff source — a column absent here is one the
    // next `drizzle-kit generate` would propose dropping (§3.4.9).
    priceListId: uuid("price_list_id"),
    // 9B, migration 0101 (contracts §4.13.3) — the legacy account/customer/vendor code.
    legacyRef: text("legacy_ref"),
  },
  (table) => [
    unique("party_company_id_code_key").on(table.companyId, table.code),
    index("party_company_kind_idx").on(table.companyId, table.kind),
    // 9B, migration 0101 — partial (`where legacy_ref is not null`) in the migration only.
    index("party_legacy_ref_idx").on(table.companyId, table.legacyRef),
  ],
);
