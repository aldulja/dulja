import { char, numeric, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const currency = app.table(
  "currency",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    code: char("code", { length: 3 }).notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    minorUnits: smallint("minor_units").notNull(),
    posRoundingIncrement: numeric("pos_rounding_increment", { precision: 19, scale: 4 }).notNull(),
    roundingMode: text("rounding_mode").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [unique("currency_tenant_id_code_key").on(table.tenantId, table.code)],
);
