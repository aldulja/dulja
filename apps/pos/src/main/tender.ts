// `round` is 0D's `round(value: Decimal, scale: number, mode: RoundingMode): Decimal` (§4.2.1) — the ONE
// place the `RoundingMode` → `Decimal.Rounding` mapping lives. `roundToIncrement` composes it; it does not
// re-implement it, and no `Decimal.ROUND_*` literal appears in `apps/pos`.
import { Money, currency, roundToIncrement } from "@dulja/domain";
export { roundToIncrement } from "@dulja/domain";
import { serializeSyncBody } from "@dulja/sync";
import { PERMISSION } from "@dulja/contracts";
import { requireCode } from "./authority";
import type { Ticket, TicketTender } from "@dulja/sync";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import { TillError } from "./errors";
import type { TillCashier } from "./authority";
import { taxItemLine } from "./pricing";
import { carriedPromotion, type DraftLine, type TicketDraft } from "./ticket";
import { moneyToText, quantityToText, textToMoney, textToQuantity } from "./money";
import { settledOnAccount } from "./returns";

export interface TenderInput {
  method: "cash" | "card" | "transfer" | "store_credit";
  amount: Money;
  reference?: string | null;
}

export interface TenderResult {
  clientRef: string;
  payable: Money;
  change: Money;
  rounding: Money;
  tenders: readonly TenderInput[];
}

/**
 * Rewrite a draft so its gross equals `round(gross, increment)` (ADR 0059).
 *
 * The difference lands on the **highest-amount item line's `discount`** — one line, deterministically chosen,
 * so two tills rounding the same basket produce the same ticket. Positive when rounding down (a discount),
 * negative when rounding up (a surcharge on the discount column). Tax is then **re-extracted from the rounded
 * line total**, which is what makes `base + tax === total` hold on the rewritten line and what makes 6A's
 * step-(g) recomputation agree — it recomputes tax from the stored line, so a line whose stored tax came from
 * the *unrounded* figure would be rejected with `ERR_TAX_*` on every rounded cash ticket in the shop.
 *
 * `Σ`(rewritten line totals) equals the payable exactly, because the chosen line's total is set to
 * `old total − difference` and nothing else moves.
 */
export function applyCashRounding(
  sqliteDb: PosDatabase,
  draft: TicketDraft,
  increment: string,
  at?: Date,
): { draft: TicketDraft; rounding: Money } {
  const cur = draft.currency;
  const payable = roundToIncrement(draft.total, increment);
  const rounding = draft.total.subtract(payable); // positive = rounded down = a discount
  if (rounding.isZero()) return { draft, rounding: Money.zero(cur) };

  // The highest-amount line by |total|, ties broken by the lowest lineNo so the choice is total.
  let target = 0;
  for (let i = 1; i < draft.lines.length; i += 1) {
    if (
      draft.lines[i]!.total.abs().compare(draft.lines[target]!.total.abs()) > 0 ||
      (draft.lines[i]!.total.abs().equals(draft.lines[target]!.total.abs()) &&
        draft.lines[i]!.lineNo < draft.lines[target]!.lineNo)
    )
      target = i;
  }

  const lines: DraftLine[] = draft.lines.map((l, i) => {
    if (i !== target) return l;
    const newTotal = l.total.subtract(rounding);
    const taxed = taxItemLine(sqliteDb, {
      gross: newTotal,
      itemId: l.itemId,
      taxCodeId: l.taxCodeId,
      ...(at === undefined ? {} : { at }),
    });
    return { ...l, discount: l.discount.add(rounding), taxAmount: taxed.tax, total: taxed.total };
  });

  let netTotal = Money.zero(cur);
  let taxTotal = Money.zero(cur);
  let total = Money.zero(cur);
  for (const l of lines) {
    netTotal = netTotal.add(l.total.subtract(l.taxAmount));
    taxTotal = taxTotal.add(l.taxAmount);
    total = total.add(l.total);
  }
  return { draft: { ...draft, lines, netTotal, taxTotal, total }, rounding };
}

