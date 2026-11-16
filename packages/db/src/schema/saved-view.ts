import { boolean, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * Read mirror of app.saved_view (migration 0075, contracts §4.11.2, §3.4.9). Archived, never deleted.
 * Both of its indexes are PARTIAL (`where archived_at is null …`) and live in the migration only: a Drizzle
 * `.where(...)` needs the `sql` tag `no-bare-db` refuses outside a `tx`.
 */
export const savedView = app.table(
  "saved_view",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    reportDefinitionId: uuid("report_definition_id").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    parameters: jsonb("parameters").notNull(),
    /** WHOM the view belongs to — data, so deliberately not a stamped `*_by` column (§3.3). */
    ownerPrincipalId: uuid("owner_principal_id").notNull(),
    shared: boolean("shared").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [unique("saved_view_tenant_id_id_key").on(t.tenantId, t.id)],
);
