import { z } from "zod";
import { ListEnvelope, UuidSchema } from "../common";

// 8D T5 (spec:2083; amendments A4 and A5, contracts round 19) — the payslip wire module. Generating payslips writes one
// attachment per employee on the POSTED PAYROLL run and answers with their ids and hashes; the PDF itself is 2C's
// `GET …/attachments/{attachmentId}/content`.

/** `.strict()`: an unknown member is refused rather than dropped. */
export const GeneratePayslipsBody = z
  .object({
    lang: z.enum(["en", "ar"]).default("en"),
    /** Omit for every employee of the run. An id the run did not pay is absent from the result, not an error — a
     *  payslip for an employee the run did not pay is nothing to print. */
    employeeIds: z.array(UuidSchema).min(1).max(1000).optional(),
  })
  .strict()
  .meta({ id: "GeneratePayslipsBody" });

export const PayslipSchema = z
  .object({
    attachmentId: UuidSchema,
    employeeId: UuidSchema,
    employeeNumber: z.string(),
    fileName: z.string(),
    byteSize: z.number().int().nonnegative(),
    /** Lower-case hex SHA-256 of the stored PDF, computed by the server (spec:2083 "with its hash"). */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .meta({ id: "Payslip" });

/** `next_cursor` is always null: one item per employee of one run. */
export const GeneratePayslipsResult = ListEnvelope(PayslipSchema).meta({
  id: "GeneratePayslipsResult",
});
