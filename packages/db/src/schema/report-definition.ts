import { boolean, integer, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * Read mirror of app.report_definition (migration 0074, contracts §4.11.2, §3.4.9). Writes go through
 * packages/db/src/reports/ as tagged templates; this mirror is never a write path.
 *
 * `report_definition_version_check` and the PARTIAL `report_definition_lookup_idx` live in the migration only:
 * Drizzle spells a table CHECK and an index's `.where(...)` with its `sql` tag, which `no-bare-db` refuses
 * outside a `tx` — the split `allocation`, `promotion` and `price_list` already make.
 */
export const reportDefinition = app.table(
  "report_definition",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    /** The ROW version (a tenant edit is a new row) — never `ReportDefinition.version`, the format version. */
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull(),
    clonedFrom: uuid("cloned_from"),
    isCore: boolean("is_core").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("report_definition_company_id_code_version_key").on(t.companyId, t.code, t.version),
    unique("report_definition_tenant_id_id_key").on(t.tenantId, t.id),
  ],
);
