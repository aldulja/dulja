import { text, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";
export const rolePermissionTable = app.table("role_permission", {
  tenantId: uuid("tenant_id").notNull(),
  roleId: uuid("role_id").notNull(),
  permissionCode: text("permission_code").notNull(),
});
