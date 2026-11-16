import { z } from "zod";
import { CursorSchema, DateSchema, ListEnvelope, MoneySchema, UuidSchema } from "../common";

// 8C T6 (§4.2.8, round 18 B10) — the payroll-payment wire module. A batch is a PAYROLL_PAYMENT document; submit,
// approve and post go through 2B's generic `…/documents/{documentId}/transitions` route and have no schema here.

/** `app.document_status`'s seven labels. `MoneyOutStatus` in `packages/db/src/hr/money-out.ts` is its twin. */
export const MoneyOutStatusSchema = z
  .enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"])
  .meta({ id: "MoneyOutStatus" });

export const PayrollPaymentLineSchema = z
  .object({
    documentLineId: UuidSchema,
    employeeId: UuidSchema,
    employeeNumber: z.string(),
    employeeName: z.string(),
    /** The employee's net pay on the run — a magnitude; the policy's `side` carries the direction (§4.4.2 A9). */
    amount: MoneySchema,
    /** The EMPLOYEE's home branch (a BRANCH dimension value), not the batch's (amendment B8). */
    branchId: UuidSchema,
  })
  .meta({ id: "PayrollPaymentLine" });

export const PayrollPaymentSchema = z
  .object({
    documentId: UuidSchema,
    series: z.string(),
    /** Null until issue — numbering is at issue (§4.3.6). */
    number: z.string().nullable(),
    status: MoneyOutStatusSchema,
    effectiveDate: DateSchema,
    /** The batch's own branch — the bank leg's BRANCH. */
    branchId: UuidSchema,
    /** The POSTED PAYROLL run whose net pay this batch clears. */
    payrollDocumentId: UuidSchema,
    employeeCount: z.number().int().nonnegative(),
    total: MoneySchema,
    lines: z.array(PayrollPaymentLineSchema),
  })
  .meta({ id: "PayrollPayment" });

/** `.strict()`: an unknown member is refused rather than dropped. Omit `employeeIds` to pay every unpaid employee on
 *  the run. */
export const CreatePayrollPaymentBody = z
  .object({
    payrollDocumentId: UuidSchema,
    effectiveDate: DateSchema,
    branchId: UuidSchema,
    employeeIds: z.array(UuidSchema).min(1).max(1000).optional(),
  })
  .strict()
  .meta({ id: "CreatePayrollPaymentBody" });

/** §4.2.8 Layer 2: literal `filter[…]` keys; keyset paging on (effective_date, id), newest first. Closed
 *  (`.strict()`, the 8A/8B query form). */
export const PayrollPaymentQuery = z
  .object({
    "filter[payrollDocumentId][eq]": UuidSchema.optional(),
    "filter[status][eq]": MoneyOutStatusSchema.optional(),
    "filter[effectiveDate][gte]": DateSchema.optional(),
    "filter[effectiveDate][lte]": DateSchema.optional(),
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    sort: z.string().max(0, "sort is not supported on this resource").optional(),
    fields: z.string().max(0, "sparse fieldsets are not supported on this resource").optional(),
  })
  .strict();

export const PayrollPaymentList = ListEnvelope(PayrollPaymentSchema);

export type PayrollPaymentDto = z.infer<typeof PayrollPaymentSchema>;
export type CreatePayrollPaymentBodyDto = z.infer<typeof CreatePayrollPaymentBody>;
