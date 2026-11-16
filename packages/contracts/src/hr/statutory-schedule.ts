import { z } from "zod";
import { CursorSchema, DateSchema, ListEnvelope, MoneySchema, UuidSchema } from "../common";

// 8C T7 (§4.2.8, round 18 B10) — the statutory-schedule wire module (spec:2083). A schedule is a RECORD, not a
// lodgement state machine: it exists, and it either names the PAYMENT that settled it or it does not.

const Decimal4 = z.string().regex(/^-?\d+\.\d{4}$/);

export const StatutoryScheduleRowSchema = z
  .object({
    employeeId: UuidSchema,
    employeeNumber: z.string(),
    employeeName: z.string(),
    /** From the employee's statutory profile (`extra["scheme_reference:<scheme code>"]`); blank when absent. */
    schemeReference: z.string(),
    /** Fixed-scale magnitudes in the schedule's currency. */
    employeeShare: Decimal4,
    employerShare: Decimal4,
  })
  .meta({ id: "StatutoryScheduleRow" });

export const StatutoryScheduleSchema = z
  .object({
    scheduleId: UuidSchema,
    schemeId: UuidSchema,
    schemeCode: z.string(),
    periodStart: DateSchema,
    periodEnd: DateSchema,
    /** The POSTED PAYROLL run these figures were generated from. */
    payrollDocumentId: UuidSchema,
    totalEmployee: MoneySchema,
    totalEmployer: MoneySchema,
    /** The archived generic CSV (owned by the run; downloadable under hr.payroll.read) — null if never attached. */
    attachmentId: UuidSchema.nullable(),
    /** The PAYMENT that settled the schedule, or null. */
    remittanceDocumentId: UuidSchema.nullable(),
    rows: z.array(StatutoryScheduleRowSchema),
    /**
     * ⚠️ OD-23. The employer's registration with the scheme; null until the owner supplies it, and a client names the
     * scheme rather than printing an empty box. Nullable, never optional: an absent key would hide the gap.
     */
    employerRegistration: z.string().nullable(),
  })
  .meta({ id: "StatutorySchedule" });

/** `.strict()`: an unknown member is refused rather than dropped. Omit `schemeIds` for every scheme the run touched. */
export const GenerateStatutoryScheduleBody = z
  .object({
    payrollDocumentId: UuidSchema,
    schemeIds: z.array(UuidSchema).min(1).max(100).optional(),
  })
  .strict()
  .meta({ id: "GenerateStatutoryScheduleBody" });

/** 8C T8 — the POSTED PAYMENT (4A's type) to the scheme's authority that settles the schedule. */
export const SettleStatutoryScheduleBody = z
  .object({ remittanceDocumentId: UuidSchema })
  .strict()
  .meta({ id: "SettleStatutoryScheduleBody" });

/** §4.2.8 Layer 2: literal `filter[…]` keys; keyset paging on (period_start, id), oldest first. Closed. */
export const StatutoryScheduleQuery = z
  .object({
    "filter[schemeId][eq]": UuidSchema.optional(),
    "filter[payrollDocumentId][eq]": UuidSchema.optional(),
    "filter[periodStart][gte]": DateSchema.optional(),
    "filter[periodStart][lte]": DateSchema.optional(),
    "filter[settled][eq]": z.enum(["true", "false"]).optional(),
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    sort: z.string().max(0, "sort is not supported on this resource").optional(),
    fields: z.string().max(0, "sparse fieldsets are not supported on this resource").optional(),
  })
  .strict();

export const StatutoryScheduleList = ListEnvelope(StatutoryScheduleSchema);

export type StatutoryScheduleDto = z.infer<typeof StatutoryScheduleSchema>;
export type GenerateStatutoryScheduleBodyDto = z.infer<typeof GenerateStatutoryScheduleBody>;
