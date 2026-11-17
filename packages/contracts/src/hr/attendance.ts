import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const AttendanceKindSchema = z.enum(["clock_in", "clock_out", "manual_correction"]);

export const AttendanceEventSchema = z
  .object({
    id: UuidSchema,
    employeeId: UuidSchema,
    branchId: UuidSchema,
    kind: AttendanceKindSchema,
    occurredAt: TimestampSchema,
    terminalId: UuidSchema.nullable(),
    recordedBy: UuidSchema,
    note: z.string().nullable(),
    correctsEventId: UuidSchema.nullable(),
  })
  .meta({ id: "AttendanceEvent" });

/** No `recordedBy`: the actor is the session's (LEGACY-044). No `terminalId` either — a back-office
 *  correction has no till, and the sync path supplies it from the signed call, never from a body. */
export const RecordAttendanceBody = z
  .object({
    employeeId: UuidSchema,
    kind: AttendanceKindSchema,
    occurredAt: TimestampSchema,
    branchId: UuidSchema.optional(),
    note: z.string().max(500).optional(),
    correctsEventId: UuidSchema.optional(),
  })
  .strict()
  .meta({ id: "RecordAttendanceBody" });

export const AttendanceQuery = ListQuery.extend({
  "filter[employeeId][eq]": UuidSchema.optional(),
  "filter[occurredAt][gte]": TimestampSchema.optional(),
  "filter[occurredAt][lt]": TimestampSchema.optional(),
});
export const AttendanceList = ListEnvelope(AttendanceEventSchema);
export type AttendanceEventDto = z.infer<typeof AttendanceEventSchema>;
