// packages/contracts/src/accounting/einvoice.ts (5B)
//
// §4.2.8's naming: <Resource>Schema, <Resource>Query, <Resource>List, <Verb><Resource>Body.
// Money does not appear here: a transmission carries no amount of its own — the amounts are in the
// document it points at, and duplicating one would give LEGACY-019 a second place to disagree.

import { z } from "zod";
import { ListEnvelope, ListQuery, ProblemSchema, TimestampSchema, UuidSchema } from "../common";

export const TransmissionStatusSchema = z.enum([
  "pending",
  "submitted",
  "accepted",
  "rejected",
  "cancelled",
  "error",
]);

/** The closed vocabulary of `company.einvoice_transmitter` (contracts amendment 5). */
export const TransmitterCodeSchema = z.enum(["synthetic", "myinvois"]);

/** The §3.11 name, and the ONLY value `company.einvoice_credential_ref` may hold. The literal is
 *  repeated here rather than imported because `packages/contracts` may not import `packages/db`
 *  (§3.1); Step 9's source-fact `it` asserts the two spellings agree, so they cannot drift. */
export const EinvoiceSecretNameSchema = z.enum(["EINVOICE_CLIENT_SECRET"]);

export const EinvoiceTransmissionSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  documentId: UuidSchema,
  transmitter: z.string(),
  profileVersion: z.number().int().nullable(),
  externalId: z.string().nullable(),
  status: TransmissionStatusSchema,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  /** lower-case hex of the canonical payload's sha256 — the document hash of §4.9.3. */
  requestSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  qrPayload: z.string().nullable(),
  submittedAt: TimestampSchema.nullable(),
  acceptedAt: TimestampSchema.nullable(),
  cancelledAt: TimestampSchema.nullable(),
  polledAt: TimestampSchema.nullable(),
  /** A call to the authority is in flight since this instant; null means none is (ADR 0053). A
   *  first submission reads `pending` throughout its call, so this is how an operator sees one. A
   *  claim older than the claim window is a dead one, which the next verb takes over. */
  claimedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type EinvoiceTransmissionDto = z.infer<typeof EinvoiceTransmissionSchema>;

export const EinvoiceTransmissionList = ListEnvelope(EinvoiceTransmissionSchema);

/** §4.2.8's Layer 2 default: literal `filter[…][…]` keys, `.strict()` so an undeclared parameter is
 *  `ERR_VALIDATION_FAILED` rather than a silently ignored word. `status` is the one filterable field;
 *  `documentId` is not, because the transmission of a document is reached through the document. */
export const EinvoiceTransmissionQuery = ListQuery.extend({
  "filter[status][eq]": TransmissionStatusSchema.optional(),
}).strict();

export const CancelTransmissionBody = z
  .object({
    reason: z.string().min(1).max(500),
  })
  .strict();

/** 202: the row as it stands plus the job the route enqueued. The status is still `pending` —
 *  saying so in the schema stops a client from treating 202 as "submitted". */
export const SubmitAcceptedSchema = z.object({
  transmission: EinvoiceTransmissionSchema,
  jobId: z.string(),
});

export const EinvoiceSettingsSchema = z.object({
  transmitter: TransmitterCodeSchema.nullable(),
  clientId: z.string().nullable(),
  /** The NAME of the secret. This API never returns, accepts or logs the value (§4.9.3). */
  credentialRef: EinvoiceSecretNameSchema.nullable(),
});
export type EinvoiceSettingsDto = z.infer<typeof EinvoiceSettingsSchema>;

/** The `all three or none` CHECK of migration 0057, restated at the edge so the refusal is a 400 with
 *  a sentence rather than a 500 from a constraint violation. The database check remains the control. */
export const EinvoiceSettingsBody = EinvoiceSettingsSchema.strict().superRefine((v, ctx) => {
  const set = [v.transmitter, v.clientId, v.credentialRef].filter((x) => x !== null).length;
  if (set !== 0 && set !== 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message:
        "einvoice settings are all three or none: transmitter, clientId and credentialRef must be set together, or all null to turn e-invoicing off",
    });
  }
});

export { ProblemSchema };
