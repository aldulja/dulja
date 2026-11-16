import {
  bigint,
  boolean,
  customType,
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

/** bytea has no first-class Drizzle column; the mirror is read-only, so a Uint8Array custom type is enough. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => new Uint8Array(value),
});

/** Read mirror of app.export_job (migration 0078, contracts §4.6.1, 7C amendment A9) — spec:2206's status
 *  resource for the tenant export. Every write is a postgres.js tagged template in `src/export/store.ts`. */
export const exportJob = app.table(
  "export_job",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    format: text("format").$type<"csv" | "json" | "both">().notNull(),
    status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull(),
    readableModules: text("readable_modules").array().notNull(),
    lotAttachments: boolean("lot_attachments").notNull(),
    includeAttachments: boolean("include_attachments").notNull(),
    tableCount: integer("table_count"),
    rowCount: bigint("row_count", { mode: "bigint" }),
    byteSize: bigint("byte_size", { mode: "bigint" }),
    objectKey: text("object_key"),
    sha256: bytea("sha256"),
    manifest: jsonb("manifest"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    attempts: smallint("attempts").notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("export_job_object_key_key").on(t.objectKey),
    unique("export_job_tenant_id_id_key").on(t.tenantId, t.id),
    index("export_job_company_created_idx").on(t.companyId, t.createdAt.desc(), t.id.desc()),
    // `export_job_queued_idx` is PARTIAL and lives in the migration only (a `.where(...)` needs the `sql` tag).
  ],
);
