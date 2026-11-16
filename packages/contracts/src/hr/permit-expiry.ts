import { z } from "zod";
import { DateSchema, ListEnvelope, UuidSchema } from "../common";

// 8D T3 (amendment A3, contracts round 19) — the permit half of spec:2091's "contract and permit expiry list". The
// permit date is an `employee_sensitive` field, so this module is served ONLY under hr.employee.read_sensitive, and
// `PermitExpiry` is a named carrier of `workPermitExpiry` in test 32's allow-list
// (`tests/invariants/hr-sensitive-side-channels.test.ts`), beside the sensitive pair.

export const PermitExpirySchema = z
  .object({
    employeeId: UuidSchema,
    employeeNumber: z.string(),
    employeeNameEn: z.string(),
    branchCode: z.string(),
    position: z.string().nullable(),
    /** Decrypted from the employee's sealed sensitive row. */
    workPermitExpiry: DateSchema,
    /** Whole days from today (the company's calendar day) to the expiry; negative once it has lapsed. */
    daysRemaining: z.number().int(),
  })
  .meta({ id: "PermitExpiry" });

/**
 * No cursor: the list is bounded by `withinDays`. These two are parameters of the computation, not filters over a
 * dataset, so the route declares no `filter[…]` grammar (§4.2.8 Layer 1). `.strict()`: an unknown key is a 400.
 *
 * `includeTerminated` is an explicit enum, NOT `z.coerce.boolean()`: a query value is a string and
 * `Boolean("false")` is `true`, so `?includeTerminated=false` would list people who have left.
 */
export const PermitExpiryQuery = z
  .object({
    withinDays: z.coerce.number().int().min(0).max(3650).default(90),
    includeTerminated: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .strict();

/** `next_cursor` is always null — the window bounds the list. */
export const PermitExpiryList = ListEnvelope(PermitExpirySchema).meta({ id: "PermitExpiryList" });
