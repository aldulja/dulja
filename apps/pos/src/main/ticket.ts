import { randomBytes } from "node:crypto";
import { Money, Quantity, currency, type CurrencyCode, type RoundingMode } from "@dulja/domain";
import { PERMISSION } from "@dulja/contracts";
import type { NewCustomer, Ticket, TicketEvent, TicketLine } from "@dulja/sync";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import { TillError } from "./errors";
import { snapshotReceiptItems } from "./receipt-snapshot";
import {
  liftRefusals,
  pendingAttendance,
  requireCode,
  type TillCashier,
  type TillRefusal,
} from "./authority";
import { assertCatalogueFresh, resolvePrice, resolvePromotion, taxItemLine } from "./pricing";
import { moneyToText, quantityToText, revisionToText } from "./money";

const MODE: RoundingMode = "HALF_AWAY_FROM_ZERO"; // 6C's `MODE`; the two limit checks must agree exactly

/**
 * A `uuidv7` minted **at the till**, offline, at the moment of sale.
 *
 * spec:2037, verbatim: *"The POS generates a `uuidv7` at the till for each ticket … carried as
 * `document.client_ref`"*, and spec:1302 makes it the deduplication key. `crypto.randomUUID()` is a **v4**
 * and would lose the time ordering `document.client_ref`'s index and 6A's cursor both rely on; 0A's
 * `uuidv7(sql)` is a database round trip and there is no database here. The layout is RFC 9562 §5.7:
 * 48-bit big-endian milliseconds, version 7, variant 0b10, the rest random. `tests/regression/legacy-051.test.ts`
 * gains a `— 6B` block in Task 12 asserting this is the only id source in `apps/pos`.
 */
