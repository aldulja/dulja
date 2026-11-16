import { z } from "zod";
import { DateSchema, ListEnvelope, UuidSchema } from "../common";

// 8D Task 8 — ⚠️ OD-13 answered BUILD on 2026-11-07 (contracts round 19, 8D A14): the wire shapes of spec:2085's
// minimal leave register, served by `apps/api/src/routes/hr/leave.ts` under `/v1/companies/{companyId}/leave-records`.
// No body carries a decider (`approvedBy`) or an `enteredBy`: both are stamped from the session actor by
// `app.stamp_actor` (SAH-044), so every write body is `.strict()` and a caller naming one is refused, not ignored.

export const LeaveTypeCodeSchema = z.enum(["annual", "sick", "unpaid", "other"]);
export const LeaveStatusSchema = z.enum(["requested", "approved", "rejected"]);

/** `numeric(6,2)`: at most four integer digits and exactly two decimals — a day count, never money. */
const DaysSchema = z.string().regex(/^\d{1,4}\.\d{2}$/, "a day count with two decimals, e.g. 2.50");

/** Whole days since the epoch of a validated `YYYY-MM-DD` — only ever subtracted from another, for a span. */
const dayNumber = (date: string): number =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86_400_000;

export const LeaveTypeSchema = z
  .object({
    id: UuidSchema,
    code: LeaveTypeCodeSchema,
    nameEn: z.string(),
    nameAr: z.string().nullable(),
    paid: z.boolean(),
    archivedAt: z.string().nullable(),
  })
  .meta({ id: "LeaveType" });

/** The vocabulary is spec:2085's four codes; a company labels each in both languages. */
export const CreateLeaveTypeBody = z
  .object({
    code: LeaveTypeCodeSchema,
    nameEn: z.string().min(1).max(120),
    nameAr: z.string().min(1).max(120).nullable().default(null),
    paid: z.boolean().default(true),
  })
  .strict()
  .meta({ id: "CreateLeaveTypeBody" });

export const LeaveEntitlementSchema = z
  .object({
    employeeId: UuidSchema,
    employeeNumber: z.string(),
    year: z.number().int().min(2000).max(2200),
    leaveTypeId: UuidSchema,
    leaveTypeCode: LeaveTypeCodeSchema,
    days: z.string(),
  })
  .meta({ id: "LeaveEntitlement" });

/** The natural key and the figure — never `employeeNumber` or `leaveTypeCode`, which are joined-in labels the read
 *  returns and a caller must not be able to disagree about. The figure is ENTERED; there is no accrual engine. */
export const SetLeaveEntitlementBody = z
  .object({
    employeeId: UuidSchema,
    year: z.number().int().min(2000).max(2200),
    leaveTypeId: UuidSchema,
    days: DaysSchema,
  })
  .strict()
  .meta({ id: "SetLeaveEntitlementBody" });

export const LeaveRecordSchema = z
  .object({
    id: UuidSchema,
    employeeId: UuidSchema,
    employeeNumber: z.string(),
    leaveTypeId: UuidSchema,
    leaveTypeCode: LeaveTypeCodeSchema,
    startsOn: DateSchema,
    endsOn: DateSchema,
    days: z.string(),
    status: LeaveStatusSchema,
    /** The principal who DECIDED the record — an approval or a rejection; null while requested. */
    approvedBy: UuidSchema.nullable(),
    reason: z.string().nullable(),
  })
  .meta({ id: "LeaveRecord" });

/** A request. The span rules are 0096's CHECKs, repeated here so a bad span is a 400 naming the field rather than a
 *  bare constraint failure: `endsOn` is not before `startsOn`, and `days` is positive and at most the span's
 *  calendar days (half days allowed). */
