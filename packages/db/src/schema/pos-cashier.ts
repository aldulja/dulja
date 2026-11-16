import { bigint, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const posCashier = app.table("pos_cashier", {
  principalId: uuid("principal_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  branchId: uuid("branch_id").notNull(),
  pinHash: text("pin_hash").notNull(),
  pinUpdatedAt: timestamp("pin_updated_at", { withTimezone: true }).notNull(),
  snapshot: jsonb("snapshot").notNull(),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
  revision: bigint("revision", { mode: "bigint" }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
