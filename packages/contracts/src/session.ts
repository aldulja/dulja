import { z } from "zod";
import { UuidSchema } from "./common";
export const SessionSchema = z.object({
  principalId: UuidSchema,
  tenantId: UuidSchema,
  principalKind: z.enum(["human", "system", "terminal"]),
  aal: z.enum(["aal1", "aal2"]),
  displayName: z.string(),
  email: z.string().nullable(),
});
