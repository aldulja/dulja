/**
 * The POS sync wire contract (contracts §4.10.1). `apps/api` and `apps/pos` compile against THIS file and
 * nothing else, which is what makes spec:1318's "design the sync API as though an external client would use
 * it" checkable rather than aspirational. Every money value is `{ amount, currency }` and every quantity a
 * fixed-scale string — no `number` ever holds a monetary value (spec:2041, the `no-number-money` lint).
 */
import type { ErrCode } from "@dulja/contracts";

/** spec:1328's mirrors plus the two policy streams (§4.10.1). */
export type Stream =
  | "item"
  | "price_list"
  | "price_list_line"
  | "promotion"
  | "customer"
  | "tax_code"
  | "cashier"
  | "branch_pos_policy";

/** Pull order. `price_list` precedes `price_list_line` and `item` precedes everything that references it, so a
 *  till applying a page in order never holds a line whose parent has not arrived. */
export const CATALOGUE_STREAMS: readonly Stream[] = [
  "item",
  "price_list",
  "price_list_line",
  "promotion",
  "customer",
  "tax_code",
  "cashier",
  "branch_pos_policy",
];

/** Encoded on the wire as a base64url string of the decimal revision — opaque to the till (§4.10.1). */
export interface Cursor {
  readonly revision: bigint;
}

export interface Change<T = unknown> {
  stream: Stream;
  op: "upsert" | "delete";
  id: string;
  revision: bigint;
  /** `null` for a delete (tombstone) — spec:1300 "Deletions travel as tombstones, never as silent absence". */
  row: T | null;
}

/** spec:1297 — the names are the spec's, snake_case on the wire. */
export interface CataloguePage {
  changes: Change[];
  next_cursor: string;
  has_more: boolean;
}

export interface MoneyJson {
  amount: string;
  currency: string;
}

export interface TicketLine {
  lineNo: number;
  itemId: string;
  lotId: string | null;
  /** Quantity at scale 6. NEGATIVE on a return line — direction is carried by the sign of the QUANTITY on the
   *  wire and by `PlannedMovement.effect` / `PlannedLedgerLine.side` after evaluation (§4.4.2 A9). */
  quantity: string;
  unitId: string;
  unitPrice: MoneyJson;
  discount: MoneyJson;
  taxCodeId: string | null;
  taxAmount: MoneyJson;
  /** The tax-INCLUSIVE line total. `POS_TICKET` declares `tax.inclusive: true` (§4.6.5), so the server's
   *  `computeDocumentTax` extracts `taxAmount` from this figure and stores `amount = total − taxAmount`. */
  total: MoneyJson;
  /** The promotion's share of `discount`, signed like it (negative on a return line), and the promotion that
   *  earned it — evidence the server recomputes before it leaves that share out of the cashier's discount
   *  authority and branch limits (ADR 0059's PR 12 review amendment). Absent or null: the whole `discount` is
   *  the cashier's. Never on a referenced return, which restores the original sale's discount as it was. */
  promotion?: { promotionId: string; discount: MoneyJson } | null;
}

export interface TicketTender {
  tenderNo: number;
  method: "cash" | "card" | "transfer" | "store_credit";
  amount: MoneyJson;
  reference: string | null;
}

/**
 * `code` is the ONE override code the server can store: `document_event.override_code` admits exactly the three
 * values of `OverrideCode` (§4.3.1, §4.5.2), and `assert_override_authorised` verifies the supervisor holds
 * *that* code — so sending `pos.ticket.discount` here would make the guard check a cashier-level selling code
 * and defeat acceptance test 37. What the override was *for* travels in `subject` and is written to
 * `document_event.reason` as `"<subject>: <reason>"`.
 */
export interface TicketEvent {
  kind: "override";
  code: "pos.ticket.override";
  subject: "discount" | "void" | "blind_return" | "price_override";
  supervisorPrincipalId: string;
  reason: string;
}

/** A customer quick-created at the till (§2.7, applied under `pos.customer.create`). `id` is a uuidv7 minted
 *  offline and is also the ticket's `customerId`, so a re-sent ticket creates no second party. */
export interface NewCustomer {
  id: string;
  code: string;
  nameEn: string;
  phone: string | null;
}

export interface Ticket {
  cashRounding?: { lineNo: number; adjustment: MoneyJson } | null;
  /** uuidv7 minted at the till = `document.client_ref` (spec:1302, SAH-051). */
  clientRef: string;
  shiftId: string;
  cashierPrincipalId: string;
  customerId: string | null;
  newCustomer?: NewCustomer | null;
  kind: "sale" | "return";
  /** The original ticket's `clientRef` on a return; `null` means a BLIND return (`pos.ticket.return_blind`). */
  returnsClientRef: string | null;
  currency: string;
  soldAt: string;
  lines: TicketLine[];
  tenders: TicketTender[];
  events: TicketEvent[];
  attendance: { kind: "clock_in" | "clock_out"; principalId: string; at: string }[];
  catalogueRevision: bigint;
}

