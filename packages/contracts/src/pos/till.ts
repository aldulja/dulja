import { z } from "zod";
import { PositiveQuantitySchema, UuidSchema, CurrencySchema } from "../common";
/** Main-process IPC inputs; exact strings, strict objects, no principal claims. */
export const TillAmountSchema = z.string().regex(/^-?\d+\.\d{4}$/);
export const TillLoginSchema = z
  .object({
    employeeNumber: z.string().trim().min(1).max(40),
    pin: z.string().regex(/^[0-9]{4,12}$/),
  })
  .strict();
export const TillSessionSchema = z.union([
  TillLoginSchema,
  z.object({ logout: z.literal(true) }).strict(),
]);
export const TillApprovalSchema = TillLoginSchema.extend({
  subject: z.enum(["discount", "void", "blind_return", "price_override"]),
  reason: z.string().trim().min(1).max(500),
}).strict();
export const TillQuickCustomerSchema = z
  .object({
    nameEn: z.string().trim().min(1).max(200),
    phone: z.string().max(40).nullable().optional(),
    // The sync wire's `NewCustomerSchema.code` is `.max(40)`; a longer code accepted here would 400 every
    // ticket batch that carries it and block the till's outbox for good (POS-01).
    code: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
export const TillSellLineSchema = z
  .object({
    itemId: UuidSchema,
    lotId: UuidSchema.nullable().optional(),
    unitId: UuidSchema.nullable().optional(),
    quantity: PositiveQuantitySchema,
    priceOverride: TillAmountSchema.nullable().optional(),
    discount: TillAmountSchema.nullable().optional(),
  })
  .strict();
export const TillSellSchema = z
  .object({
    shiftId: UuidSchema,
    kind: z.enum(["sale", "return"]).default("sale"),
    customerId: UuidSchema.nullable().optional(),
    quickCustomer: TillQuickCustomerSchema.optional(),
    account: z.boolean().default(false),
    returnsClientRef: UuidSchema.nullable().optional(),
    lines: z.array(TillSellLineSchema).min(1).max(200),
    ticketDiscount: TillAmountSchema.nullable().optional(),
    approvals: z.array(TillApprovalSchema).max(10).default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      (input.kind === "sale" && input.returnsClientRef != null) ||
      (input.kind === "return" &&
        (input.account ||
          input.quickCustomer ||
          input.ticketDiscount != null ||
          input.lines.some((l) => l.discount != null)))
    )
      ctx.addIssue({ code: "custom", message: "incompatible sale/return options" });
    if (input.quickCustomer && input.customerId != null)
      ctx.addIssue({ code: "custom", message: "choose an existing or new customer" });
  });
export const TillTenderSchema = z
  .object({
    clientRef: UuidSchema,
    tenders: z
      .array(
        z
          .object({
            method: z.enum(["cash", "card", "transfer", "store_credit"]),
            amount: TillAmountSchema,
            reference: z.string().max(120).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export const TillSearchSchema = z
  .object({
    text: z.string().trim().min(1).max(100).optional(),
    barcode: z.string().min(1).max(64).optional(),
    code: z.string().min(1).max(64).optional(),
    customer: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.text !== undefined || v.barcode !== undefined || v.code !== undefined, {
    message: "a search needs text, barcode or code",
  });
export const TillOpenShiftSchema = z
  .object({ openingFloat: TillAmountSchema, currency: CurrencySchema })
  .strict();
export const TillCloseShiftSchema = z
  .object({ shiftId: UuidSchema, countedCash: TillAmountSchema })
  .strict();
export const TillEnrolSchema = z.object({ code: z.string().regex(/^[A-Z2-7]{32}$/) }).strict();
export const TillClockSchema = z.object({ kind: z.enum(["clock_in", "clock_out"]) }).strict();
export const TillReceiptSchema = z.object({ clientRef: UuidSchema }).strict();

/** Shares the existing sell channel; authority is evaluated only in main. */
export const TillActionSchema = z
  .object({
    action: z.enum(["cancel_draft", "no_sale", "drawer_open", "void"]),
    shiftId: UuidSchema,
    clientRef: UuidSchema.optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
    approval: TillApprovalSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.action === "cancel_draft" || value.action === "void") &&
      (!value.clientRef || !value.reason)
    )
      ctx.addIssue({ code: "custom", message: "cancellation needs a ticket and reason" });
    if (
      (value.action === "no_sale" || value.action === "drawer_open") &&
      (value.clientRef || value.approval)
    )
      ctx.addIssue({ code: "custom", message: "drawer events cannot name tickets or approvals" });
    if (value.action === "cancel_draft" && value.approval)
      ctx.addIssue({ code: "custom", message: "draft cancellation does not use approval" });
    if (value.approval && value.approval.subject !== "void")
      ctx.addIssue({ code: "custom", message: "void approval must have the void subject" });
  });
/**
 * ⚠️ OD-10 (answered yes, 2026-11-04; ADR 0064): a paid-out, a safe drop or a banking, from the shift view.
 * Shares the sell channel like the drawer events. `amount` is a positive magnitude. A paid-out needs a
 * `reference` (the owner's fact 4) and, above the branch's `max_paid_out_amount`, a different supervisor's
 * credentials; `fromSafe` is a banking's choice of container. Authority is evaluated only in main.
 */
export const TillCashMovementSchema = z
  .object({
    action: z.literal("cash_movement"),
    shiftId: UuidSchema,
    kind: z.enum(["paid_out", "safe_drop", "banking"]),
    amount: TillAmountSchema,
    reference: z.string().trim().min(1).max(200).optional(),
    fromSafe: z.boolean().default(false),
    approval: TillLoginSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "paid_out" && !value.reference)
      ctx.addIssue({ code: "custom", message: "a paid-out needs a reference" });
    if (value.kind !== "banking" && value.fromSafe)
      ctx.addIssue({ code: "custom", message: "only a banking can come from the safe" });
    if (value.kind !== "paid_out" && value.approval)
      ctx.addIssue({ code: "custom", message: "only a paid-out takes supervisor approval" });
  });
export const TillSellRequestSchema = z.union([
  TillActionSchema,
  TillCashMovementSchema,
  TillSellSchema,
]);