interface TicketDbRow {
  id: string;
  shift_id: string;
  cashier_principal_id: string;
  customer_id: string | null;
  kind: "sale" | "return";
  returns_client_ref: string | null;
  status: string;
  currency: string;
  net_total: string;
  tax_total: string;
  total: string;
  catalogue_revision: string;
  created_at: string;
  events_json: string;
}

/**
 * Complete an open ticket.
 *
 * **Why this is a second call and not part of `sell`.** §4.10.6 names `sell` and `tender` as two members of
 * `window.dulja.pos`, and the till's own workflow is two steps: the cashier scans, then the customer chooses
 * how to pay — and the payable amount depends on *what* they choose, because an all-cash ticket rounds and a
 * card ticket does not (ADR 0059). A single call would have to know the tenders before the lines were priced.
 *
 * **The outbox row is replaced, never added to.** `store.enqueue` is idempotent on `(kind, ref)` and keeps the
 * FIRST payload, so this function updates the payload column directly, inside the same transaction that
 * writes the tenders and flips the status. One ticket, one outbox row, from `sell` to acknowledgement — which
 * is what makes `select count(*) from outbox where acked_at is null` a meaningful number.
 */
export function tender(
  sqliteDb: PosDatabase,
  store: SqliteSyncStore,
  input: { clientRef: string; cashier: TillCashier; tenders: readonly TenderInput[]; at?: Date },
): TenderResult {
  if (input.tenders.length === 0) {
    throw new TillError("ERR_VALIDATION_FAILED", "a ticket needs at least one tender");
  }
  const row = sqliteDb.raw
    .prepare<[string], TicketDbRow>(
      `select id, shift_id, cashier_principal_id, customer_id, kind, returns_client_ref, status, currency,
            net_total, tax_total, total, catalogue_revision, created_at, events_json
       from ticket where id = ?`,
    )
    .get(input.clientRef);
  if (row === undefined)
    throw new TillError("ERR_NOT_FOUND", `no ticket ${input.clientRef} on this till`);
  if (row.status !== "open") {
    throw new TillError(
      "ERR_VALIDATION_FAILED",
      `ticket ${input.clientRef} is ${row.status}, not open`,
    );
  }
  if (row.cashier_principal_id !== input.cashier.principalId)
    throw new TillError("ERR_RBAC_FORBIDDEN", "only the ticket cashier can complete payment");
  requireCode(
    input.cashier,
    row.kind === "return" ? PERMISSION["pos.ticket.return"] : PERMISSION["pos.ticket.sell"],
  );
  // `returnTicket` completes such a return itself; an open one (made before that rule) is cancelled and
  // taken again rather than paid out of a drawer that never received the sale's money.
  if (
    row.kind === "return" &&
    row.returns_client_ref !== null &&
    settledOnAccount(sqliteDb, row.returns_client_ref)
  )
    throw new TillError(
      "ERR_VALIDATION_FAILED",
      "an account sale is refunded to the customer's account; no tender is taken",
    );
  const cur = currency(row.currency);
  for (const t of input.tenders) {
    if (
      (row.kind === "sale" && t.amount.isNegative()) ||
      (row.kind === "return" && !t.amount.isNegative() && !t.amount.isZero())
    )
      throw new TillError("ERR_VALIDATION_FAILED", "tender direction disagrees with ticket kind");
    if (currency(t.amount.toJSON().currency) !== cur) {
      throw new TillError(
        "ERR_MONEY_CURRENCY_MISMATCH",
        `the ticket is in ${cur} and a ${t.method} tender is in ${t.amount.toJSON().currency}`,
      );
    }
  }

  // The draft as it stands in the local tables, so `tender` never re-prices and never re-reads a catalogue
  // that may have advanced between `sell` and payment.
  const stored = sqliteDb.raw
    .prepare<
      [string],
      {
        line_no: number;
        item_id: string;
        lot_id: string | null;
        quantity: string;
        unit_id: string;
        unit_price: string;
        discount: string;
        tax_code_id: string | null;
        tax_amount: string;
        total: string;
      }
    >(`select line_no, item_id, lot_id, quantity, unit_id, unit_price, discount, tax_code_id, tax_amount, total
        from ticket_line where ticket_id = ? order by line_no`)
    .all(input.clientRef);
  const draft: TicketDraft = {
    clientRef: row.id,
    kind: row.kind,
    currency: cur,
    lines: stored.map((l) => ({
      lineNo: l.line_no,
      itemId: l.item_id,
      lotId: l.lot_id,
      unitId: l.unit_id,
      quantity: textToQuantity(l.quantity),
      unitPrice: textToMoney(l.unit_price, cur),
      discount: textToMoney(l.discount, cur),
      taxCodeId: l.tax_code_id,
      taxAmount: textToMoney(l.tax_amount, cur),
      total: textToMoney(l.total, cur),
    })),
    netTotal: textToMoney(row.net_total, cur),
    taxTotal: textToMoney(row.tax_total, cur),
    total: textToMoney(row.total, cur),
    catalogueRevision: BigInt(row.catalogue_revision),
  };

  const allCash = input.tenders.every((t) => t.method === "cash");
  const policy = sqliteDb.raw
    .prepare<[string], { rounding_increment: string }>(
      "select rounding_increment from catalogue_branch_pos_policy where branch_id = ?",
    )
    .get(input.cashier.branchId);
  const increment = policy?.rounding_increment ?? input.cashier.limits.roundingIncrement;
  const at = new Date(row.created_at);
  const canRound = allCash && !(row.kind === "return" && row.returns_client_ref !== null);
  const { draft: finalDraft, rounding } = canRound
    ? applyCashRounding(sqliteDb, draft, increment, at)
    : { draft, rounding: Money.zero(cur) };
  const prior = JSON.parse(
    sqliteDb.raw
      .prepare<[string], { payload: string }>(
        "select payload from outbox where kind='ticket' and ref=?",
      )
      .get(row.id)?.payload ?? "null",
  ) as Ticket | null;
  if (!prior) throw new TillError("ERR_TILL_STORE_CORRUPT", "ticket has no durable outbox payload");
  const payable = finalDraft.total;

  const tendered = input.tenders.reduce((s, t) => s.add(t.amount), Money.zero(cur));
  const change = tendered.subtract(payable);
  if (row.kind === "sale") {
    if (change.isNegative()) {
      throw new TillError(
        "ERR_VALIDATION_FAILED",
        `tendered ${tendered.toString()} is short of the payable ${payable.toString()}`,
      );
    }
    if (!change.isZero() && !allCash) {
      throw new TillError(
        "ERR_VALIDATION_FAILED",
        `change of ${change.toString()} cannot be given against a non-cash tender; take exactly ${payable.toString()}`,
      );
    }
  } else if (!tendered.equals(payable)) {
    // A return pays money OUT. Over- or under-refunding is not "change"; it is the wrong refund.
    throw new TillError(
      "ERR_VALIDATION_FAILED",
      `a return must be tendered exactly: ${tendered.toString()} was given against ${payable.toString()}`,
    );
  }
  const changeGiven = row.kind === "sale" ? change : Money.zero(cur);

  // The wire tender is what the ledger debits, so it is what the CUSTOMER's money settled — the cash a
  // customer handed over minus the change they took back. Sending the handed-over figure would debit
  // `1110` by 5.0000 for a 3.3500 ticket and `ERR_LEDGER_UNBALANCED` would fire at post.
  //
  // The payable is applied across the rows IN ORDER, each settling at most what it handed over, so the change
  // comes off the rows that overpaid and no row is ever settled below zero: [cash 5.00, cash 1.00] against
  // 3.35 settles [3.35, 0.00], not [5.00, −1.65] — a negative tender on a sale that `applyBatch` refuses
  // ("sign disagrees with ticket kind") after the drawer has already given the change. A sale with change is
  // all cash (refused above otherwise), so moving the change between rows moves nothing between methods. A
  // return and an exact sale tender exactly, so every row settles what it was given. A row that settles
  // nothing is no tender and is left out, the rest numbered from 1; the handed-over rows stay on the receipt
  // (`received_tenders:`). Only a ticket whose payable is zero keeps its first row, at zero, so it is still a
  // paid ticket on the wire and never mistaken for an account sale.
  const wireTenders: TicketTender[] = [];
  let remaining = payable;
  input.tenders.forEach((t, i) => {
    const settled = row.kind === "sale" && t.amount.compare(remaining) > 0 ? remaining : t.amount;
    remaining = remaining.subtract(settled);
    if (settled.isZero() && !(payable.isZero() && i === 0)) return;
    wireTenders.push({
      tenderNo: wireTenders.length + 1,
      method: t.method,
      amount: settled.toJSON(),
      reference: t.reference ?? null,
    });
  });

  const wire: Ticket = {
    clientRef: row.id,
    shiftId: row.shift_id,
    cashierPrincipalId: row.cashier_principal_id,
    customerId: row.customer_id,
    newCustomer: prior.newCustomer ?? null,
    kind: row.kind,
    returnsClientRef: row.returns_client_ref,
    currency: cur,
    soldAt: row.created_at,
    lines: finalDraft.lines.map((l) => ({
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
      // The promotion evidence `sell` put on the payload this one replaces (ADR 0059's PR 12 review
      // amendment); rounding changes only the discount, never the promotion's share of it.
      ...carriedPromotion(prior, l.lineNo),
    })),
    tenders: wireTenders,
    events: prior.events,
    attendance: prior.attendance,
    catalogueRevision: BigInt(row.catalogue_revision),
    cashRounding: !rounding.isZero()
      ? {
          lineNo: finalDraft.lines.find(
            (line) =>
              !line.total.equals(
                draft.lines.find((original) => original.lineNo === line.lineNo)!.total,
              ),
          )!.lineNo,
          adjustment: rounding.negate().toJSON(),
        }
      : null,
  };

  return sqliteDb.tx(() => {
    const updateLine = sqliteDb.raw.prepare(
      "update ticket_line set discount = ?, tax_amount = ?, total = ? where ticket_id = ? and line_no = ?",
    );
    for (const l of finalDraft.lines) {
      updateLine.run(
        moneyToText(l.discount),
        moneyToText(l.taxAmount),
        moneyToText(l.total),
        row.id,
        l.lineNo,
      );
    }
    sqliteDb.raw
      .prepare(
        "update ticket set status = 'completed', net_total = ?, tax_total = ?, total = ? where id = ?",
      )
      .run(
        moneyToText(finalDraft.netTotal),
        moneyToText(finalDraft.taxTotal),
        moneyToText(payable),
        row.id,
      );
    const insertTender = sqliteDb.raw.prepare(
      "insert into ticket_tender (ticket_id, tender_no, method, amount, reference) values (?, ?, ?, ?, ?)",
    );
    for (const t of wireTenders)
      insertTender.run(row.id, t.tenderNo, t.method, t.amount.amount, t.reference ?? null);
    // The payload, replaced in place: one outbox row per ticket, still unacked.
    sqliteDb.raw
      .prepare("update outbox set payload = ? where kind = 'ticket' and ref = ?")
      .run(serializeSyncBody(wire), row.id);
    sqliteDb.raw
      .prepare(
        "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
      )
      .run(`change:${row.id}`, moneyToText(changeGiven));
    sqliteDb.raw
      .prepare(
        "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
      )
      .run(`rounding:${row.id}`, moneyToText(rounding.negate()));
    sqliteDb.raw
      .prepare(
        "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
      )
      .run(
        `received_tenders:${row.id}`,
        JSON.stringify(
          input.tenders.map((t) => ({
            method: t.method,
            amount: moneyToText(t.amount),
            reference: t.reference ?? null,
          })),
        ),
      );
    return {
      clientRef: row.id,
      payable,
      change: changeGiven,
      rounding: rounding.negate(),
      tenders: input.tenders,
    };
  });
}
