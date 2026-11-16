// packages/contracts/src/pos/shift.ts
import { z } from "zod";
import {
  DateSchema,
  CurrencySchema,
  ListEnvelope,
  ListQuery,
  MoneySchema,
  TimestampSchema,
  UuidSchema,
} from "../common";

export const ShiftSchema = z
  .object({
    shiftId: UuidSchema,
    branchId: UuidSchema,
    terminalId: UuidSchema,
    terminalCode: z.string(),
    openedAt: TimestampSchema,
    closedAt: TimestampSchema.nullable(),
    openedPrincipalId: UuidSchema,
    closedPrincipalId: UuidSchema.nullable(),
    currency: CurrencySchema,
    openingFloat: MoneySchema,
    countedCash: MoneySchema.nullable(),
    expectedCash: MoneySchema.nullable(),
    overShort: MoneySchema.nullable(),
    overShortDocumentId: UuidSchema.nullable(),
  })
  .meta({ id: "Shift" });

/** Literal `filter[…]` keys — §4.2.8 Layer 2's default, and this surface is four pairs, under the
 *  threshold at which `parseFilters` earns its keep. */
export const ShiftQuery = ListQuery.extend({
  "filter[branchId][eq]": UuidSchema.optional(),
  "filter[terminalId][eq]": UuidSchema.optional(),
  "filter[openedAt][gte]": DateSchema.optional(),
  "filter[openedAt][lte]": DateSchema.optional(),
  "filter[closedAt][eq]": z.enum(["null", "not_null"]).optional(),
});
export const ShiftList = ListEnvelope(ShiftSchema);

export const TillEventSchema = z
  .object({
    id: UuidSchema,
    shiftId: UuidSchema,
    kind: z.enum(["no_sale", "drawer_open", "void"]),
    ticketDocumentId: UuidSchema.nullable(),
    cashierPrincipalId: UuidSchema,
    supervisorPrincipalId: UuidSchema.nullable(),
    occurredAt: TimestampSchema,
    clientRef: UuidSchema,
    reason: z.string().nullable(),
  })
  .meta({ id: "TillEvent" });
export const TillEventList = ListEnvelope(TillEventSchema);
