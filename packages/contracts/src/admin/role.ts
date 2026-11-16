import { z } from "zod";
import { ListEnvelope, TimestampSchema, UuidSchema } from "../common";
export const RoleSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  nameEn: z.string(),
  nameAr: z.string().nullable(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
  createdAt: TimestampSchema,
});
export const CreateRoleBody = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/),
  nameEn: z.string().min(1).max(120),
  nameAr: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
});
export const UpdateRoleBody = CreateRoleBody.partial().omit({ code: true });
export const RolePermissionsBody = z.object({ permissions: z.array(z.string()).max(200) });
export const RoleList = ListEnvelope(RoleSchema);
