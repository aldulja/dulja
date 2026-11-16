import { jsonb, numeric, pgSchema, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8C, migration 0092 — §4.12.8. The posting-service projection, natural key (company_id, employee_id, tax_year);
 *  written only by `postDocument` step 12 (spec:98). Reads only (§3.4.9). */
export const employeeYtd = app.table("employee_ytd", {
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  taxYear: smallint("tax_year").notNull(),
  gross: numeric("gross", { precision: 19, scale: 4 }).notNull(),
  net: numeric("net", { precision: 19, scale: 4 }).notNull(),
  byComponent: jsonb("by_component").$type<Record<string, string>>().notNull(),
  byScheme: jsonb("by_scheme")
    .$type<Record<string, { employee: string; employer: string }>>()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/** 8C, migration 0092 — the cut-over figures 9B loads (spec:2084). Added at read time, never merged into the
 *  projection (round 18 B14). */
export const employeeYtdOpening = app.table("employee_ytd_opening", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  taxYear: smallint("tax_year").notNull(),
  gross: numeric("gross", { precision: 19, scale: 4 }).notNull(),
  net: numeric("net", { precision: 19, scale: 4 }).notNull(),
  byComponent: jsonb("by_component").$type<Record<string, string>>().notNull(),
  byScheme: jsonb("by_scheme")
    .$type<Record<string, { employee: string; employer: string }>>()
    .notNull(),
  source: text("source").notNull(),
  loadedBy: uuid("loaded_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
