import { Money, Quantity, currency, rational, type CurrencyCode } from "@dulja/domain";
import { PERMISSION } from "@dulja/contracts";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import { TillError } from "./errors";
import { requireCode, type TillCashier } from "./authority";
import {
  persistTicketDraft,
  sell,
  tillUuidv7,
  type SellInput,
  type SellResult,
  type DraftLine,
  type TicketDraft,
} from "./ticket";
import { textToMoney, textToQuantity } from "./money";

interface StoredLine {
  line_no: number;
  item_id: string;
  lot_id: string | null;
  unit_id: string;
  quantity: string;
  unit_price: string;
  discount: string;
  tax_code_id: string | null;
  tax_amount: string;
  total: string;
}
export type OriginalLine = DraftLine;
export interface OriginalTicket {
  clientRef: string;
  currency: CurrencyCode;
  soldAt: string;
  customerId: string | null;
  /** The sale was debited to the customer's account (`accountSale`: a customer and no tender), so a referenced
   *  return of it is credited back to that account and takes no tender (`settledOnAccount`). */
  settledOnAccount: boolean;
  catalogueRevision: bigint;
  lines: readonly OriginalLine[];
  returned: Readonly<Record<number, string>>;
}
/** What `returnTicket` made: the persisted draft, and whether it was completed on the customer's account. */
export interface ReturnResult extends SellResult {
  settledOnAccount: boolean;
}
/**
 * Whether a local sale was settled to the customer's account rather than paid. Each sale is settled ONE way —
 * `accountSale` writes no tender at all, and `tender` requires the tenders to cover the payable — so "a
 * customer and no `ticket_tender` row" is exactly an account sale. (`tender` keeps a zero row on a zero-payable
 * ticket so that a paid ticket never reads as one.)
 */
export function settledOnAccount(sqliteDb: PosDatabase, clientRef: string): boolean {
  return (
    sqliteDb.raw
      .prepare<[string], { on_account: number }>(
        `select (k.customer_id is not null
                 and not exists (select 1 from ticket_tender t where t.ticket_id = k.id)) as on_account
           from ticket k where k.id = ? and k.kind = 'sale'`,
      )
      .get(clientRef)?.on_account === 1
  );
}
const sameSource = (a: StoredLine, b: DraftLine) =>
  a.item_id === b.itemId && a.unit_id === b.unitId && a.lot_id === b.lotId;
function priorLines(sqliteDb: PosDatabase, clientRef: string): StoredLine[] {
  return sqliteDb.raw
    .prepare<[string], StoredLine>(
      `select l.* from ticket_line l join ticket k on k.id=l.ticket_id
     where k.kind='return' and k.returns_client_ref=? and k.status <> 'voided'`,
    )
    .all(clientRef);
}

/** Local completed originals only; missing references never fall through to blind refunds. */
export function findOriginal(sqliteDb: PosDatabase, clientRef: string): OriginalTicket | null {
  const row = sqliteDb.raw
    .prepare<
      [string],
      {
        id: string;
        currency: string;
        created_at: string;
        customer_id: string | null;
        catalogue_revision: string;
      }
    >(
      "select id, currency, created_at, customer_id, catalogue_revision from ticket where id=? and kind='sale' and status='completed'",
    )
    .get(clientRef);
  if (!row) return null;
  const cur = currency(row.currency);
  const lines = sqliteDb.raw
    .prepare<[string], StoredLine>("select * from ticket_line where ticket_id=? order by line_no")
    .all(clientRef)
    .map((l): OriginalLine => ({
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
    }));
  const prior = priorLines(sqliteDb, clientRef);
  const returned: Record<number, string> = {};
  for (const l of lines) {
    const reserved = prior
      .filter((p) => sameSource(p, l))
      .reduce((sum, p) => sum.add(textToQuantity(p.quantity).negate()), Quantity.zero());
    returned[l.lineNo] = reserved.toString();
  }
  return {
    clientRef: row.id,
    currency: cur,
    soldAt: row.created_at,
    customerId: row.customer_id,
    settledOnAccount: settledOnAccount(sqliteDb, row.id),
    catalogueRevision: BigInt(row.catalogue_revision),
    lines,
    returned,
  };
}
export interface ReturnRequest {
  shiftId: string;
  cashier: TillCashier;
  returnsClientRef: string | null;
  lines: readonly {
    itemId: string;
    lotId?: string | null;
    quantity: Quantity;
    unitId?: string | null;
    unitPrice?: Money | null;
  }[];
  events?: SellInput["events"];
  at?: Date;
}

/**
 * A return. A blind one (`returnsClientRef: null`) is priced and limit-checked by `sell`; a referenced one
 * restores its original's facts here. A referenced return of an ACCOUNT sale is settled the way the sale was
 * (Plan Contracts' Phase 6 account correction; ADR 0056, 2026-10-07 and 2026-10-22): credited back to the
 * customer's account, so it takes no tender, completes in this transaction as `accountSale` does, and goes to
 * the server with `tenders: []`, which posts it against `party.receivable_account`. Paying it out of the drawer
 * would leave the customer holding both the refund and the debt.
 */
