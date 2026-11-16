// packages/contracts/src/sync/ticket.ts — §4.10.1's shapes, as schemas. The wire and the TypeScript come
// from one place, which is what makes spec:1318's "as though an external client would use it" checkable.
import { z } from "zod";
import { MoneySchema, QuantitySchema, TimestampSchema, UuidSchema } from "../common";

/** A bigint crosses the wire as a decimal STRING. Read as a JSON number a revision past 2^53 would round,
 *  and one row would be re-delivered for ever — the failure acceptance test 20 exists to catch (T1). */
const BigintString = z.string().regex(/^\d+$/);
export const TenderMethodSchema = z.enum(["cash", "card", "transfer", "store_credit"]);

export const TicketLineSchema = z.strictObject({
  lineNo: z.number().int().min(1),
  itemId: UuidSchema,
  lotId: UuidSchema.nullable(),
  /** Signed: NEGATIVE on a return line. Direction is carried by this sign on the wire and by
   *  `PlannedMovement.effect` / `PlannedLedgerLine.side` after evaluation (§4.4.2 A9). */
  quantity: QuantitySchema,
  unitId: UuidSchema,
  unitPrice: MoneySchema,
  discount: MoneySchema,
  taxCodeId: UuidSchema.nullable(),
  taxAmount: MoneySchema,
  /** Tax-INCLUSIVE: `POS_TICKET` declares `tax.inclusive: true` (§4.6.5). */
  total: MoneySchema,
  /** The promotion's share of `discount`, signed like it, and the promotion that earned it: evidence the server
   *  recomputes before it leaves that share out of discount authority and branch limits (proposed ADR 0059
   *  amendment, PR 12 review). Optional and nullable, so a till that predates it is read as before. */
  promotion: z
    .strictObject({ promotionId: UuidSchema, discount: MoneySchema })
    .nullable()
    .optional(),
});

export const TicketTenderSchema = z.strictObject({
  tenderNo: z.number().int().min(1),
  method: TenderMethodSchema,
  amount: MoneySchema,
  reference: z.string().max(120).nullable(),
});

/** `code` is the ONE override code the server can store (§4.10.1): `document_event.override_code` admits
 *  exactly `OverrideCode`'s three values, and `assert_override_authorised` verifies the supervisor holds
 *  *that* code. What the override was FOR travels in `subject`. */
export const TicketEventSchema = z.strictObject({
  kind: z.literal("override"),
  code: z.literal("pos.ticket.override"),
  subject: z.enum(["discount", "void", "blind_return", "price_override"]),
  supervisorPrincipalId: UuidSchema,
  reason: z.string().min(1).max(500),
});

export const NewCustomerSchema = z.strictObject({
  id: UuidSchema,
  code: z.string().min(1).max(40),
  nameEn: z.string().min(1).max(200),
  phone: z.string().max(40).nullable(),
});

export const TicketSchema = z.strictObject({
  clientRef: UuidSchema,
  shiftId: UuidSchema,
  cashierPrincipalId: UuidSchema,
  customerId: UuidSchema.nullable(),
  newCustomer: NewCustomerSchema.nullable().default(null),
  cashRounding: z
    .strictObject({ lineNo: z.number().int().min(1), adjustment: MoneySchema })
    .nullable()
    .optional(),
  kind: z.enum(["sale", "return"]),
  returnsClientRef: UuidSchema.nullable(),
  currency: z.string().length(3),
  soldAt: TimestampSchema,
  lines: z.array(TicketLineSchema).min(1),
  tenders: z.array(TicketTenderSchema),
  events: z.array(TicketEventSchema),
  attendance: z.array(
    z.object({
      kind: z.enum(["clock_in", "clock_out"]),
      principalId: UuidSchema,
      at: TimestampSchema,
    }),
  ),
  catalogueRevision: BigintString,
});

/** STRICT, like every other message of the batch. The till sends `countedCash` and nothing else: the server
 *  derives `expectedCash` and `overShort` from the ledger (ADR 0063), and a payload carrying either — or any
 *  other unknown key — is REFUSED, not stripped, so a tampered or buggy till learns its figure was not taken. */
