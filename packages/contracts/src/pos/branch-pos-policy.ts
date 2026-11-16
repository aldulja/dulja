import { z } from "zod";
import { ListEnvelope, ListQuery, UuidSchema } from "../common";

/** A fraction, not a percent: "0.150000" is fifteen per cent (0066's `between 0 and 1` CHECK). */
const Pct = z
  .string()
  .regex(/^0\.\d{6}$|^1\.000000$/, "a 6-dp fraction between 0.000000 and 1.000000");
/** A non-negative 4-dp amount in the company's base currency. `no-number-money` forbids the `number` form. */
const Amount = z.string().regex(/^\d{1,15}\.\d{4}$/);

export const BranchPosPolicySchema = z
  .object({
    id: UuidSchema,
    branchId: UuidSchema,
    maxLineDiscountPct: Pct,
    maxTicketDiscountPct: Pct,
    maxVoidAmount: Amount,
    maxPriceOverridePct: Pct,
    blindReturnAllowed: z.boolean(),
    maxBlindReturnAmount: Amount,
    maxCashInDrawer: Amount.nullable(),
    requireCustomerOver: Amount.nullable(),
    roundingIncrement: Amount.refine(
      (value) => !/^0+\.0{4}$/.test(value),
      "rounding increment must be positive",
    ),
    paidOutAllowed: z.boolean(),
    maxPaidOutAmount: Amount,
    revision: z.string().regex(/^\d+$/), // a bigint on the wire is a decimal STRING, never a JSON number
  })
  .meta({ id: "BranchPosPolicy" });

export const UpsertBranchPosPolicyBody = BranchPosPolicySchema.omit({ id: true, revision: true })
  .partial()
  .extend({ branchId: UuidSchema })
  .strict()
  .meta({ id: "UpsertBranchPosPolicyBody" });

export const BranchPosPolicyQuery = ListQuery.extend({
  "filter[branchId][eq]": UuidSchema.optional(), // §4.2.8 Layer 2: a literal filter key, typed and in the OpenAPI document
});
export const BranchPosPolicyList = ListEnvelope(BranchPosPolicySchema);
export type BranchPosPolicyDto = z.infer<typeof BranchPosPolicySchema>;