export const CreateLeaveRecordBody = z
  .object({
    employeeId: UuidSchema,
    leaveTypeId: UuidSchema,
    startsOn: DateSchema,
    endsOn: DateSchema,
    days: DaysSchema,
    reason: z.string().max(500).nullable().default(null),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!DateSchema.safeParse(body.startsOn).success || !DateSchema.safeParse(body.endsOn).success)
      return;
    if (!DaysSchema.safeParse(body.days).success) return;
    const span = dayNumber(body.endsOn) - dayNumber(body.startsOn) + 1;
    // Compared in whole hundredths of a day: `days` is a fixed two-decimal string, so no float ever holds it.
    const hundredths = Number.parseInt(body.days.replace(".", ""), 10);
    if (span < 1)
      ctx.addIssue({ code: "custom", path: ["endsOn"], message: "endsOn is before startsOn" });
    if (hundredths === 0)
      ctx.addIssue({ code: "custom", path: ["days"], message: "days must be greater than zero" });
    else if (span >= 1 && hundredths > span * 100)
      ctx.addIssue({
        code: "custom",
        path: ["days"],
        message: `days exceeds the span's ${span} calendar day(s)`,
      });
  })
  .meta({ id: "CreateLeaveRecordBody" });

/** `approvedBy` is NOT a member and never will be: the decider is the session actor (SAH-044). A rejection's
 *  `reason` replaces the request's; an approval keeps it. */
export const LeaveDecisionBody = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict()
  .meta({ id: "LeaveDecisionBody" });

/** §4.2.8's Layer 2 default: LITERAL `filter[…]` keys, one per supported (field, op) pair, and a `limit`. No cursor:
 *  the list is bounded by its filters and `limit`, and every list route answers `next_cursor: null`. */
export const LeaveRecordQuery = z
  .object({
    "filter[status][eq]": LeaveStatusSchema.optional(),
    "filter[employee_id][eq]": UuidSchema.optional(),
    "filter[leave_type_id][eq]": UuidSchema.optional(),
    "filter[starts_on][gte]": DateSchema.optional(),
    "filter[starts_on][lte]": DateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const PublicHolidaySchema = z
  .object({
    id: UuidSchema,
    /** NULL = every branch of the company. */
    branchId: UuidSchema.nullable(),
    holidayOn: DateSchema,
    nameEn: z.string(),
    nameAr: z.string().nullable(),
  })
  .meta({ id: "PublicHoliday" });

export const CreatePublicHolidayBody = z
  .object({
    branchId: UuidSchema.nullable(),
    holidayOn: DateSchema,
    nameEn: z.string().min(1).max(120),
    nameAr: z.string().min(1).max(120).nullable().default(null),
  })
  .strict()
  .meta({ id: "CreatePublicHolidayBody" });

/** NOT `z.coerce.boolean()`: a query value is a string and `Boolean("false")` is `true`, so `?includeArchived=false`
 *  would return the archived types — the opposite of what was asked. */
export const LeaveTypeQuery = z
  .object({
    includeArchived: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const LeaveEntitlementQuery = z
  .object({
    "filter[employee_id][eq]": UuidSchema.optional(),
    "filter[year][eq]": z.coerce.number().int().min(2000).max(2200).optional(),
    "filter[leave_type_id][eq]": UuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const PublicHolidayQuery = z
  .object({
    "filter[holiday_on][gte]": DateSchema.optional(),
    "filter[holiday_on][lte]": DateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const LeaveRecordList = ListEnvelope(LeaveRecordSchema).meta({ id: "LeaveRecordList" });
export const LeaveTypeList = ListEnvelope(LeaveTypeSchema).meta({ id: "LeaveTypeList" });
export const LeaveEntitlementList = ListEnvelope(LeaveEntitlementSchema).meta({
  id: "LeaveEntitlementList",
});
export const PublicHolidayList = ListEnvelope(PublicHolidaySchema).meta({
  id: "PublicHolidayList",
});

export type LeaveRecordDto = z.infer<typeof LeaveRecordSchema>;
export type LeaveTypeDto = z.infer<typeof LeaveTypeSchema>;
export type LeaveEntitlementDto = z.infer<typeof LeaveEntitlementSchema>;
export type PublicHolidayDto = z.infer<typeof PublicHolidaySchema>;
