/**
 * The only file that names 0B's resource schemas, so a rename there is a one-file edit here.
 * **Every one of these names is 0B's**, registered in contracts §4.2.8's module table:
 * `admin/user.ts` → UserSchema/InviteUserBody/UserQuery/UserList; `admin/role.ts` →
 * RoleSchema/…/RoleList; `admin/role-assignment.ts` → RoleAssignmentSchema/…/RoleAssignmentList;
 * `admin/company.ts` → CompanySchema/…/CompanyList. Nothing here is re-derived from `ListEnvelope`:
 * a second spelling of a registered name is contracts hazard 9, and 0E imports rather than invents.
 */
import {
  CompanyList,
  CompanySchema,
  RoleAssignmentList,
  RoleAssignmentSchema,
  RoleList,
  RoleSchema,
  UserList,
  UserSchema,
} from "@dulja/contracts";
import { z } from "zod";

export type User = z.infer<typeof UserSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Company = z.infer<typeof CompanySchema>;
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

export {
  CompanyList,
  CompanySchema,
  RoleAssignmentList,
  RoleAssignmentSchema,
  RoleList,
  RoleSchema,
  UserList,
  UserSchema,
};
