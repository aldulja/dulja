import { uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";
export const roleAssignmentBranchTable = app.table("role_assignment_branch", {
  tenantId: uuid("tenant_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  roleId: uuid("role_id").notNull(),
  companyId: uuid("company_id").notNull(),
  branchId: uuid("branch_id").notNull(),
});
