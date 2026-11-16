import { z } from "zod";
import {
  DateSchema,
  ListEnvelope,
  ListQuery,
  QuantitySchema,
  TimestampSchema,
  UuidSchema,
} from "../common";

/** ACCEPTED money: document currency, never negative — the side carries the sign (1A). `document_line.debit`
 *  and `.credit` carry `check (>= 0)`, so a negative in a body would reach the database as SQLSTATE 23514,
 *  which `fromDatabaseError` maps to ERR_INTERNAL 500 rather than a 400. Zod refuses it first. */
const Amount = z.string().regex(/^\d+\.\d{4}$/);
/** RETURNED money (2A): a reversal's `amount`, `discount`, `taxAmount`, `totalInclTax` are negated on its
 *  lines, so the response schema must admit a sign or every GET of a reversal fails wire validation. */
const SignedAmount = z.string().regex(/^-?\d+\.\d{4}$/);

export const DocumentStatusSchema = z.enum([
  "draft",
  "submitted",
  "approved",
  "issued",
  "void",
  "posted",
  "reversed",
]);

export const DocumentTypeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
export const DocumentLineKindSchema = z.enum([
  "account",
  "item",
  "tax",
  "text",
  "tender",
  "payroll",
]);

/** The line as RETURNED. Reading a column is not writing one: `taxCodeId` and `cost` appear here and nowhere
 *  in `DocumentLineInput` — the first until 5A's 0055 adds its foreign key, the second never, because it is
 *  the costing engine's column (3B). `itemId` was in the same position until 3A's 0032 added
 *  `(tenant_id, item_id) → app.item`, and it is accepted from that PR onward. */
export const DocumentLineSchema = z.object({
  id: UuidSchema,
  lineNo: z.number().int().positive(),
  description: z.string().nullable(),
  accountId: UuidSchema.nullable(),
  kind: DocumentLineKindSchema,
  debit: Amount,
  credit: Amount, // both columns carry check (>= 0): never signed
  itemId: UuidSchema.nullable(), // accepted since 3A's 0032 added the foreign key
  quantity: QuantitySchema.nullable(),
  unitPrice: SignedAmount.nullable(),
  discount: SignedAmount,
  amount: SignedAmount,
  taxCodeId: UuidSchema.nullable(), // read-only until 5A's 0055 accepts it
  taxAmount: SignedAmount,
  totalInclTax: SignedAmount,
  cost: SignedAmount.nullable(), // the costing engine's column (3B); never accepted
  // 3A / migration 0032. `unitQuantity` uses `QuantitySchema`, which already admits a leading sign, so a
  // reversal's negated pair validates on the wire exactly as its negated `quantity` does.
  warehouseId: UuidSchema.nullable(),
  lotId: UuidSchema.nullable(),
  unitId: UuidSchema.nullable(),
  unitQuantity: QuantitySchema.nullable(),
  // 3D / migration 0040. Nullable, because every other type's lines have neither: only a STOCK_COUNT or
  // a TRANSFER_RECEIPT line carries them, and on those lines `quantity` is the signed variance.
  countedQuantity: QuantitySchema.nullable(),
  expectedQuantity: QuantitySchema.nullable(),
  dimensions: z.record(z.string(), z.string()),
  customFields: z.record(z.string(), z.unknown()),
});

export const DocumentSchema = z.object({
  id: UuidSchema,
  documentTypeCode: DocumentTypeCodeSchema,
  status: DocumentStatusSchema,
  series: z.string(),
  number: z.string().nullable(),
  fiscalPeriodId: UuidSchema.nullable(),
  effectiveDate: DateSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  exchangeRate: z.string(),
  rateSource: z.string().nullable(),
  branchId: UuidSchema,
  taxInclusive: z.boolean(),
  /** 2A — the party the document settles against (app.party, contracts §4.5.7); null for a JOURNAL. */
  partyId: UuidSchema.nullable(),
  clientRef: UuidSchema.nullable(),
  reversesDocumentId: UuidSchema.nullable(),
  postedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  // 4A / 0045. The pinned term and the DERIVED due date. `dueDate` has no column (§4.3.4); the handler reads
  // it through app.payment_due_date, so the wire never computes a date. A null term is due on the day.
  paymentTermId: UuidSchema.nullable(),
  dueDate: DateSchema.nullable(),
  lines: z.array(DocumentLineSchema),
});

