// apps/pos/src/main/receipt.ts
import { currency } from "@dulja/domain";
import type { PosDatabase } from "./database";
import { TillError } from "./errors";
import type { ReceiptItemSnapshot } from "./receipt-snapshot";

export interface ReceiptLine {
  lineNo: number;
  itemId: string;
  unitId: string;
  lotId: string | null;
  code: string;
  nameEn: string;
  nameAr: string | null;
  quantity: string;
  unitPrice: string;
  discount: string;
  total: string;
}

export interface ReceiptPayload {
  clientRef: string;
  kind: "sale" | "return";
  currency: string;
  soldAt: string;
  cashierPrincipalId: string;
  shiftId: string;
  customerName: string | null;
  lines: readonly ReceiptLine[];
  netTotal: string;
  taxTotal: string;
  total: string;
  tenders: readonly { method: string; amount: string; reference: string | null }[];
  /**
   * Settled to the customer's account, not paid: an account sale debits it and a referenced return of one
   * credits it back (`returnTicket`'s `settledOnAccount`), so no money crosses the drawer and `tenders` is
   * empty. The receipt says so in words, because an empty tender list on a return reads as a refund still owed.
   */
  onAccount: boolean;
  change: string;
  rounding: string;
  documentNumber: string | null;
  catalogueRevision: string;
  catalogueAt: string | null;
}

/**
 * The receipt as **data**. Printing is Task 9's — `webContents.print()` in the Electron main process
 * (spec:1280, D18: ordinary Windows printer drivers and no ESC/POS anywhere) — and rendering is Task 11's
 * `components/receipt.tsx`, in both text directions.
 *
 * Every amount is a fixed-4-dp string, not a `Money`: this payload crosses the `contextBridge`, and a class
 * instance does not survive structured cloning. `packages/i18n`'s `formatMoney` is what turns each into the
 * locale's own presentation at render time, which is where display rounding belongs (spec:2041 — *"stored
 * base amounts are never recomputed on read"*).
 *
 * `documentNumber` is `null` until the server has acknowledged the ticket and the till has learned the number
 * from a `TicketResult`. A receipt printed before that carries the client ref, which is what the shop quotes
 * on the phone — and printing a *guessed* number would be SAH-051 in a new place.
 *
 * `catalogueRevision` and `catalogueAt` are on the receipt because spec:1356 asks the indicator to be honest
 * and a printed receipt outlives the screen: a customer disputing a price and a manager reading the receipt
 * can both see which catalogue the till priced from.
 */
export function buildReceipt(db: PosDatabase, clientRef: string): ReceiptPayload {
  const t = db.raw
    .prepare<
      [string],
      {
        id: string;
        status: string;
        kind: "sale" | "return";
        currency: string;
        created_at: string;
        cashier_principal_id: string;
        shift_id: string;
        customer_id: string | null;
        net_total: string;
        tax_total: string;
        total: string;
        catalogue_revision: string;
      }
    >(`select id, status, kind, currency, created_at, cashier_principal_id, shift_id, customer_id,
             net_total, tax_total, total, catalogue_revision
        from ticket where id = ?`)
    .get(clientRef);
  if (t === undefined) throw new TillError("ERR_NOT_FOUND", `no ticket ${clientRef} on this till`);
  if (t.status !== "completed")
    throw new TillError("ERR_VALIDATION_FAILED", "a receipt requires a completed ticket");
  currency(t.currency); // refuses a corrupted row before it reaches a printer

  const lines = db.raw
    .prepare<
      [string],
      {
        line_no: number;
        item_id: string;
        unit_id: string;
        lot_id: string | null;
        quantity: string;
        unit_price: string;
        discount: string;
        total: string;
        code: string | null;
        name_en: string | null;
        name_ar: string | null;
      }
    >(`select l.line_no, l.item_id, l.unit_id, l.lot_id, l.quantity, l.unit_price, l.discount, l.total,
             i.code as code, i.name_en as name_en, i.name_ar as name_ar
        from ticket_line l left join catalogue_item i on i.id = l.item_id
       where l.ticket_id = ? order by l.line_no`)
    .all(clientRef);

  const tenders = db.raw
    .prepare<[string], { method: string; amount: string; reference: string | null }>(
      "select method, amount, reference from ticket_tender where ticket_id = ? order by tender_no",
    )
    .all(clientRef);

  const meta = (key: string): string | null =>
    db.raw.prepare<[string], { value: string }>("select value from meta where key = ?").get(key)
      ?.value ?? null;

  const displayText = meta(`receipt_items:${t.id}`);
  const display = displayText
    ? (JSON.parse(displayText) as Record<string, ReceiptItemSnapshot>)
    : {};
  const received = meta(`received_tenders:${t.id}`);
  const receiptTenders =
    received === null ? tenders : (JSON.parse(received) as ReceiptPayload["tenders"]);

  const customerName =
    t.customer_id === null
      ? null
      : (db.raw
          .prepare<[string], { name_en: string }>(
            "select name_en from catalogue_customer where id = ?",
          )
          .get(t.customer_id)?.name_en ??
        db.raw
          .prepare<[string], { name_en: string }>(
            "select name_en from pending_customer where id = ?",
          )
          .get(t.customer_id)?.name_en ??
        null);

  return {
    clientRef: t.id,
    kind: t.kind,
    currency: t.currency,
    soldAt: t.created_at,
    cashierPrincipalId: t.cashier_principal_id,
    shiftId: t.shift_id,
    customerName,
    lines: lines.map((l) => ({
      lineNo: l.line_no,
      itemId: l.item_id,
      unitId: l.unit_id,
      lotId: l.lot_id,
      // A line whose item has since been tombstoned still prints: the item id is what the ticket recorded.
      code: display[String(l.line_no)]?.code ?? l.code ?? l.item_id,
      nameEn: display[String(l.line_no)]?.nameEn ?? l.name_en ?? l.code ?? l.item_id,
      nameAr: display[String(l.line_no)] ? display[String(l.line_no)]!.nameAr : l.name_ar,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      discount: l.discount,
      total: l.total,
    })),
    netTotal: t.net_total,
    taxTotal: t.tax_total,
    total: t.total,
    tenders: receiptTenders,
    // A customer and no `ticket_tender` row: `tender` keeps a zero row on a zero-payable paid ticket, so this
    // is exactly the account rule `settledOnAccount` (returns.ts) applies to a sale, here for either kind.
    onAccount: t.customer_id !== null && tenders.length === 0,
    change: meta(`change:${t.id}`) ?? "0.0000",
    rounding: meta(`rounding:${t.id}`) ?? "0.0000",
    documentNumber: meta(`number:${t.id}`),
    catalogueRevision: t.catalogue_revision,
    catalogueAt: meta(`catalogue_at:${t.id}`) ?? meta("catalogue_pulled_at"),
  };
}
