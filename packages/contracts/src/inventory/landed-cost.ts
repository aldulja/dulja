import { z } from "zod";
import { ListEnvelope, QuantitySchema, TimestampSchema, UuidSchema } from "../common";

/** Money on the wire in this module is a 4-dp decimal string with NO currency member, under the §4.2.8
 *  exception this slice registers: every row below is returned under a path that already names the
 *  document whose currency it is, and `app.landed_cost_allocation` has no currency column at all. The
 *  arithmetic behind each figure is still `Money` (`landedCostSummary`, Global Constraint 4). */
const MoneyAmount = z.string().regex(/^-?\d+\.\d{4}$/);

/** How one cost line is split across the goods lines: by their amount, their quantity, or their
 *  `weight_kg` custom field. */
export const LandedCostMethodSchema = z.enum(["by_value", "by_quantity", "by_weight"]);

export const AllocateLandedCostBody = z.object({
  allocations: z
    .array(
      z.object({
        /** An `account` line of this document carrying freight, duty, clearance or handling. */
        costLineId: UuidSchema,
        method: LandedCostMethodSchema,
      }),
    )
    .min(1)
    .max(50),
});

export const LandedCostAllocationSchema = z.object({
  id: UuidSchema,
  costLineId: UuidSchema,
  targetLineId: UuidSchema,
  method: LandedCostMethodSchema,
  allocatedAmount: MoneyAmount,
  createdAt: TimestampSchema,
});

export const LandedCostAllocationList = ListEnvelope(LandedCostAllocationSchema);

/** A read model. Nothing stores `landedAmount`: it is `lineAmount + allocated`, recomputed on every read. */
export const LandedCostSummarySchema = z.object({
  targetLineId: UuidSchema,
  lineNo: z.number().int().positive(),
  itemId: UuidSchema.nullable(),
  lineAmount: MoneyAmount,
  allocated: MoneyAmount,
  landedAmount: MoneyAmount,
  quantity: QuantitySchema.nullable(),
});
