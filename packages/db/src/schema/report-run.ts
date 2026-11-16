import {
  char,
  customType,
  index,
  jsonb,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./tenant";

/** bytea has no first-class Drizzle column; the mirror is read-only, so a Uint8Array custom type is enough. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => new Uint8Array(value),
});

/** Read mirror of app.report_run (migration 0075, contracts §4.11.2, ADR 0067) — the spec:2206 status resource. */
export const reportRun = app.table(
  "report_run",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    reportDefinitionId: uuid("report_definition_id").notNull(),
    savedViewId: uuid("saved_view_id"),
    parameters: jsonb("parameters").notNull(),
    format: text("format").$type<"pdf" | "xlsx" | "csv">().notNull(),
    // `char(2)`, matching the DDL, so a drizzle-kit diff reports no phantom column change.
    lang: char("lang", { length: 2 }).$type<"en" | "ar">().notNull(),
    status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull(),
    requestedBy: uuid("requested_by").notNull(),
    objectKey: text("object_key"),
    sha256: bytea("sha256"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    attempts: smallint("attempts").notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("report_run_object_key_key").on(t.objectKey),
    unique("report_run_tenant_id_id_key").on(t.tenantId, t.id),
    index("report_run_recent_idx").on(t.companyId, t.createdAt.desc()),
    // `report_run_queued_idx` is PARTIAL and lives in the migration only (a `.where(...)` needs the `sql` tag).
  ],
);