export function returnTicket(
  sqliteDb: PosDatabase,
  store: SqliteSyncStore,
  req: ReturnRequest,
): ReturnResult {
  requireCode(req.cashier, PERMISSION["pos.ticket.return"]);
  if (!req.lines.length)
    throw new TillError("ERR_VALIDATION_FAILED", "a return needs at least one line");
  if (req.lines.some((l) => l.quantity.isZero() || l.quantity.isNegative()))
    throw new TillError("ERR_VALIDATION_FAILED", "requested return quantities must be positive");
  if (req.returnsClientRef === null) {
    const blind = sell(sqliteDb, store, {
      shiftId: req.shiftId,
      cashier: req.cashier,
      kind: "return",
      lines: req.lines.map((l) => ({
        itemId: l.itemId,
        lotId: l.lotId ?? null,
        quantity: l.quantity,
        unitId: l.unitId ?? null,
        priceOverride: l.unitPrice ?? null,
      })),
      events: req.events ?? [],
      at: req.at ?? new Date(),
    });
    return { ...blind, settledOnAccount: false };
  }
  if (req.events?.length)
    throw new TillError(
      "ERR_VALIDATION_FAILED",
      "historical refunds do not accept new override events",
    );
  return sqliteDb.tx(() => {
    // A void the server refused for good (its shift's close is acknowledged — the `outbox_refused` view, ADR
    // 0056's PR 12 amendment) reversed nothing, so it no longer reserves the original against a return.
    if (
      sqliteDb.raw
        .prepare(
          `select 1 from till_event e
            where e.kind = 'void' and e.ticket_client_ref = ?
              and not exists (select 1 from outbox_refused r where r.kind = 'till_event' and r.ref = e.id)`,
        )
        .get(req.returnsClientRef!)
    )
      throw new TillError(
        "ERR_VALIDATION_FAILED",
        "original has a void intent; it cannot be returned",
      );
    const original = findOriginal(sqliteDb, req.returnsClientRef!);
    if (!original)
      throw new TillError(
        "ERR_NOT_FOUND",
        `no completed original ${req.returnsClientRef} on this till; take a blind return deliberately if the sale was at another till`,
      );
    const prior = priorLines(sqliteDb, original.clientRef);
    const seen = new Set<number>();
    const lines = req.lines.map((l, index): DraftLine => {
      const matches = original.lines.filter(
        (s) =>
          s.itemId === l.itemId &&
          s.lotId === (l.lotId ?? null) &&
          (l.unitId == null || s.unitId === l.unitId),
      );
      if (matches.length !== 1)
        throw new TillError(
          "ERR_VALIDATION_FAILED",
          "original item, lot and unit must match one unambiguous source line",
        );
      const source = matches[0]!;
      if (seen.has(source.lineNo))
        throw new TillError("ERR_VALIDATION_FAILED", "the same original line is requested twice");
      seen.add(source.lineNo);
      if (l.unitPrice != null && !l.unitPrice.equals(source.unitPrice))
        throw new TillError(
          "ERR_VALIDATION_FAILED",
          "a referenced return preserves the original price",
        );
      const previous = prior.filter((p) => sameSource(p, source));
      const already = previous.reduce(
        (sum, p) => sum.add(textToQuantity(p.quantity).negate()),
        Quantity.zero(),
      );
      const cumulative = already.add(l.quantity);
      if (cumulative.compare(source.quantity) > 0)
        throw new TillError(
          "ERR_VALIDATION_FAILED",
          "quantity exceeds original sale's remaining return quantity",
        );
      const completes = cumulative.compare(source.quantity) === 0;
      const ratio = rational(
        BigInt(cumulative.toString().replace(".", "")),
        BigInt(source.quantity.toString().replace(".", "")),
      );
      const cur = original.currency;
      const priorGross = previous.reduce(
        (sum, p) => sum.subtract(textToMoney(p.total, cur)),
        Money.zero(cur),
      );
      const priorNet = previous.reduce(
        (sum, p) =>
          sum.subtract(textToMoney(p.total, cur).subtract(textToMoney(p.tax_amount, cur))),
        Money.zero(cur),
      );
      const priorDiscount = previous.reduce(
        (sum, p) => sum.subtract(textToMoney(p.discount, cur)),
        Money.zero(cur),
      );
      const share = (full: Money, done: Money) =>
        completes
          ? full.subtract(done)
          : full.multiply(ratio, "HALF_AWAY_FROM_ZERO").subtract(done);
      const gross = share(source.total, priorGross);
      const net = share(source.total.subtract(source.taxAmount), priorNet);
      return {
        ...source,
        lineNo: index + 1,
        quantity: l.quantity.negate(),
        discount: share(source.discount, priorDiscount).negate(),
        taxAmount: gross.subtract(net).negate(),
        total: gross.negate(),
      };
    });
    const at = req.at ?? new Date();
    const taxTotal = lines.reduce((sum, l) => sum.add(l.taxAmount), Money.zero(original.currency));
    const total = lines.reduce((sum, l) => sum.add(l.total), Money.zero(original.currency));
    const draft: TicketDraft = {
      clientRef: tillUuidv7(at),
      kind: "return",
      currency: original.currency,
      lines,
      netTotal: total.subtract(taxTotal),
      taxTotal,
      total,
      catalogueRevision: original.catalogueRevision,
    };
    const result = persistTicketDraft(
      sqliteDb,
      store,
      {
        shiftId: req.shiftId,
        cashier: req.cashier,
        kind: "return",
        customerId: original.customerId,
        returnsClientRef: original.clientRef,
        lines: [],
        at,
      },
      draft,
    );
    // No tender, so `tender()` is never called and the status is set here, as `accountSale` sets it: the outbox
    // payload already carries the customer and `tenders: []`, and an open ticket would never be drained.
    if (original.settledOnAccount)
      sqliteDb.raw
        .prepare("update ticket set status = 'completed' where id = ?")
        .run(result.clientRef);
    return { ...result, settledOnAccount: original.settledOnAccount };
  });
}
