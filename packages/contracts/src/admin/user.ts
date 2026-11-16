import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";
export const UserSchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  email: z.string().nullable(),
  kind: z.enum(["human", "system", "terminal"]),
  createdAt: TimestampSchema,
  activeAssignments: z.number().int(),
});
export const InviteUserBody = z.object({
  email: z.email(),
  displayName: z.string().min(1).max(200),
});
export const UserQuery = ListQuery.extend({
  kind: z.enum(["human", "system", "terminal"]).optional(),
});
export const UserList = ListEnvelope(UserSchema);
