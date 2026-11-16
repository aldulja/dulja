import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { openShift } from "../src/main/shift";
import { sell } from "../src/main/ticket";
import { tender } from "../src/main/tender";
import { findOriginal, returnTicket } from "../src/main/returns";
import { accountSale } from "../src/main/customer";
import { buildReceipt } from "../src/main/receipt";
import { TillError } from "../src/main/errors";
import type { TillCashier } from "../src/main/authority";
import type { Ticket } from "@dulja/sync";
import { CATALOGUE, SELLER } from "./support/catalogue";
const MYR = currency("MYR");
let sqliteDb: PosDatabase;
let store: SqliteSyncStore;
let shiftId: string;
const qty = (quantity: string) => [{ itemId: "item-A", quantity: Quantity.of(quantity) }];
beforeEach(async () => {
  sqliteDb = openPosDatabase(":memory:");
  store = new SqliteSyncStore(sqliteDb);
  await store.applyChanges(CATALOGUE);
  store.finishCataloguePull();
  shiftId = openShift(sqliteDb, store, {
    terminalId: "term",
    cashier: SELLER,
    openingFloat: Money.zero(MYR),
  }).id;
});
afterEach(() => {
  sqliteDb.close();
  vi.restoreAllMocks();
});
function original(quantity = "3", cash = false) {
  const ref = sell(sqliteDb, store, { shiftId, cashier: SELLER, lines: qty(quantity) }).clientRef;
  tender(sqliteDb, store, {
    clientRef: ref,
    cashier: SELLER,
    tenders: [
      { method: cash ? "cash" : "card", amount: Money.of(cash ? "10.0000" : "9.9900", MYR) },
    ],
  });
  return ref;
}
const refund = (ref: string, quantity: string) =>
  returnTicket(sqliteDb, store, {
    shiftId,
    cashier: SELLER,
    returnsClientRef: ref,
    lines: qty(quantity),
  });
