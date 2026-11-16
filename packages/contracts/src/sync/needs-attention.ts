// packages/contracts/src/sync/needs-attention.ts
import { z } from "zod";
import { CursorSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

export const NeedsAttentionSchema = z.object({
  id: UuidSchema,
  branchId: UuidSchema,
  terminalId: UuidSchema.nullable(),
  clientRef: UuidSchema,
  errorCode: z.string(),
  errorDetail: z.string(),
  resolvedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

/** §4.2.8's ONE list-filter convention: literal `filter[…][eq]` keys, the Layer 2 default. Not a bespoke
 *  `?branchId=` — three forms had already shipped when round 2 settled this, and a fourth is hazard 9. */
export const NeedsAttentionQuery = z.object({
  "filter[branchId][eq]": UuidSchema.optional(),
  "filter[resolved][eq]": z.enum(["true", "false"]).optional(),
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const NeedsAttentionList = ListEnvelope(NeedsAttentionSchema);
export const ResolveNeedsAttentionBody = z.object({
  note: z.string().min(1).max(500),
});