export const ShiftOpenCloseSchema = z.strictObject({
  shiftId: UuidSchema,
  kind: z.enum(["open", "close"]),
  terminalId: UuidSchema,
  cashierPrincipalId: UuidSchema,
  at: TimestampSchema,
  currency: z.string().length(3),
  openingFloat: MoneySchema.nullable(),
  countedCash: MoneySchema.nullable(),
});

export const TillEventMsgSchema = z.strictObject({
  reason: z.string().trim().min(1).max(2000).nullable().optional(),
  clientRef: UuidSchema,
  shiftId: UuidSchema,
  kind: z.enum(["no_sale", "drawer_open", "void"]),
  ticketClientRef: UuidSchema.nullable(),
  cashierPrincipalId: UuidSchema,
  supervisorPrincipalId: UuidSchema.nullable(),
  occurredAt: TimestampSchema,
});

/** ⚠️ OD-10 (answered yes, 2026-11-04; ADR 0064). STRICT like its siblings. `amount` is a positive magnitude
 *  — the kind carries the direction — and the server refuses a paid-out without a `reference` (OD-10 fact 4)
 *  and a `fromSafe` on anything but a banking. */
export const TillCashMsgSchema = z.strictObject({
  clientRef: UuidSchema,
  shiftId: UuidSchema,
  kind: z.enum(["paid_out", "safe_drop", "banking"]),
  amount: MoneySchema,
  cashierPrincipalId: UuidSchema,
  supervisorPrincipalId: UuidSchema.nullable(),
  occurredAt: TimestampSchema,
  reference: z.string().trim().min(1).max(200).nullable(),
  fromSafe: z.boolean(),
});

export const TicketBatchSchema = z.strictObject({
  terminalId: UuidSchema,
  batchId: UuidSchema,
  tickets: z.array(TicketSchema),
  shifts: z.array(ShiftOpenCloseSchema),
  tillEvents: z.array(TillEventMsgSchema),
  /** ⚠️ OD-10 — optional, so a three-array batch from a till that predates it is still valid. */
  cashEvents: z.array(TillCashMsgSchema).optional(),
});

/** An EMPTY batch is refused at the schema and never reaches `applyBatch`: it would take the per-terminal
 *  advisory lock, read the catalogue revision and answer three empty arrays — work and a lock for nothing,
 *  on a route a till may poll. */
export const TicketBatchBody = TicketBatchSchema.refine(
  (b) => b.tickets.length + b.shifts.length + b.tillEvents.length + (b.cashEvents?.length ?? 0) > 0,
  "a batch carries at least one message",
);

const OutcomeStatus = z.enum(["accepted", "duplicate", "rejected"]);
/** Producers use the closed server error registry; the wire carries its string code. */
const OutcomeError = z.object({ code: z.string(), detail: z.string() }).nullable();

export const TicketResultSchema = z.object({
  clientRef: UuidSchema,
  status: OutcomeStatus,
  documentId: UuidSchema.nullable(),
  number: z.string().nullable(),
  error: OutcomeError,
});
export const MessageResultSchema = z.object({
  ref: z.string().min(1),
  status: OutcomeStatus,
  error: OutcomeError,
});
export const BatchResultSchema = z.object({
  batchId: UuidSchema,
  results: z.array(TicketResultSchema),
  shiftResults: z.array(MessageResultSchema),
  tillEventResults: z.array(MessageResultSchema),
  /** ⚠️ OD-10 — the server always sends it, empty when the batch carried no `cashEvents`. A reader defaults it
   *  to `[]`, so a till parsing an answer from a server that predates the fourth array still reads three. */
  cashEventResults: z.array(MessageResultSchema).default([]),
  /** The server's current cursor, so the till knows how stale it is — the SAME opaque form `next_cursor`
   *  carries, encoded by the SAME codec (`encodeSyncCursor`, T1). */
  catalogueCursor: z.string().regex(/^[A-Za-z0-9_-]+$/),
});

/** §4.10.4's 202 body, with no `statusUrl` — Task 0 amendment 12. */
export const BatchQueuedSchema = z.object({
  batchId: UuidSchema,
  jobId: z.string().min(1),
  status: z.literal("queued"),
});
