import { z } from "zod";
import { DateSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/** One scalar of the ⚠️ OD-28 seam. A rate, a threshold or a formula never travels here (spec:2080). */
const ExtraSchema = z.record(
  z.string().max(80),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

/** ⚠️ OD-28. `extra` is the seam: when the owner's verified list arrives, its members become typed properties
 *  here and typed columns in 8B's migration 0090, and this object shrinks. */
export const StatutoryProfileSchema = z
  .object({
    id: UuidSchema,
    employeeId: UuidSchema,
    effectiveFrom: DateSchema,
    effectiveTo: DateSchema.nullable(),
    maritalStatus: z.string().max(40).nullable(),
    spouseWorking: z.boolean().nullable(),
    childReliefCount: z.number().int().min(0).nullable(),
    residencyCategory: z.string().max(40).nullable(),
    extra: ExtraSchema,
    enteredBy: UuidSchema,
    createdAt: TimestampSchema,
  })
  .meta({ id: "StatutoryProfile" });

/** Opening a profile closes the open one the day before (ADR 0072). `.strict()`: `enteredBy` and `effectiveTo`
 *  are the server's, and a caller sending either is refused rather than silently ignored. */
export const OpenStatutoryProfileBody = z
  .object({
    effectiveFrom: DateSchema,
    maritalStatus: z.string().max(40).nullable(),
    spouseWorking: z.boolean().nullable(),
    childReliefCount: z.number().int().min(0).nullable(),
    residencyCategory: z.string().max(40).nullable(),
    extra: ExtraSchema.default({}),
  })
  .strict()
  .meta({ id: "OpenStatutoryProfileBody" });

export const StatutoryProfileList = ListEnvelope(StatutoryProfileSchema);
export type StatutoryProfileDto = z.infer<typeof StatutoryProfileSchema>;

/**
 * The list route's query schema. It exists because a route with no `query` schema validates no query parameter,
 * so `?sort=maritalStatus` and `?filter[maritalStatus][eq]=married` would reach a 200 untouched — and test 32
 * asserts 400/ERR_VALIDATION_FAILED on exactly those (§4.2.8: "no field name ever reaches SQL as text").
 * `.strict()` refuses an undeclared key. It deliberately does NOT extend `ListQuery`: an employee's statutory
 * history is a handful of rows, the handler returns all of them and `next_cursor` is a constant `null`, so
 * `cursor` and `limit` are refused by name rather than accepted and ignored. `sort` and `fields` are declared,
 * bounded to the empty string (0B's `AuditLogQuery` form), so the document says this resource sorts and projects
 * nothing.
 */
export const StatutoryProfileQuery = z
  .object({
    sort: z.string().max(0, "sort is not supported on this resource").optional(),
    fields: z.string().max(0, "sparse fieldsets are not supported on this resource").optional(),
  })
  .strict();
