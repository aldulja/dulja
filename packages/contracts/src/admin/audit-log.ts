import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";
export const AuditLogEntrySchema = z.object({
  seq: z.string(),
  actorId: UuidSchema,
  occurredAt: TimestampSchema,
  tableName: z.string(),
  rowId: z.string(),
  action: z.enum(["insert", "update", "delete"]),
  /** Projected onto the table's registered export columns, or null when withheld (ADR 0090). */
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  /** True when the row had an image the caller may not see: its table's gate, its document's module gate, or
   *  a table whose images never leave (ADR 0090). `before`/`after` are then both null. */
  imagesWithheld: z.boolean(),
});
export const AuditLogQuery = ListQuery.extend({
  tableName: z.string().optional(),
  actorId: UuidSchema.optional(),
  action: z.enum(["insert", "update", "delete"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  sort: z.string().max(0, "sort is not supported on this resource").optional(),
});
export const AuditLogList = ListEnvelope(AuditLogEntrySchema);
