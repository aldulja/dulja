import { boolean, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8A, migration 0083 — §3.10.1 spec:2078-2079. `kind` is TWO-valued (a CHECK says so). */
export const payComponent = app.table("pay_component", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  kind: text("kind").notNull().$type<"earning" | "deduction">(),
  expenseAccountId: uuid("expense_account_id"),
  payableAccountId: uuid("payable_account_id"),
  quantityBased: boolean("quantity_based").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

/** No `id`, no `created_at` — a pure join table (§3.5.3 NO_ID_TABLES). */
export const payComponentScheme = app.table(
  "pay_component_scheme",
  {
    tenantId: uuid("tenant_id").notNull(),
    componentId: uuid("component_id").notNull(),
    schemeId: uuid("scheme_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.componentId, t.schemeId] })],
);
