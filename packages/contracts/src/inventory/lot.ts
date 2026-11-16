import { z } from "zod";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const LotSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  itemId: UuidSchema,
  code: z.string().min(1).max(64),
  expiresOn: DateSchema.nullable(),
  manufacturedOn: DateSchema.nullable(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

/** `itemId` is not in the body: it is the path segment, and the route binds that item to the path's
 *  company before it writes. A body field would be a second, unchecked spelling of the same thing. */
export const CreateLotBody = z
  .object({
    code: z.string().min(1).max(64),
    expiresOn: DateSchema.optional(),
    manufacturedOn: DateSchema.optional(),
  })
  .strict();

export const LotQuery = ListQuery.extend({
  "filter[expiresBefore][lte]": DateSchema.optional(),
  includeArchived: z.enum(["true", "false"]).default("false"),
});

export const LotList = ListEnvelope(LotSchema);
