import { bigint } from "drizzle-orm/pg-core";
import { char, date, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — a price list, scoped by currency, trade level, branch and date window
 * (3A, migration 0030; spec:1025 "Wholesale, retail, branch transfer pricing"). `branch_id` is
 * NULLABLE and null means *every* branch (spec:1312), which is the shape 6C's Form B
 * `branch_isolation` policy is written for (§4.5.6). `customer_kind` deliberately carries no CHECK:
 * no code branches on it, and the trade levels are the tenant's own — spec:1025's three are examples.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const priceList = app.table(
  "price_list",
  {
    id: uuid("id").primaryKey(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    // char(3) with no foreign key, exactly as `app.party.currency` is spelled (§4.5.7).
    currency: char("currency", { length: 3 }).notNull(),
    customerKind: text("customer_kind"),
    branchId: uuid("branch_id"),
    // `mode: "string"` on every date: a JavaScript Date would carry a timezone into a calendar date.
    validFrom: date("valid_from", { mode: "string" }),
    validTo: date("valid_to", { mode: "string" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("price_list_company_id_code_key").on(table.companyId, table.code),
    unique("price_list_tenant_id_id_key").on(table.tenantId, table.id),
    // `price_list_window_check` lives in the migration only: Drizzle spells a table CHECK with its `sql`
    // tag, which `no-bare-db` refuses outside a `tx` — the same split `item_barcode_idx` (Task 1) and
    // `attachment_document_idx` (2C) make for a partial index's predicate.
  ],
);
