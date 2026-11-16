import { z } from "zod";
import { CursorSchema, DateSchema, ListEnvelope, MoneySchema, UuidSchema } from "../common";
import { MoneyOutStatusSchema } from "./payroll-payment";

// 8C T6 (§4.2.8, round 18 B10) — the employee-advance wire module. An advance is an EMPLOYEE_ADVANCE document with
// one line; submit, approve and post go through 2B's generic transitions route.

export const EmployeeAdvanceSchema = z
  .object({
    documentId: UuidSchema,
    series: z.string(),
    number: z.string().nullable(),
    status: MoneyOutStatusSchema,
    effectiveDate: DateSchema,
    branchId: UuidSchema,
    employeeId: UuidSchema,
    employeeNumber: z.string(),
    employeeName: z.string(),
    amount: MoneySchema,
    reason: z.string(),
  })
  .meta({ id: "EmployeeAdvance" });

/** The amount must be in the company's base currency and greater than zero — both refused by the service (422). */
export const CreateEmployeeAdvanceBody = z
  .object({
    employeeId: UuidSchema,
    effectiveDate: DateSchema,
    branchId: UuidSchema,
    amount: MoneySchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .meta({ id: "CreateEmployeeAdvanceBody" });

/** spec:2082: the outstanding balance is a LEDGER PROJECTION — `1400` tagged with the employee, as of a named date. */
export const EmployeeAdvanceBalanceSchema = z
  .object({
    employeeId: UuidSchema,
    asOf: DateSchema,
    balance: MoneySchema,
  })
  .meta({ id: "EmployeeAdvanceBalance" });

/** `asOf` is required: a balance never defaults to the clock (spec:2039). */
export const EmployeeAdvanceBalanceQuery = z.object({ asOf: DateSchema }).strict();

export const EmployeeAdvanceQuery = z
  .object({
    "filter[employeeId][eq]": UuidSchema.optional(),
    "filter[status][eq]": MoneyOutStatusSchema.optional(),
    "filter[effectiveDate][gte]": DateSchema.optional(),
    "filter[effectiveDate][lte]": DateSchema.optional(),
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    sort: z.string().max(0, "sort is not supported on this resource").optional(),
    fields: z.string().max(0, "sparse fieldsets are not supported on this resource").optional(),
  })
  .strict();

export const EmployeeAdvanceList = ListEnvelope(EmployeeAdvanceSchema);

export type EmployeeAdvanceDto = z.infer<typeof EmployeeAdvanceSchema>;
export type CreateEmployeeAdvanceBodyDto = z.infer<typeof CreateEmployeeAdvanceBody>;