/** The line as ACCEPTED, replacing 1A's inline `LineInput` (2A, contracts §4.2.8). `taxCodeId` is still
 *  absent by design: migration 0019 added that column with no foreign key and 5A's 0055 adds the key.
 *  Accepting a uuid the database cannot yet check would leave rows that ALTER would refuse on live data,
 *  so each slice adds its field here in the PR that adds its key — which is what 3A's 0032 does for
 *  `itemId` and for the four inventory columns below it.
 *
 *  Both of 1A's guards are carried forward, and one is added:
 *   - every money field is `Amount` — non-negative, the side carries the sign;
 *   - a line is a debit or a credit, never both (`check (not (debit > 0 and credit > 0))`);
 *   - an `account` line must name an `accountId`. 1A made `accountId` unconditionally required and
 *     `readDocument`'s tombstone filter depends on that; an ITEM line legitimately has none, so the
 *     requirement becomes conditional on `kind` and the filter gains `kind = 'account'`. */
export const DocumentLineInput = z
  .object({
    lineNo: z.number().int().positive(),
    kind: DocumentLineKindSchema.default("account"),
    description: z.string().max(500).optional(),
    accountId: UuidSchema.optional(),
    debit: Amount.default("0.0000"),
    credit: Amount.default("0.0000"),
    quantity: QuantitySchema.optional(),
    unitPrice: Amount.optional(),
    discount: Amount.default("0.0000"),
    amount: Amount.default("0.0000"),
    dimensions: z.record(z.string(), UuidSchema).default({}),
    customFields: z.record(z.string(), z.unknown()).default({}),
    taxCodeId: UuidSchema.optional(),
    itemId: UuidSchema.optional(), // 3A: the field lands in the PR that adds the FK (§4.3.4)
    warehouseId: UuidSchema.optional(),
    lotId: UuidSchema.optional(), // omitted → applyMovements resolves the item's NONE sentinel
    unitId: UuidSchema.optional(),
    unitQuantity: QuantitySchema.optional(), // the entered quantity; `quantity` is the base one
    // counted_quantity / expected_quantity (3D, migration 0040) are DELIBERATELY NOT here, and `.strict()`
    // below is what makes their absence a control. They have one writer each: `snapshotCountSheet` freezes
    // expected_quantity from stock_on_hand and `recordCounts` / `draftTransferReceipt` write counted. A
    // client that could set expected_quantity through this generic writer could build a STOCK_COUNT whose
    // expected figure never came from the projection — equal to the count (hiding shrinkage) or far above
    // on-hand (creating stock at line.cost) — and the approver's review would never know. The Phase 3
    // review pass found the two fields accepted here and removed them; a body carrying either is a 400.
  })
  .strict()
  .refine((line) => /^0+\.0{4}$/.test(line.debit) || /^0+\.0{4}$/.test(line.credit), {
    message: "a line is a debit or a credit, never both",
  })
  .refine((line) => line.kind !== "account" || line.accountId !== undefined, {
    message: "an account line must name an accountId",
  })
  // 3A: the entered pair is meaningless half-given — a unit with no quantity converts nothing, and a
  // quantity with no unit is already `quantity`. Migration 0032's trigger reads both or neither.
  .refine((line) => (line.unitId === undefined) === (line.unitQuantity === undefined), {
    message: "unitId and unitQuantity are given together or not at all",
  });

export const CreateDocumentBody = z
  .object({
    /** 1A pinned this to the literal "JOURNAL"; 2A lifts the pin — the tenant's catalogue is the bound. */
    documentTypeCode: DocumentTypeCodeSchema,
    effectiveDate: DateSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    branchId: UuidSchema,
    taxInclusive: z.boolean().optional(),
    partyId: UuidSchema.optional(),
    clientRef: UuidSchema.optional(),
    lines: z.array(DocumentLineInput).min(1),
  })
  .strict();

export const ReplaceLinesBody = z.object({ lines: z.array(DocumentLineInput).min(1) }).strict();

/**
 * contracts §4.5.4. `posted` calls postDocument, `void` calls voidDocument, the rest transitionDocument.
 * A backward edge is a recalculation and needs a reason (spec:1188, 2081) — the trigger of migration 0022
 * refuses it either way with ERR_DOC_STATUS_ILLEGAL, but the caller deserves the field-level message.
 * **`reversed` is deliberately absent**: contracts §4.5.4 gives reversal its own route,
 * `POST …/documents/{documentId}/reverse { effectiveDate, reason }`, gated by `accounting.document.reverse`
 * — a code §3.6.2 assigns to 2B so that posting and reversing are separate authorities.
 */