describe("historical referenced returns", () => {
  it("restores cumulative original gross, net, tax and rounding without repricing or extra authority", () => {
    const ref = original("3", true);
    const source = findOriginal(sqliteDb, ref)!;
    // Remove every mirror: history remains sufficient for drafting and tendering the refund.
    sqliteDb.raw.exec(
      "delete from catalogue_item; delete from catalogue_tax_code; delete from catalogue_price_list_line",
    );
    const refunds = [refund(ref, "1"), refund(ref, "1"), refund(ref, "1")];
    for (const r of refunds)
      tender(sqliteDb, store, {
        clientRef: r.clientRef,
        cashier: SELLER,
        tenders: [{ method: "cash", amount: r.draft.total }],
      });
    const sum = (field: "total" | "discount" | "taxAmount") =>
      refunds.reduce(
        (total, r) => total.add(r.draft.lines[0]![field]),
        Money.zero(currency(source.currency)),
      );
    expect(sum("total").toString()).toBe(source.lines[0]!.total.negate().toString());
    expect(sum("discount").toString()).toBe(source.lines[0]!.discount.negate().toString());
    expect(sum("taxAmount").toString()).toBe(source.lines[0]!.taxAmount.negate().toString());
    expect(refunds.map((r) => r.draft.lines[0]!.taxAmount.toString())).toEqual([
      "-0.3030",
      "-0.3031",
      "-0.3030",
    ]);
    expect(() => refund(ref, "0.000001")).toThrow(/remaining return quantity/);
  });
  it("a void the server refused for good no longer blocks a return of its original", () => {
    const ref = original();
    const voidId = "019aaadb-0000-7000-8000-0000000000aa";
    const at = new Date().toISOString();
    sqliteDb.raw
      .prepare(
        "insert into till_event (id, shift_id, kind, ticket_client_ref, cashier_principal_id, occurred_at) values (?, ?, 'void', ?, ?, ?)",
      )
      .run(voidId, shiftId, ref, SELLER.principalId, at);
    sqliteDb.raw
      .prepare(
        "insert into outbox (id, kind, ref, payload, attempts, last_error, created_at) values (?, 'till_event', ?, ?, 1, 'ERR_POS_LIMIT_EXCEEDED', ?)",
      )
      .run("void-row", voidId, JSON.stringify({ shiftId }), at);
    // While the shift is open the refused void is still re-sent, so it still reserves the original.
    expect(() => refund(ref, "1")).toThrow(/void intent/);
    sqliteDb.raw
      .prepare(
        "insert into outbox (id, kind, ref, payload, attempts, acked_at, created_at) values (?, 'shift', ?, '{}', 1, ?, ?)",
      )
      .run("close-row", `${shiftId}:close`, at, at);
    expect(refund(ref, "1").draft.lines[0]!.quantity.toString()).toBe("-1.000000");
  });
  it("reserves unfinished refunds but releases voided local reservations", () => {
    const ref = original();
    const r = refund(ref, "2");
    expect(() => refund(ref, "2")).toThrow(/remaining return quantity/);
    sqliteDb.raw.prepare("update ticket set status='voided' where id=?").run(r.clientRef);
    expect(refund(ref, "3").draft.total.toString()).toBe("-9.9900");
  });
  it("refuses ambiguous source lines, duplicate requests, wrong unit/lot and missing references", () => {
    const ref = original();
    expect(() =>
      returnTicket(sqliteDb, store, {
        shiftId,
        cashier: SELLER,
        returnsClientRef: ref,
        lines: [...qty("1"), ...qty("1")],
      }),
    ).toThrow(/same original line/);
    expect(() =>
      returnTicket(sqliteDb, store, {
        shiftId,
        cashier: SELLER,
        returnsClientRef: ref,
        lines: [{ ...qty("1")[0]!, unitId: "wrong" }],
      }),
    ).toThrow(/unambiguous/);
    expect(() => refund("missing", "1")).toThrow(/ERR_NOT_FOUND/);
    expect(() => refund("missing", "1")).toThrow(/blind return/);
    sqliteDb.raw.exec(
      "insert into ticket_line select ticket_id, 2, item_id, lot_id, quantity, unit_id, unit_price, discount, tax_code_id, tax_amount, total from ticket_line",
    );
    expect(() => refund(ref, "1")).toThrow(/unambiguous/);
  });
  it("rolls back the refund reservation when the actual outbox write fails", () => {
    const ref = original();
    vi.spyOn(store, "enqueue").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => refund(ref, "3")).toThrow("disk full");
    expect(findOriginal(sqliteDb, ref)!.returned[1]).toBe("0.000000");
    expect(refund(ref, "3").draft.total.toString()).toBe("-9.9900");
  });
  it("requires an explicit blind-return grant and rejects zero or signed request quantities", () => {
    expect(() =>
      returnTicket(sqliteDb, store, {
        shiftId,
        cashier: SELLER,
        returnsClientRef: null,
        lines: qty("1"),
      }),
    ).toThrow(/ERR_RBAC_FORBIDDEN/);
    const ref = original();
    expect(() => refund(ref, "0")).toThrow(/positive/);
    expect(() => refund(ref, "-1")).toThrow(/positive/);
    expect(() =>
      sell(sqliteDb, store, {
        shiftId,
        cashier: SELLER,
        kind: "return",
        returnsClientRef: ref,
        lines: qty("1"),
      }),
    ).toThrow(/historical return path/);
  });
});

const payloadOf = (ref: string): Ticket =>
  JSON.parse(
    sqliteDb.raw
      .prepare<[string], { payload: string }>(
        "select payload from outbox where kind = 'ticket' and ref = ?",
      )
      .get(ref)!.payload,
  ) as Ticket;
const statusOf = (ref: string) =>
  sqliteDb.raw
    .prepare<[string], { status: string }>("select status from ticket where id = ?")
    .get(ref)!.status;
const tenderRows = (ref: string) =>
  sqliteDb.raw
    .prepare<[string], { n: number }>("select count(*) as n from ticket_tender where ticket_id = ?")
    .get(ref)!.n;

