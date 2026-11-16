import { bigint, customType, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
export const auditLogTable = app.table(
  "audit_log",
  {
    seq: bigint("seq", { mode: "bigint" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    tableName: text("table_name").notNull(),
    rowId: text("row_id").notNull(),
    action: text("action").$type<"insert" | "update" | "delete">().notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    prevHash: bytea("prev_hash"),
    hash: bytea("hash").notNull(),
  },
  (table) => [
    // 7B, migration 0077 (SAH-070) — accounting.audit_log's required window, table cut and actor cut. The
    // table has no company column; the chain is per tenant.
    index("audit_log_tenant_time_idx").on(table.tenantId, table.occurredAt),
    index("audit_log_tenant_table_time_idx").on(table.tenantId, table.tableName, table.occurredAt),
    index("audit_log_tenant_actor_time_idx").on(table.tenantId, table.actorId, table.occurredAt),
  ],
);