export function tillUuidv7(at: Date = new Date()): string {
  const bytes = randomBytes(16);
  if (!Number.isSafeInteger(at.getTime()) || at.getTime() < 0 || at.getTime() > 281474976710655)
    throw new RangeError("invalid UUID timestamp");
  const ms = BigInt(at.getTime());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 0b10
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface SellLine {
  itemId: string;
  lotId?: string | null;
  unitId?: string | null;
  quantity: Quantity;
  priceOverride?: Money | null;
  discount?: Money | null;
}

export interface SellInput {
  shiftId: string;
  cashier: TillCashier;
  kind?: "sale" | "return";
  customerId?: string | null;
  newCustomer?: NewCustomer | null;
  returnsClientRef?: string | null;
  lines: SellLine[];
  ticketDiscount?: Money | null;
  events?: TicketEvent[];
  at?: Date;
  clientRef?: string;
}

export interface DraftLine {
  lineNo: number;
  itemId: string;
  lotId: string | null;
  unitId: string;
  quantity: Quantity;
  unitPrice: Money;
  /** EVERY discount on the line, signed like `quantity`: the promotion's share below, the cashier's own (an
   *  entered line discount and this line's part of a ticket discount) and, once `tender` has rounded a cash
   *  ticket, the rounding adjustment. Totals, tax and the wire read this sum. */
  discount: Money;
  /** The promotion's share of `discount`, signed like it, and the promotion that earned it — the shop's
   *  decision, which neither `pos.ticket.discount` nor a branch limit applies to (6B Task 6). Absent or null:
   *  none, as on a referenced return, which restores its sale's discount as it was. */
  promotion?: { promotionId: string; discount: Money } | null;
  taxCodeId: string | null;
  taxAmount: Money;
  total: Money;
}

/** The cashier's own share of a line's discount — what `pos.ticket.discount` and the branch limits are about.
 *  Before `tender`, that is the discount less the promotion; `checkLimits` and `sell` call it then. */
export function manualDiscount(line: DraftLine): Money {
  return line.promotion == null ? line.discount : line.discount.subtract(line.promotion.discount);
}

/** The wire's promotion evidence for one line, signed like its discount (§4.10.1's `TicketLine.promotion`). A
 *  zero share is no evidence, and a referenced return carries none — the server refuses it there. */
function wirePromotion(line: DraftLine, referenced: boolean): Pick<TicketLine, "promotion"> {
  return line.promotion == null || line.promotion.discount.isZero() || referenced
    ? {}
    : {
        promotion: {
          promotionId: line.promotion.promotionId,
          discount: line.promotion.discount.toJSON(),
        },
      };
}

/** The promotion evidence `sell` put on a ticket's outbox payload, for `tender` to carry onto the completed
 *  payload it replaces that one with: one outbox row per ticket, and the evidence survives a queued retry. */
export function carriedPromotion(
  prior: Pick<Ticket, "lines"> | null,
  lineNo: number,
): Pick<TicketLine, "promotion"> {
  const evidence = prior?.lines.find((line) => line.lineNo === lineNo)?.promotion;
  return evidence == null ? {} : { promotion: evidence };
}

export interface TicketDraft {
  clientRef: string;
  kind: "sale" | "return";
  currency: CurrencyCode;
  lines: DraftLine[];
  netTotal: Money;
  taxTotal: Money;
  total: Money;
  catalogueRevision: bigint;
}

export interface SellResult {
  clientRef: string;
  draft: TicketDraft;
  outboxId: string;
}

/** The highest revision this till has applied — `Ticket.catalogueRevision`, which tells the server how stale
 *  the prices on the ticket are. It is read once per draft and never recomputed per line. */
function catalogueRevision(sqliteDb: PosDatabase): bigint {
  const row = sqliteDb.raw
    .prepare<[], { revision: string }>(
      "select revision from sync_cursor order by cast(revision as integer) desc limit 1",
    )
    .get();
  return row === undefined ? 0n : BigInt(row.revision);
}

/**
 * Prices, discounts, taxes and totals a ticket. **Writes nothing** — `sell` calls it before opening its
 * transaction, and `tender` (Task 7) calls it again on the same input to answer "what is payable?" without
 * committing anything. Two callers, one arithmetic.
 *
 * **A return negates exactly five values and no sixth** (§4.4.2 A9's 6A entry, and 6A's `buildTicket` comment
 * verbatim): `quantity`, `discount`, `taxAmount`, `total` and — in Task 7 — the tender `amount`. `unitPrice`
 * does not flip: a price is a price, and direction is carried by the quantity's sign and by the policy's
 * `side`, never by a magnitude. Negating three of the five produces a ticket whose tenders do not sum to its
 * lines, which `applyBatch` refuses for the wrong reason.
 */
export function draftTicket(sqliteDb: PosDatabase, input: SellInput): TicketDraft {
  assertCatalogueFresh(sqliteDb);
  if (input.lines.length === 0) {
    throw new TillError("ERR_VALIDATION_FAILED", "a ticket needs at least one line");
  }
  const kind = input.kind ?? "sale";
  const at = input.at ?? new Date();
  const sign = kind === "return" ? -1 : 1;

  // 1. Price every line at its own quantity, so quantity breaks and promotions see the real figure.
  const priced = input.lines.map((line, index) => {
    if (line.quantity.isZero())
      throw new TillError("ERR_VALIDATION_FAILED", "a line quantity must be non-zero");
    if (line.priceOverride?.isNegative() || line.discount?.isNegative())
      throw new TillError(
        "ERR_VALIDATION_FAILED",
        "prices and entered discounts must be non-negative",
      );
    const magnitude = line.quantity.isNegative() ? line.quantity.negate() : line.quantity;
    const quote = resolvePrice(sqliteDb, {
      itemId: line.itemId,
      unitId: line.unitId ?? null,
      quantity: magnitude,
      customerId: input.customerId ?? null,
      at,
    });
    if (quote.source === "no_price" && (line.priceOverride ?? null) === null) {
      throw new TillError(
        "ERR_VALIDATION_FAILED",
        `item ${line.itemId} has no price in this till's catalogue and no override was given`,
      );
    }
    const catalogueUnitPrice = quote.unitPrice;
    const unitPrice = line.priceOverride ?? catalogueUnitPrice;
    // The promotion's discount and the cashier's own discount ADD: a promotion is the shop's decision and a
    // line discount is the cashier's, and the branch limit below is checked against the cashier's alone.
    // A promotion discounts the price the line is actually sold at — the price on the wire, which is what the
    // server recomputes the evidence from — so an overridden price is promoted afresh.
    const promotion =
      (line.priceOverride ?? null) === null
        ? { promotionId: quote.promotionId, discount: quote.promotionDiscount }
        : resolvePromotion(sqliteDb, { itemId: line.itemId, unitPrice, quantity: magnitude, at });
    const cashierDiscount =
      line.discount ?? Money.zero(unitPrice.toJSON().currency as CurrencyCode);
    return {
      line,
      index,
      catalogueUnitPrice,
      unitPrice,
      promotion,
      cashierDiscount,
      magnitude,
      unitId: quote.unitId,
    };
  });

  const cur = currency(priced[0]!.unitPrice.toJSON().currency);
  for (const p of priced) {
    if (currency(p.unitPrice.toJSON().currency) !== cur) {
      throw new TillError(
        "ERR_MONEY_CURRENCY_MISMATCH",
        `line ${p.index + 1} is in ${p.unitPrice.toJSON().currency} and line 1 is in ${cur}`,
      );
    }
  }

  // 2. Spread the ticket discount across lines by line gross, with `allocate` so the parts sum to the whole.
  const grosses = priced.map((p) => p.unitPrice.multiply(p.magnitude.toString(), MODE));
  const ticketDiscount = input.ticketDiscount ?? Money.zero(cur);
  if (ticketDiscount.isNegative())
    throw new TillError("ERR_VALIDATION_FAILED", "entered ticket discount must be non-negative");
  const spread = ticketDiscount.isZero()
    ? grosses.map(() => Money.zero(cur))
    : ticketDiscount.allocate(
        grosses.map((g) => BigInt(g.abs().toDecimal().times("10000").toFixed(0))),
        MODE,
      );

  // 3. Tax each line from its own post-discount gross, then total.
  let netTotal = Money.zero(cur);
  let taxTotal = Money.zero(cur);
  let total = Money.zero(cur);
  const lines: DraftLine[] = priced.map((p, i) => {
    const discountMagnitude = p.cashierDiscount.add(p.promotion.discount).add(spread[i]!);
    const grossMagnitude = grosses[i]!.subtract(discountMagnitude);
    if (grossMagnitude.isNegative()) {
      throw new TillError(
        "ERR_VALIDATION_FAILED",
        `line ${i + 1}: the discounts total ${discountMagnitude.toString()} and exceed the line's ${grosses[i]!.toString()}`,
      );
    }
    const signedGross = sign === -1 ? grossMagnitude.negate() : grossMagnitude;
    const taxed = taxItemLine(sqliteDb, { gross: signedGross, itemId: p.line.itemId, at });
    netTotal = netTotal.add(taxed.base);
    taxTotal = taxTotal.add(taxed.tax);
    total = total.add(taxed.total);
    return {
      lineNo: i + 1,
      itemId: p.line.itemId,
      lotId: p.line.lotId ?? null,
      unitId: p.unitId,
      quantity: sign === -1 ? p.magnitude.negate() : p.magnitude,
      unitPrice: p.unitPrice,
      discount: sign === -1 ? discountMagnitude.negate() : discountMagnitude,
      promotion:
        p.promotion.promotionId === null || p.promotion.discount.isZero()
          ? null
          : {
              promotionId: p.promotion.promotionId,
              discount: sign === -1 ? p.promotion.discount.negate() : p.promotion.discount,
            },
      taxCodeId: taxed.taxCodeId,
      taxAmount: taxed.tax,
      total: taxed.total,
    };
  });

  return {
    clientRef: input.clientRef ?? tillUuidv7(at),
    kind,
    currency: cur,
    lines,
    netTotal,
    taxTotal,
    total,
    catalogueRevision: catalogueRevision(sqliteDb),
  };
}

/**
 * The till's pre-flight limit check: **6C's `verifyTicket` limit half, transcribed**.
 *
 * Every figure and every message below is 6C's, in 6C's operand order, so the till refuses exactly what the
 * server would refuse and says the same words. Task 12's pinned test builds one over-limit ticket, runs it
 * through this function and through `verifyTicket`, and asserts the `detail` strings are equal — because "the
 * refusal messages agree" is the only way a shop can act on a refusal, and a divergence here is invisible
 * until a customer is standing at the counter.
 *
 * Three deliberate differences, each with its reason:
 *  - **`price_override` is here and not in 6C's map.** 6C's Task 9 decision (c): `max_price_override_pct` is
 *    enforced at the till only, because checking it server-side needs a second pricing implementation and
 *    §4.10.1's `TicketLine` carries no catalogue price. `catalogueUnitPrices` is the caller's evidence.
 *  - **The authority half is not repeated.** `requiredCodesFor`'s job is done by `sell`'s `requireCode`
 *    calls, and an authority gap is never override-able (6C's step 2 returns before the limits).
 *  - **`.abs()` on both factors**, because a return's quantity, total and discount are negative and a limit
 *    is a magnitude. Nothing here reads a sign to decide a direction (§4.4.2).
 *
 * The discount it limits is the cashier's alone (`manualDiscount`): a promotion's share is the shop's decision
 * and is left out of both the line and the ticket figure, exactly as the server leaves out a promotion it has
 * verified (ADR 0059's PR 12 review amendment) — so the two still refuse the same ticket with the same words.
 * The gross stays the whole line's, on both sides.
 */
export function checkLimits(
  cashier: TillCashier,
  draft: TicketDraft,
  opts: { catalogueUnitPrices: readonly Money[]; blind: boolean; voided: boolean },
): TillRefusal[] {
  const limits = cashier.limits;
  const cur = draft.currency;
  const refusals: TillRefusal[] = [];

  let totalGross = Money.zero(cur);
  let totalDiscount = Money.zero(cur);
  for (const line of draft.lines) {
    const magnitude = line.quantity.isNegative() ? line.quantity.negate() : line.quantity;
    const g = line.unitPrice.abs().multiply(magnitude.toString(), MODE);
    const d = manualDiscount(line).abs();
    totalGross = totalGross.add(g);
    totalDiscount = totalDiscount.add(d);
    const allowed = g.multiply(limits.maxLineDiscountPct, MODE);
    if (d.compare(allowed) > 0) {
      refusals.push({
        kind: "line_discount",
        lineNo: line.lineNo,
        detail: `line ${line.lineNo} discount ${d.toString()} exceeds ${limits.maxLineDiscountPct} of ${g.toString()} (${allowed.toString()})`,
      });
    }
    const catalogue = opts.catalogueUnitPrices[line.lineNo - 1];
    if (catalogue !== undefined && !catalogue.isZero()) {
      const drift =
        catalogue.compare(line.unitPrice) >= 0
          ? catalogue.subtract(line.unitPrice)
          : line.unitPrice.subtract(catalogue);
      const permitted = catalogue.abs().multiply(limits.maxPriceOverridePct, MODE);
      if (drift.compare(permitted) > 0) {
        refusals.push({
          kind: "price_override",
          lineNo: line.lineNo,
          detail: `line ${line.lineNo} price ${line.unitPrice.toString()} has a deviation of ${drift.toString()} against catalogue price ${catalogue.toString()}, which exceeds ${limits.maxPriceOverridePct} (${permitted.toString()})`,
        });
      }
    }
  }

  const ticketAllowance = totalGross.multiply(limits.maxTicketDiscountPct, MODE);
  if (totalDiscount.compare(ticketAllowance) > 0) {
    refusals.push({
      kind: "ticket_discount",
      lineNo: null,
      detail: `ticket discount ${totalDiscount.toString()} exceeds ${limits.maxTicketDiscountPct} of ${totalGross.toString()} (${ticketAllowance.toString()})`,
    });
  }

  const absoluteTotal = draft.lines.reduce((sum, l) => sum.add(l.total.abs()), Money.zero(cur));

  if (opts.voided) {
    const cap = Money.of(limits.maxVoidAmount, cur);
    if (absoluteTotal.compare(cap) > 0) {
      refusals.push({
        kind: "void",
        lineNo: null,
        detail: `void of ${absoluteTotal.toString()} exceeds max_void_amount ${cap.toString()}`,
      });
    }
  }

  if (opts.blind) {
    if (!limits.blindReturnAllowed) {
      refusals.push({
        kind: "blind_return",
        lineNo: null,
        detail: `blind return: this branch does not allow one (blind_return_allowed = false)`,
      });
    } else {
      const cap = Money.of(limits.maxBlindReturnAmount, cur);
      if (absoluteTotal.compare(cap) > 0) {
        refusals.push({
          kind: "blind_return",
          lineNo: null,
          detail: `blind return of ${absoluteTotal.toString()} exceeds max_blind_return_amount ${cap.toString()}`,
        });
      }
    }
  }

  return refusals;
}

/** The wire `Ticket` (§4.10.1), from a draft. **`catalogueRevision` becomes a decimal STRING here**, because
 *  `SqliteSyncStore.enqueue` calls `JSON.stringify` and `JSON.stringify` throws on a bigint — and 6A's Zod
 *  schema types the field as `BigintString` for exactly that reason. This is the one conversion point. */
function toWireTicket(
  draft: TicketDraft,
  input: SellInput,
  attendance: Ticket["attendance"],
  at: Date,
): Ticket {
  const lines: TicketLine[] = draft.lines.map((l) => ({
    lineNo: l.lineNo,
    itemId: l.itemId,
    lotId: l.lotId,
    quantity: quantityToText(l.quantity),
    unitId: l.unitId,
    unitPrice: l.unitPrice.toJSON(),
    discount: l.discount.toJSON(),
    taxCodeId: l.taxCodeId,
    taxAmount: l.taxAmount.toJSON(),
    total: l.total.toJSON(),
    ...wirePromotion(l, (input.returnsClientRef ?? null) !== null),
  }));
  return {
    clientRef: draft.clientRef,
    shiftId: input.shiftId,
    cashierPrincipalId: input.cashier.principalId,
    customerId: input.customerId ?? null,
    newCustomer: input.newCustomer ?? null,
    kind: draft.kind,
    returnsClientRef: input.returnsClientRef ?? null,
    currency: draft.currency,
    soldAt: at.toISOString(),
    lines,
    tenders: [], // Task 7's `tender` replaces the outbox payload with the tendered one
    events: input.events ?? [],
    attendance,
    catalogueRevision: draft.catalogueRevision,
  };
}

/**
 * Sell. **One SQLite transaction, four writes, no network call anywhere on the path** (spec:1303, 1337).
 *
 * Order matters and is not arbitrary. Authority is checked first, because an unauthorised cashier must be
 * refused before a price is read. The draft is built next, outside the transaction, because pricing is
 * read-only and a long pricing pass inside a write transaction would block a concurrent pull. Limits are
 * checked on the draft and lifted by the override events, and `ERR_TILL_LIMIT_EXCEEDED` is thrown **before**
 * the transaction opens — so a refused ticket leaves no row at all, which is what the test asserts.
 *
 * Then the transaction: header, lines, outbox, attendance stamps. `ticket_tender` stays empty until Task 7's
 * `tender` completes the ticket — a ticket is `status = 'open'` between `sell` and `tender`, which is what the
 * `status` CHECK's three values are for.
 */
export function sell(sqliteDb: PosDatabase, store: SqliteSyncStore, given: SellInput): SellResult {
  const kind = given.kind ?? "sale";
  // ONE instant for the whole sale: the promotions are priced at it and `soldAt` carries it, so the server
  // checks a promotion's window at the very moment the till applied it — never a millisecond later.
  const at = given.at ?? new Date();
  const input: SellInput = { ...given, at };
  if (input.returnsClientRef != null)
    throw new TillError(
      "ERR_VALIDATION_FAILED",
      "referenced returns require the historical return path",
    );
  // Both spelled `PERMISSION[...]` and never as a bare string, uniformly across `apps/pos`: these two codes
  // are 6A's and are referenced from `packages/db` as well, so the lint is satisfied either way — but one
  // spelling in one app means a reader never has to ask which codes are "the ones with the lookup".
  requireCode(
    input.cashier,
    kind === "return" ? PERMISSION["pos.ticket.return"] : PERMISSION["pos.ticket.sell"],
  );
  if (
    input.lines.some((l) => (l.discount ?? null) !== null && !l.discount!.isZero()) ||
    ((input.ticketDiscount ?? null) !== null && !input.ticketDiscount!.isZero())
  ) {
    requireCode(input.cashier, PERMISSION["pos.ticket.discount"]);
  }
  if (kind === "return" && (input.returnsClientRef ?? null) === null) {
    requireCode(input.cashier, PERMISSION["pos.ticket.return_blind"]);
  }
  if ((input.newCustomer ?? null) !== null)
    requireCode(input.cashier, PERMISSION["pos.customer.create"]);

  const shift = sqliteDb.raw
    .prepare<
      [string],
      { cashier_principal_id: string; closed_at: string | null; currency: string }
    >("select cashier_principal_id, closed_at, currency from shift where id = ?")
    .get(input.shiftId);
  if (!shift || shift.closed_at !== null)
    throw new TillError("ERR_VALIDATION_FAILED", "selling requires an open local shift");
  if (shift.cashier_principal_id !== input.cashier.principalId)
    throw new TillError("ERR_RBAC_FORBIDDEN", "selling requires an owned shift");
  const draft = draftTicket(sqliteDb, input);
  if (draft.currency !== currency(shift.currency))
    throw new TillError("ERR_MONEY_CURRENCY_MISMATCH", "ticket currency differs from its shift");
  // The cashier's own share only: a promoted line needs no discount authority (6B Task 6, and the server's
  // `requiredCodesFor` reads the same share once it has verified the promotion).
  if (draft.lines.some((line) => !manualDiscount(line).isZero()))
    requireCode(input.cashier, PERMISSION["pos.ticket.discount"]);
  const catalogueUnitPrices = input.lines.map((line) => {
    const magnitude = line.quantity.isNegative() ? line.quantity.negate() : line.quantity;
    return resolvePrice(sqliteDb, {
      itemId: line.itemId,
      unitId: line.unitId ?? null,
      quantity: magnitude,
      customerId: input.customerId ?? null,
      at,
    }).unitPrice;
  });
  const events = input.events ?? [];
  for (const event of events) {
    if (
      event.code !== PERMISSION["pos.ticket.override"] ||
      !event.reason.trim() ||
      event.supervisorPrincipalId === input.cashier.principalId
    )
      throw new TillError(
        "ERR_RBAC_FORBIDDEN",
        "an override requires a different authorised supervisor and a reason",
      );
    const supervisor = sqliteDb.raw
      .prepare<[string], { branch_id: string; snapshot_json: string; revoked_at: string | null }>(
        "select branch_id, snapshot_json, revoked_at from catalogue_cashier where id = ?",
      )
      .get(event.supervisorPrincipalId);
    if (
      !supervisor ||
      supervisor.revoked_at !== null ||
      supervisor.branch_id !== input.cashier.branchId ||
      !(JSON.parse(supervisor.snapshot_json) as { codes?: string[] }).codes?.includes(
        PERMISSION["pos.ticket.override"],
      )
    )
      throw new TillError(
        "ERR_RBAC_FORBIDDEN",
        "override supervisor is not authorised at this branch",
      );
  }
  const subjects = events.filter((e) => e.kind === "override").map((e) => e.subject);
  const refusals = liftRefusals(
    checkLimits(input.cashier, draft, {
      catalogueUnitPrices,
      blind: kind === "return" && (input.returnsClientRef ?? null) === null,
      voided: subjects.includes("void"),
    }),
    subjects,
  );
  if (refusals.length > 0) {
    throw new TillError("ERR_TILL_LIMIT_EXCEEDED", refusals.map((r) => r.detail).join("; "));
  }

  return persistTicketDraft(sqliteDb, store, input, draft);
}

/** Main-only persistence shared by priced sales and validated historical returns. */
export function persistTicketDraft(
  sqliteDb: PosDatabase,
  store: SqliteSyncStore,
  input: SellInput,
  draft: TicketDraft,
): SellResult {
  const at = input.at ?? new Date();
  requireCode(
    input.cashier,
    draft.kind === "return" ? PERMISSION["pos.ticket.return"] : PERMISSION["pos.ticket.sell"],
  );
  const shift = sqliteDb.raw
    .prepare<
      [string],
      { cashier_principal_id: string; closed_at: string | null; currency: string }
    >("select cashier_principal_id, closed_at, currency from shift where id = ?")
    .get(input.shiftId);
  if (!shift || shift.closed_at !== null)
    throw new TillError("ERR_VALIDATION_FAILED", "selling requires an open local shift");
  if (shift.cashier_principal_id !== input.cashier.principalId)
    throw new TillError("ERR_RBAC_FORBIDDEN", "selling requires an owned shift");
  if (draft.currency !== currency(shift.currency))
    throw new TillError("ERR_MONEY_CURRENCY_MISMATCH", "ticket currency differs from its shift");
  return sqliteDb.tx(() => {
    const pending = pendingAttendance(sqliteDb);
    const pendingIds = sqliteDb.raw
      .prepare<[], { id: string }>(
        "select id from attendance where sent_at is null order by occurred_at, id",
      )
      .all()
      .map((row) => row.id);
    const wire = toWireTicket(draft, input, pending, at);
    sqliteDb.raw
      .prepare(
        `insert into ticket (id, shift_id, cashier_principal_id, customer_id, kind, returns_client_ref, status,
                           currency, net_total, tax_total, total, catalogue_revision, created_at, events_json)
       values (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.clientRef,
        input.shiftId,
        input.cashier.principalId,
        input.customerId ?? null,
        draft.kind,
        input.returnsClientRef ?? null,
        draft.currency,
        moneyToText(draft.netTotal),
        moneyToText(draft.taxTotal),
        moneyToText(draft.total),
        revisionToText(draft.catalogueRevision),
        at.toISOString(),
        JSON.stringify(input.events ?? []),
      );

    const insertLine = sqliteDb.raw.prepare(
      `insert into ticket_line (ticket_id, line_no, item_id, lot_id, quantity, unit_id, unit_price, discount,
                                tax_code_id, tax_amount, total)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of draft.lines) {
      insertLine.run(
        draft.clientRef,
        l.lineNo,
        l.itemId,
        l.lotId,
        quantityToText(l.quantity),
        l.unitId,
        moneyToText(l.unitPrice),
        moneyToText(l.discount),
        l.taxCodeId,
        moneyToText(l.taxAmount),
        moneyToText(l.total),
      );
    }

    snapshotReceiptItems(sqliteDb, draft, input.returnsClientRef ?? null);

    // The outbox row, in the SAME transaction. This line is the DoD's "zero lost tickets".
    const outboxId = store.enqueue("ticket", draft.clientRef, wire);

    // And the attendance stamps, so a clock-in rides on exactly one ticket and never on none or two.
    const stamp = sqliteDb.raw.prepare("update attendance set sent_at = ? where id = ?");
    for (const id of pendingIds) stamp.run(at.toISOString(), id);

    return { clientRef: draft.clientRef, draft, outboxId };
  });
}

/** Persist a signed till event and its outbox intent together. */
export function recordTillEvent(
  sqliteDb: PosDatabase,
  store: SqliteSyncStore,
  e: {
    shiftId: string;
    kind: "no_sale" | "drawer_open" | "void";
    cashier: TillCashier;
    ticketClientRef?: string | null;
    supervisorPrincipalId?: string | null;
    reason?: string | null;
    at?: Date;
  },
): string {
  if (e.kind === "void") requireCode(e.cashier, PERMISSION["pos.ticket.void"]);
  const at = e.at ?? new Date();
  const id = tillUuidv7(at);
  return sqliteDb.tx(() => {
    sqliteDb.raw
      .prepare(
        `insert into till_event (id, shift_id, kind, ticket_client_ref, cashier_principal_id,
                               supervisor_principal_id, occurred_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        e.shiftId,
        e.kind,
        e.ticketClientRef ?? null,
        e.cashier.principalId,
        e.supervisorPrincipalId ?? null,
        at.toISOString(),
      );
    store.enqueue("till_event", id, {
      clientRef: id,
      shiftId: e.shiftId,
      kind: e.kind,
      ticketClientRef: e.ticketClientRef ?? null,
      cashierPrincipalId: e.cashier.principalId,
      supervisorPrincipalId: e.supervisorPrincipalId ?? null,
      occurredAt: at.toISOString(),
      reason: e.reason ?? null,
    });
    return id;
  });
}