/**
 * One message per shift transition, not one per shift: the till sends `open` when the drawer is counted in and
 * `close` when it is counted out, and the two may cross a reconnect hours apart. `shiftId` is the uuidv7 minted
 * at the till and is `app.shift.id` (§4.6.5) — the same client-id convention as `Ticket.clientRef`. Field names
 * follow §3.3: the cashier is **attribution** data, so `cashierPrincipalId`, never `openedBy`.
 */
export interface ShiftOpenClose {
  shiftId: string;
  kind: "open" | "close";
  terminalId: string;
  cashierPrincipalId: string;
  at: string;
  currency: string;
  openingFloat: MoneyJson | null; // required on `open`, null on `close`
  countedCash: MoneyJson | null; // required on `close`, null on `open`
}

/** The till never computes `expectedCash` or `over_short`: the server derives both from the shift's posted
 *  tickets, so a tampered or clock-skewed till cannot move the difference (§4.6.5). */
export interface TillEventMsg {
  clientRef: string;
  shiftId: string;
  kind: "no_sale" | "drawer_open" | "void";
  ticketClientRef: string | null;
  cashierPrincipalId: string;
  supervisorPrincipalId: string | null;
  occurredAt: string;
  reason?: string | null;
}

/**
 * ⚠️ OD-10 (answered yes, 2026-11-04; ADR 0064). A movement of physical cash at the till that is not a sale
 * (spec:1354): a paid-out (cash leaves the company, e.g. to a supplier), a safe drop (drawer → safe) or a
 * banking (safe or drawer → bank). Acked by `clientRef`, like a `TillEventMsg`. The server posts one
 * `TILL_PAID_OUT` / `TILL_SAFE_DROP` / `TILL_BANKING` document per message.
 */
export interface TillCashMsg {
  /** uuidv7 minted at the till = the document's `client_ref`, and the ack key. */
  clientRef: string;
  shiftId: string;
  kind: "paid_out" | "safe_drop" | "banking";
  /** A positive magnitude in the shift's currency; the kind carries the direction. */
  amount: MoneyJson;
  cashierPrincipalId: string;
  /** A paid-out above the branch's `max_paid_out_amount` only; null otherwise. */
  supervisorPrincipalId: string | null;
  occurredAt: string;
  /** Required on a paid-out (the supplier receipt or voucher number); a bag number or deposit slip otherwise. */
  reference: string | null;
  /** `banking` only: `true` = out of the safe (1130 Cash in transit), `false` = straight from the drawer (1110).
   *  Always `false` for the other two kinds. */
  fromSafe: boolean;
}

export interface TicketBatch {
  terminalId: string;
  batchId: string;
  tickets: Ticket[];
  shifts: ShiftOpenClose[];
  tillEvents: TillEventMsg[];
  /** ⚠️ OD-10 — additive and versionless: a batch without it is a three-array batch, applied unchanged. */
  cashEvents?: TillCashMsg[];
}

export interface TicketResult {
  clientRef: string;
  status: "accepted" | "duplicate" | "rejected";
  documentId: string | null;
  number: string | null;
  error: { code: ErrCode; detail: string } | null;
}

/** Acknowledges a shift or till event by the id the till keyed its outbox row on — `ShiftOpenClose` by
 *  `"<shiftId>:<kind>"`, `TillEventMsg` by `clientRef`. Without these two arrays `drainOutbox` could only ack
 *  `outbox.kind = 'ticket'` rows and the other two kinds would re-send for ever (spec:1337). */
export interface MessageResult {
  ref: string;
  status: "accepted" | "duplicate" | "rejected";
  error: { code: ErrCode; detail: string } | null;
}

export interface BatchResult {
  batchId: string;
  results: TicketResult[];
  shiftResults: MessageResult[];
  tillEventResults: MessageResult[];
  /** ⚠️ OD-10 — one per `cashEvents` message, keyed by its `clientRef`. The server always sends it; optional
   *  here so a till tolerates a server that predates the fourth array. */
  cashEventResults?: MessageResult[];
  /** The server's current cursor, so the till knows how stale it is. */
  catalogueCursor: string;
}

/** The 202 body §4.10.4 returns for an over-size batch. No `statusUrl`: the till re-sends, and dedup makes the
 *  re-send exact (Task 0 amendment 12). */
export interface BatchQueued {
  batchId: string;
  jobId: string;
  status: "queued";
}

/** Tickets in one batch beyond this count are applied by the `pos.sync.apply` job (§4.10.4). */
export const SYNC_BATCH_SYNC_LIMIT = 200;

/** The shift-message outbox ref: one row per transition, so an `open` and a `close` of one shift ack apart. */
export function shiftRef(m: Pick<ShiftOpenClose, "shiftId" | "kind">): string {
  return `${m.shiftId}:${m.kind}`;
}
