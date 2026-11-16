import { text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const dimensionType = app.table(
  "dimension_type",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [unique("dimension_type_company_id_code_key").on(table.companyId, table.code)],
);