export const TransitionBody = z
  .object({
    to: z.enum(["draft", "submitted", "approved", "issued", "posted", "void"]),
    reason: z.string().trim().min(1).max(2000).optional(),
    attributedTo: UuidSchema.optional(),
  })
  .refine((b) => b.to !== "draft" || (b.reason !== undefined && b.reason.length > 0), {
    path: ["reason"],
    message: "returning a document to draft is a recalculation and needs a reason (spec:2081)",
  })
  .refine((b) => b.to !== "void" || (b.reason !== undefined && b.reason.length > 0), {
    path: ["reason"],
    message: "a void records why the number will never post (spec:1745)",
  });

/**
 * The outcome of one transition. 1A's six members are unchanged — `apps/api/test/routes/accounting/
 * documents.test.ts` asserts `status`, `number` and `ledgerEntryIds` on this response and
 * `docs/ui/phase-1-api-surface.md` publishes all six to 1B's screens — and 2B ADDS the three that
 * contracts §4.3.1's `TransitionResult` names: `from`, `to` and the `eventId` of the row the AFTER trigger
 * wrote (§4.5.2). A client that reads only 1A's members keeps working; the component name is unchanged.
 *
 * `from` and `to` are the two `app.document_status` values the `document_event` row carries, so a caller can
 * reconcile the response against `GET …/{documentId}/events` without a second read. `series` is not nullable:
 * `app.document.series` is `not null`. `fiscalPeriodId` and `number` are, because a document before `issued`
 * has neither. `status` stays `z.string()` — 1A's own spelling — and always equals `to`.
 */
export const TransitionResultSchema = z.object({
  documentId: UuidSchema,
  from: DocumentStatusSchema,
  to: DocumentStatusSchema,
  eventId: UuidSchema,
  status: z.string(),
  number: z.string().nullable(),
  series: z.string(),
  fiscalPeriodId: UuidSchema.nullable(),
  ledgerEntryIds: z.array(UuidSchema),
});

/** contracts §4.5.4. `effectiveDate` is the reversing document's own date — D13 never back-dates into a
 *  closed period, so the caller states it and `postDocument` refuses a closed one (ERR_PERIOD_NOT_OPEN). */
export const ReverseDocumentBody = z.object({
  effectiveDate: DateSchema,
  reason: z.string().min(1).max(2000),
});

/** `number` is the reversing document's number, serialised as a string: it is a `bigint` in `reverseDocument`'s
 *  return (contracts §4.3.1) and JSON has no bigint. */
export const ReverseDocumentResultSchema = z.object({
  reversalDocumentId: UuidSchema,
  number: z.string().regex(/^\d+$/),
});

/**
 * contracts §4.5.3. The three codes are `OverrideCode`'s members (contracts §4.3.1) spelled as literals,
 * because none of them is in the permission catalogue at 2B and `PermissionCode` therefore cannot express
 * them. The route resolves authority from this value at request time; the data-layer guard is the control.
 */
export const OverrideBody = z.object({
  code: z.enum([
    "inventory.negative_stock.override",
    "accounting.credit_limit.override",
    "pos.ticket.override",
  ]),
  reason: z.string().min(1).max(2000),
  attributedTo: UuidSchema.optional(),
});

export const OverrideResultSchema = z.object({ eventId: UuidSchema });

/** A draft, and only a draft (spec:2049). `deleted` is a literal so a client cannot read a 200 as a no-op. */
export const DeleteDocumentResultSchema = z.object({
  documentId: UuidSchema,
  deleted: z.literal(true),
});

/** contracts §4.5.2's columns as the wire sees them; `DocumentEventRow` (2B) is the row this mirrors. */
export const DocumentEventSchema = z.object({
  id: UuidSchema,
  eventKind: z.enum(["transition", "override"]),
  fromStatus: DocumentStatusSchema,
  toStatus: DocumentStatusSchema,
  overrideCode: z.string().nullable(),
  actorId: UuidSchema,
  attributedTo: UuidSchema.nullable(),
  occurredAt: TimestampSchema,
  reason: z.string().nullable(),
});

/** No sibling `DocumentEventQuery`: the events route declares no query parameters (2B route decision 3). The
 *  envelope is still used because §4.2.8 admits no bare-array list response, and its `next_cursor` is always
 *  null — a document's timeline is bounded by its own transitions. */
export const DocumentEventList = ListEnvelope(DocumentEventSchema);

export const DocumentQuery = ListQuery.extend({
  status: DocumentStatusSchema.optional(),
  fiscalPeriodId: UuidSchema.optional(),
});
export const DocumentList = ListEnvelope(DocumentSchema.omit({ lines: true }));
