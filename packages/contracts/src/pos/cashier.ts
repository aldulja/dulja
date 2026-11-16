import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

/** The projection the till mirrors. `revision` is a decimal STRING — a bigint has no safe JSON number. */
export const CashierSnapshotSchema = z
  .object({
    codes: z.array(z.string()),
    limits: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])),
    revision: z.string().regex(/^\d+$/),
  })
  .meta({ id: "CashierSnapshot" });

export const CashierSchema = z
  .object({
    principalId: UuidSchema,
    employeeId: UuidSchema,
    employeeNumber: z.string().nullable(),
    branchId: UuidSchema,
    pinUpdatedAt: TimestampSchema,
    revokedAt: TimestampSchema.nullable(),
    revision: z.string().regex(/^\d+$/),
    snapshot: CashierSnapshotSchema,
  })
  .meta({ id: "Cashier" });
// `pinHash` is NOT a member and never becomes one: it is a credential, and a response schema is the one
// place a credential leaks without anybody writing the word "leak" (SAH-028).

const Pin = z.string().regex(/^[0-9]{4,12}$/, "a PIN is 4-12 digits"); // the same band `hashPin` enforces

export const CreateCashierBody = z
  .object({
    employeeId: UuidSchema,
    branchId: UuidSchema,
    email: z.string().email(), // OD-11 makes this optional; until then it is required (T11)
    displayName: z.string().min(1).max(200),
    pin: Pin,
  })
  .strict()
  .meta({ id: "CreateCashierBody" });

export const SetPinBody = z.object({ pin: Pin }).strict().meta({ id: "SetPinBody" });

export const CashierQuery = ListQuery.extend({ "filter[branchId][eq]": UuidSchema.optional() });
export const CashierList = ListEnvelope(CashierSchema);
export type CashierDto = z.infer<typeof CashierSchema>;
