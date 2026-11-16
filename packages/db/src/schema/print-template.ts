import { index, integer, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/** Mirror of app.print_template (migration 0026, contracts §4.5.9). */
export const printTemplate = app.table(
  "print_template",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentTypeId: uuid("document_type_id").notNull(),
    code: text("code").notNull(),
    version: integer("version").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    engine: text("engine").notNull(),
    source: text("source").notNull(),
    paper: text("paper").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("print_template_document_type_id_code_version_key").on(
      t.documentTypeId,
      t.code,
      t.version,
    ),
    unique("print_template_tenant_id_id_key").on(t.tenantId, t.id),
    index("print_template_resolve_idx").on(t.companyId, t.documentTypeId, t.code, t.version),
  ],
);
