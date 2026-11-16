import { jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — the selling variant (3A, migration 0029). spec:1181. Reserved and complete, but
 * no document type reads it in v1: a variant is a selling attribute (size, colour), and the food
 * distributor's v1 catalogue is coded per SKU.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const variant = app.table(
  "variant",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    itemId: uuid("item_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    attributes: jsonb("attributes").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("variant_item_id_code_key").on(table.itemId, table.code),
    unique("variant_tenant_id_id_key").on(table.tenantId, table.id),
  ],
);
