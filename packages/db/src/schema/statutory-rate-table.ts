import { date, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8A, migration 0084 — spec:2080. Loaded by one principal, verified by ANOTHER (the verifier trigger). */
export const statutoryRateTable = app.table("statutory_rate_table", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  schemeId: uuid("scheme_id").notNull(),
  version: integer("version").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  // `unknown`, not the generated RateTable: `packages/db` may not narrow a shape that lives in
  // `packages/domain/payroll`, and every reader parses it with `parseRateTable` (8A Task 9) anyway.
  definition: jsonb("definition").notNull().$type<unknown>(),
  source: text("source").notNull(),
  loadedBy: uuid("loaded_by").notNull(),
  verifiedBy: uuid("verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
