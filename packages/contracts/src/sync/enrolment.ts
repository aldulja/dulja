// packages/contracts/src/sync/enrolment.ts
import { z } from "zod";
import { ListEnvelope, TimestampSchema, UuidSchema } from "../common";

export const CreateEnrolmentBody = z.object({
  companyId: UuidSchema,
  branchId: UuidSchema,
  name: z.string().min(1).max(120),
  /** Becomes `pos_terminal.code` and therefore the numbering suffix `POS-<code>` (§4.3.6). */
  terminalCode: z
    .string()
    .regex(/^[A-Z0-9-]{1,12}$/, "upper-case letters, digits and hyphens, at most 12"),
  ttlMinutes: z.number().int().min(5).max(1440).optional(),
});

/** The code appears in THIS response and nowhere else, ever (spec:1322). */
export const CreatedEnrolmentSchema = z.object({
  enrolmentId: UuidSchema,
  code: z.string().regex(/^[A-Z2-7]{32}$/),
  expiresAt: TimestampSchema,
});

export const EnrolmentSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  branchId: UuidSchema,
  name: z.string(),
  terminalCode: z.string(),
  expiresAt: TimestampSchema,
  redeemedAt: TimestampSchema.nullable(),
  terminalId: UuidSchema.nullable(),
  createdAt: TimestampSchema,
});
export const EnrolmentQuery = z.object({ companyId: UuidSchema });
export const EnrolmentList = ListEnvelope(EnrolmentSchema);

export const EnrolBody = z.object({
  code: z.string().regex(/^[A-Z2-7]{32}$/),
  /** Ed25519 SPKI DER, base64. 44 bytes DER for an Ed25519 key; the route re-checks the length. */
  devicePublicKey: z
    .string()
    .regex(/^[A-Za-z0-9+/]+=*$/)
    .max(200),
});
export const EnrolResultSchema = z.object({
  terminalId: UuidSchema,
  branchId: UuidSchema,
  companyId: UuidSchema,
});
