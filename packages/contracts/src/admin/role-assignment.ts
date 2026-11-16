import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";
export const RoleAssignmentSchema = z.object({
  principalId: UuidSchema,
  roleId: UuidSchema,
  companyId: UuidSchema,
  grantedBy: UuidSchema,
  grantedAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  branchIds: z.array(UuidSchema),
});
export const CreateRoleAssignmentBody = z.object({
  principalId: UuidSchema,
  roleId: UuidSchema,
  expiresAt: TimestampSchema.optional(),
  branchIds: z.array(UuidSchema).optional(),
});
export const RoleAssignmentBranchBody = z.object({ branchIds: z.array(UuidSchema) });
export const RoleAssignmentQuery = ListQuery.extend({ principalId: UuidSchema.optional() });
export const RoleAssignmentList = ListEnvelope(RoleAssignmentSchema);
