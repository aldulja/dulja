import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./tenant";

/** Read mirror of app.import_run (migration 0103; 9B Task 9, contracts round 20 C17) — spec:2206's status resource for
 *  a cut-over load started through the API. Every write is a postgres.js tagged template in `src/import/run.ts`. */
export const importRun = app.table(
  "import_run",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    cutOverDate: date("cut_over_date").notNull(),
    dryRun: boolean("dry_run").notNull(),
    onlyTargets: text("only_targets").array(),
    accountMap: jsonb("account_map"),
    status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull(),
    perLoader: jsonb("per_loader"),
    skipCount: integer("skip_count"),
    artefactCount: integer("artefact_count"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    attempts: smallint("attempts").notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("import_run_tenant_id_id_key").on(t.tenantId, t.id),
    index("import_run_company_created_idx").on(t.companyId, t.createdAt.desc(), t.id.desc()),
    // `import_run_one_live_per_company` is a PARTIAL unique index and lives in the migration only (a `.where(...)`
    // needs the `sql` tag), as 0078's `export_job_queued_idx` does.
  ],
);
