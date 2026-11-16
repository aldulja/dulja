import { z } from "zod";
import { DateSchema, TimestampSchema, UuidSchema } from "../common";

/** The nine wire names, exported so the side-channel test scans for exactly what the schema declares
 *  rather than for a hand-typed list that can drift away from it (test 32). */
export const SENSITIVE_WIRE_FIELDS = [
  "nationalId",
  "passport",
  "dateOfBirth",
  "residencyCategory",
  "bankAccount",
  "epfNumber",
  "socsoNumber",
  "taxNumber",
  "workPermitExpiry",
] as const;

const Field = z.string().max(120).nullable();

export const EmployeeSensitiveSchema = z
  .object({
    employeeId: UuidSchema,
    nationalId: Field,
    passport: Field,
    dateOfBirth: DateSchema.nullable(),
    residencyCategory: Field,
    bankAccount: Field,
    epfNumber: Field,
    socsoNumber: Field,
    taxNumber: Field,
    workPermitExpiry: DateSchema.nullable(),
    keyVersion: z.number().int().min(1),
    updatedBy: UuidSchema,
    updatedAt: TimestampSchema,
  })
  .meta({ id: "EmployeeSensitive" });

/** Every field optional (send only what changes) and nullable (an explicit null clears it). `keyVersion` is
 *  deliberately ABSENT: the server always seals under the ring's current version, so a caller can neither pin
 *  an old key nor claim a version it does not hold. `.strict()` so a stray key is refused, not dropped. */
export const UpdateEmployeeSensitiveBody = z
  .object({
    nationalId: Field.optional(),
    passport: Field.optional(),
    dateOfBirth: DateSchema.nullable().optional(),
    residencyCategory: Field.optional(),
    bankAccount: Field.optional(),
    epfNumber: Field.optional(),
    socsoNumber: Field.optional(),
    taxNumber: Field.optional(),
    workPermitExpiry: DateSchema.nullable().optional(),
  })
  .strict()
  .meta({ id: "UpdateEmployeeSensitiveBody" });

export type EmployeeSensitiveDto = z.infer<typeof EmployeeSensitiveSchema>;
