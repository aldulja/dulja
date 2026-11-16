import { z } from "zod";
import { DateSchema, ListEnvelope, MoneySchema, QuantitySchema, UuidSchema } from "../common";

export const CompensationLineSchema = z
  .object({
    id: UuidSchema,
    employeeId: UuidSchema,
    componentId: UuidSchema,
    effectiveFrom: DateSchema,
    effectiveTo: DateSchema.nullable(),
    amount: MoneySchema.nullable(),
    quantity: QuantitySchema.nullable(),
    enteredBy: UuidSchema,
  })
  .meta({ id: "CompensationLine" });

/** Opening a line closes the previous open line of the same component the day before (ADR 0072). An amount is in
 *  the company's base currency (v1 payroll is single-currency, spec:2093); `enteredBy` is the server's. */
export const OpenCompensationBody = z
  .object({
    componentId: UuidSchema,
    effectiveFrom: DateSchema,
    amount: MoneySchema.optional(),
    quantity: QuantitySchema.optional(),
  })
  .strict()
  .refine((b) => b.amount !== undefined || b.quantity !== undefined, {
    message: "a compensation line needs an amount or a quantity",
  })
  .meta({ id: "OpenCompensationBody" });

/**
 * The ONLY filters: a component and an as-of date. `amount` is deliberately neither filterable nor sortable — test
 * 32 forbids a compensation side channel. Two mechanisms close it, and both are needed because they close different
 * halves: `.strict()` turns an UNDECLARED key (`filter[amount][gt]`) into ERR_VALIDATION_FAILED, and the two
 * `.max(0, …)` bounds refuse a value on `sort` and `fields`. It does not extend `ListQuery`: an employee's lines are
 * a handful, the handler returns all of them with a constant `null` cursor, so `cursor` and `limit` are refused by
 * name rather than accepted and ignored.
 */
export const CompensationQuery = z
  .object({
    "filter[componentId][eq]": UuidSchema.optional(),
    "filter[effectiveOn][eq]": DateSchema.optional(),
    sort: z.string().max(0, "sort is not supported on this resource").optional(),
    fields: z.string().max(0, "sparse fieldsets are not supported on this resource").optional(),
  })
  .strict();
export const CompensationList = ListEnvelope(CompensationLineSchema);
export type CompensationLineDto = z.infer<typeof CompensationLineSchema>;