describe("a return of an account sale is credited back to the account (ADR 0056, 2026-10-22)", () => {
  beforeEach(async () => {
    await store.applyChanges([
      {
        stream: "customer",
        op: "upsert",
        id: "cust-1",
        revision: 40n,
        row: {
          id: "cust-1",
          code: "C-001",
          name_en: "Ahmad Trading",
          name_ar: "أحمد للتجارة",
          phone: null,
          currency: "MYR",
          credit_limit: "100.0000",
          credit_hold: false,
        },
      },
    ]);
  });
  const onAccount = (quantity = "3") =>
    accountSale(sqliteDb, store, {
      shiftId,
      cashier: SELLER,
      customerId: "cust-1",
      lines: qty(quantity),
    }).clientRef;

  it("a full referenced return completes at once: no tender, the customer kept, and it drains", async () => {
    const ref = onAccount();
    expect(findOriginal(sqliteDb, ref)!.settledOnAccount).toBe(true);
    const r = refund(ref, "3");
    expect(r.settledOnAccount).toBe(true);
    expect(statusOf(r.clientRef)).toBe("completed");
    expect(tenderRows(r.clientRef)).toBe(0);
    expect(
      sqliteDb.raw
        .prepare<[string], { customer_id: string | null }>(
          "select customer_id from ticket where id = ?",
        )
        .get(r.clientRef)!.customer_id,
    ).toBe("cust-1");
    const wire = payloadOf(r.clientRef);
    expect(wire).toMatchObject({
      kind: "return",
      customerId: "cust-1",
      returnsClientRef: ref,
      tenders: [],
    });
    expect(wire.lines.map((l) => l.total.amount)).toEqual(["-9.9900"]);
    expect((await store.pendingOutbox(10)).map((row) => row.ref)).toContain(r.clientRef);
    // The receipt names the account as where the refund went (an empty tender list alone says nothing).
    expect(buildReceipt(sqliteDb, r.clientRef)).toMatchObject({
      total: "-9.9900",
      tenders: [],
      onAccount: true,
      change: "0.0000",
      customerName: "Ahmad Trading",
    });
    expect(buildReceipt(sqliteDb, ref).onAccount).toBe(true);
  });

  it("a partial return settles on account too, and the rest of the sale stays returnable", () => {
    const ref = onAccount();
    const first = refund(ref, "1");
    expect(first.settledOnAccount).toBe(true);
    expect(statusOf(first.clientRef)).toBe("completed");
    expect(payloadOf(first.clientRef).tenders).toEqual([]);
    expect(findOriginal(sqliteDb, ref)!.returned[1]).toBe("1.000000");
    const rest = refund(ref, "2");
    expect(rest.settledOnAccount).toBe(true);
    expect(statusOf(rest.clientRef)).toBe("completed");
    expect(first.draft.total.add(rest.draft.total).toString()).toBe("-9.9900");
    expect(() => refund(ref, "0.000001")).toThrow(/remaining return quantity/);
  });

  it("tender() refuses to pay out a return of an account sale", () => {
    const r = refund(onAccount(), "1");
    expect(() =>
      tender(sqliteDb, store, {
        clientRef: r.clientRef,
        cashier: SELLER,
        tenders: [{ method: "cash", amount: r.draft.total }],
      }),
    ).toThrow(/ERR_VALIDATION_FAILED/);
    // An open one — made before returns of account sales completed themselves — is refused for its own reason.
    sqliteDb.raw.prepare("update ticket set status = 'open' where id = ?").run(r.clientRef);
    expect(() =>
      tender(sqliteDb, store, {
        clientRef: r.clientRef,
        cashier: SELLER,
        tenders: [{ method: "cash", amount: r.draft.total }],
      }),
    ).toThrow(/refunded to the customer's account/);
    expect(tenderRows(r.clientRef)).toBe(0);
  });

  it("a return of a PAID customer sale is still tendered, exactly", () => {
    const ref = sell(sqliteDb, store, {
      shiftId,
      cashier: SELLER,
      customerId: "cust-1",
      lines: qty("3"),
    }).clientRef;
    tender(sqliteDb, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "card", amount: Money.of("9.9900", MYR) }],
    });
    expect(findOriginal(sqliteDb, ref)!.settledOnAccount).toBe(false);
    const r = refund(ref, "1");
    expect(r.settledOnAccount).toBe(false);
    expect(statusOf(r.clientRef)).toBe("open");
    expect(payloadOf(r.clientRef).customerId).toBe("cust-1");
    expect(() =>
      tender(sqliteDb, store, {
        clientRef: r.clientRef,
        cashier: SELLER,
        tenders: [{ method: "cash", amount: Money.of("-1.0000", MYR) }],
      }),
    ).toThrow(/tendered exactly/);
    tender(sqliteDb, store, {
      clientRef: r.clientRef,
      cashier: SELLER,
      tenders: [{ method: "card", amount: r.draft.total }],
    });
    expect(payloadOf(r.clientRef).tenders.map((t) => t.amount.amount)).toEqual(["-3.3300"]);
    expect(buildReceipt(sqliteDb, ref).onAccount).toBe(false);
    expect(buildReceipt(sqliteDb, r.clientRef).onAccount).toBe(false);
  });
});

