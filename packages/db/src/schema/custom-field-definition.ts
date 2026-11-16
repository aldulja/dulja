import { boolean, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const customFieldDefinition = app.table(
  "custom_field_definition",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    entity: text("entity").notNull(),
    documentTypeId: uuid("document_type_id"),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    kind: text("kind").notNull(),
    required: boolean("required").notNull(),
    options: jsonb("options").notNull(),
    indexed: boolean("indexed").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("custom_field_definition_company_id_entity_code_key").on(
      table.companyId,
      table.entity,
      table.code,
    ),
  ],
);
