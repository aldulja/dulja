import { timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";
export const membershipTable = app.table("membership", {
  tenantId: uuid("tenant_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
