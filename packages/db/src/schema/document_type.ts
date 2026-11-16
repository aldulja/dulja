import { text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * The document type (0001 §6) plus the two 2A columns of contracts §4.3.4 (migration 0018): `module`,
 * the attachment download gate of §4.5.8 — NOT the module segment of `approval.post` — and `archived_at`,
 * because master data is archived, never deleted (spec:2049). Types are per-tenant seed-pack or API data
 * (contracts §3.4.8); this mirror is the diff source for the next slice that alters the table.
 */
export const documentType = app.table(
  "document_type",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // 2A, migration 0018.
    module: text("module").notNull().$type<"accounting" | "inventory" | "hr" | "pos">(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [unique("document_type_company_id_code_key").on(table.companyId, table.code)],
);
