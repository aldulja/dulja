import { timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";
export const roleAssignmentTable = app.table("role_assignment", {
  tenantId: uuid("tenant_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  roleId: uuid("role_id").notNull(),
  companyId: uuid("company_id").notNull(),
  grantedBy: uuid("granted_by").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
