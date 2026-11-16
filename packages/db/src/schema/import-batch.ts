import { index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * Mirror of migration 0102 (contracts §4.6.1, round 20 C7). Reads only — every write goes through
 * `packages/db/src/import/batch.ts`, which uses postgres.js tagged templates. This mirror is the diff source for
 * the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const importBatch = app.table(
  "import_batch",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    sourceTable: text("source_table").notNull(),
    sourceKey: text("source_key").notNull(),
    targetTable: text("target_table").notNull(),
    targetId: uuid("target_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    runId: uuid("run_id").notNull(),
    loadedBy: uuid("loaded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("import_batch_natural_key").on(table.companyId, table.sourceTable, table.sourceKey),
    unique("import_batch_tenant_id_id_key").on(table.tenantId, table.id),
    index("import_batch_run_idx").on(table.companyId, table.runId, table.targetTable),
    index("import_batch_target_idx").on(table.companyId, table.targetTable, table.targetId),
  ],
);
