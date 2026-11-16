import { text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const dimensionValue = app.table(
  "dimension_value",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    dimensionTypeId: uuid("dimension_type_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    parentId: uuid("parent_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("dimension_value_dimension_type_id_code_key").on(table.dimensionTypeId, table.code),
  ],
);
