import { char, date, integer, pgSchema, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** Mirror of app.tax_regime (migration 0053). Reads only — every write is a postgres.js tagged template. */
export const taxRegime = app.table(
  "tax_regime",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    jurisdiction: char("jurisdiction", { length: 2 }).notNull(),
    version: integer("version").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byCode: unique("tax_regime_company_id_code_version_key").on(t.companyId, t.code, t.version),
  }),
);
