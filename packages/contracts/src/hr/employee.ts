import { z } from "zod";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const EmployeeSchema = z
  .object({
    id: UuidSchema,
    partyId: UuidSchema,
    employeeNumber: z.string().min(1).max(40),
    homeBranchId: UuidSchema,
    principalId: UuidSchema.nullable(),
    hiredOn: DateSchema,
    terminatedOn: DateSchema.nullable(),
    createdAt: TimestampSchema,
    // 8A — migration 0080's columns (§4.6.1). `statutoryProfileNote` is deliberately NOT on the wire in 8A,
    // and no 8A route reads or writes it: it is free text a payroll officer keeps about statutory handling,
    // whereas the statutory INPUTS are the rows of app.employee_statutory_profile (migration 0082) that
    // 8A's sub-resource returns under hr.compensation.read. No sensitive field is ever on this schema.
    position: z.string().max(120).nullable(),
    employmentType: z.enum(["full_time", "part_time", "contract", "hourly"]).nullable(),
    archivedAt: TimestampSchema.nullable(),
  })
  .meta({ id: "Employee" });

export const CreateEmployeeBody = z
  .object({
    employeeNumber: z.string().min(1).max(40),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).optional(),
    homeBranchId: UuidSchema,
    hiredOn: DateSchema,
    // 8A — both optional, so 6C's existing callers are unaffected.
    position: z.string().max(120).optional(),
    employmentType: z.enum(["full_time", "part_time", "contract", "hourly"]).optional(),
  })
  .strict()
  .meta({ id: "CreateEmployeeBody" });

/** ADR 0097 (full review PRD-07) — `PATCH …/employees/{employeeId}`: the non-sensitive master fields only. `.strict()`
 *  refuses the number, the home branch, `terminatedOn` (its own verb) and every sensitive or compensation field. */
export const UpdateEmployeeBody = z
  .object({
    nameEn: z.string().min(1).max(200).optional(),
    nameAr: z.string().max(200).nullable().optional(),
    hiredOn: DateSchema.optional(),
    position: z.string().max(120).nullable().optional(),
    employmentType: z.enum(["full_time", "part_time", "contract", "hourly"]).nullable().optional(),
  })
  .strict()
  .meta({ id: "UpdateEmployeeBody" });
/** ADR 0097 — `POST …/employees/{employeeId}/terminate`. */
export const TerminateEmployeeBody = z
  .object({ terminatedOn: DateSchema })
  .strict()
  .meta({ id: "TerminateEmployeeBody" });

/** The ONLY filters: the home branch and the active flag. The employee directory is the one list in this
 *  slice with an undeclared-key assertion against it — Step 3's *"the list filters on the two declared keys
 *  and nothing else"* case sends `?filter[hiredOn][gte]=2026-01-01` and expects **400** — and 8A's Task 4
 *  adds four more against the same route (`filter[nationalId][eq]`, `filter[bankAccount][like]`,
 *  `sort=nationalId`, `sort=-bankAccount`, `fields=nationalId`), because 8A's 0080 columns are the sensitive
 *  ones and test 32 forbids a side channel through a query parameter. `CashierQuery`, `AttendanceQuery` and
 *  `BranchPosPolicyQuery` carry no such assertion and are deliberately left as plain extends.
 *
 *  **A bare `z.object` does not enforce that.** §4.2.8's *"an undeclared field is ERR_VALIDATION_FAILED"* is
 *  the required behaviour, not what Zod does by default: a plain object **strips** an unknown key and answers
 *  200. Two mechanisms are needed because they close different halves:
 *
 *  1. `.strict()` — turns an UNDECLARED key (`filter[hiredOn][gte]`, `filter[nationalId][eq]`) into
 *     ERR_VALIDATION_FAILED. 1B, 5A, 5B and 8A do the same on their literal-key query schemas.
 *  2. The two `z.string().max(0, …)` overrides — `sort` and `fields` are **declared** members of `ListQuery`
 *     (0b:1331), so `.strict()` admits them however sensitive the name they carry, and `listEmployees` reads
 *     neither (it is keyset on the id). Bounding them to the empty string on the same key is 0B's
 *     `AuditLogQuery` remedy (0b:4321): a `.refine` would wrap the object in `ZodEffects` and
 *     `@hono/zod-openapi` would stop generating query parameters from it.
 *
 *  **0B's own `AuditLogQuery` is correctly NOT `.strict()`** (0b:7384) — the audit log is §4.2.8 Layer 1's
 *  open `parseFilters` surface and `sah-036` sends undeclared keys expecting them stripped. This is a Layer 2
 *  literal-key schema, where the enumeration IS the contract. Not an inconsistency to "harmonise". */
export const EmployeeQuery = ListQuery.extend({
  "filter[homeBranchId][eq]": UuidSchema.optional(),
  "filter[active][eq]": z.enum(["true", "false"]).optional(), // terminated_on is null
  sort: z.string().max(0, "sort is not supported on this resource").optional(),
  fields: z.string().max(0, "sparse fieldsets are not supported on this resource").optional(),
}).strict();
export const EmployeeList = ListEnvelope(EmployeeSchema);
export type EmployeeDto = z.infer<typeof EmployeeSchema>;