/** A cashier holding the blind-return grant, under the branch policy `over` overrides. */
const BLIND = (over: Partial<TillCashier["limits"]>): TillCashier => ({
  ...SELLER,
  codes: [...SELLER.codes, "pos.ticket.return_blind"],
  limits: { ...SELLER.limits, ...over },
});
const blind = (cashier: TillCashier, quantity: string, events: SellInputEvents = []) =>
  returnTicket(sqliteDb, store, {
    shiftId,
    cashier,
    returnsClientRef: null,
    lines: qty(quantity),
    events,
  });
type SellInputEvents = NonNullable<Parameters<typeof returnTicket>[2]["events"]>;

describe("blind returns at the till answer as the server does (6B T8 Step 2)", () => {
  it("a blind return with return_blind is still refused when blind_return_allowed = false", () => {
    let thrown: unknown;
    try {
      blind(BLIND({}), "1");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_TILL_LIMIT_EXCEEDED");
    expect((thrown as TillError).detail).toContain("blind_return_allowed = false");
    expect(sqliteDb.raw.prepare("select count(*) as n from ticket").get()).toEqual({ n: 0 });
  });

  it("a blind return inside max_blind_return_amount is accepted at today's catalogue price", () => {
    const r = blind(BLIND({ blindReturnAllowed: true, maxBlindReturnAmount: "50.0000" }), "2");
    expect(r.settledOnAccount).toBe(false);
    expect(r.draft.lines[0]!.unitPrice.toString()).toBe("3.3300");
    expect(r.draft.total.toString()).toBe("-6.6600");
    expect(payloadOf(r.clientRef).returnsClientRef).toBeNull();
    expect(statusOf(r.clientRef)).toBe("open");
  });

  it("a blind return over the cap is refused, and a supervisor's blind_return override lifts it", async () => {
    const cashier = BLIND({ blindReturnAllowed: true, maxBlindReturnAmount: "5.0000" });
    expect(() => blind(cashier, "2")).toThrow(/exceeds max_blind_return_amount/);
    await store.applyChanges([
      {
        stream: "cashier",
        op: "upsert",
        id: "sup-1",
        revision: 99n,
        row: {
          principal_id: "sup-1",
          employee_id: "emp-s",
          branch_id: "br-1",
          pin_hash: "$argon2id$fixture",
          snapshot: { codes: ["pos.ticket.override"], limits: SELLER.limits, revision: "99" },
          revoked_at: null,
        },
      },
    ]);
    const r = blind(cashier, "2", [
      {
        kind: "override",
        code: "pos.ticket.override",
        subject: "blind_return",
        supervisorPrincipalId: "sup-1",
        reason: "no receipt",
      },
    ]);
    expect(r.draft.total.toString()).toBe("-6.6600");
    expect(payloadOf(r.clientRef).events).toHaveLength(1);
  });

  it("an open, unpaid ticket is not an original", () => {
    const ref = sell(sqliteDb, store, { shiftId, cashier: SELLER, lines: qty("1") }).clientRef;
    expect(findOriginal(sqliteDb, ref)).toBeNull();
    expect(() => refund(ref, "1")).toThrow(/ERR_NOT_FOUND/);
  });
});
