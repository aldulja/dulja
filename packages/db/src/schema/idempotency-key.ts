import { customType, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
export const idempotencyKeyTable = app.table("idempotency_key", {
  tenantId: uuid("tenant_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  key: text("key").notNull(),
  requestHash: bytea("request_hash").notNull(),
  responseCode: integer("response_code"),
  responseBody: jsonb("response_body"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
