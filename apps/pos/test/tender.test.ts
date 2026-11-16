// apps/pos/test/tender.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import type { Ticket } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { openShift, shiftTotals } from "../src/main/shift";
import { sell } from "../src/main/ticket";
import { roundToIncrement, tender } from "../src/main/tender";
import { buildReceipt } from "../src/main/receipt";
import { TillError } from "../src/main/errors";

const MYR = currency("MYR");
let db: PosDatabase;
let store: SqliteSyncStore;
let shiftId: string;
const dirs: string[] = [];

import { SELLER, CATALOGUE } from "./support/catalogue";
import { returnTicket } from "../src/main/returns";

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-"));
  dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
  await store.applyChanges(CATALOGUE);
  store.finishCataloguePull();
  shiftId = openShift(db, store, {
    terminalId: "term-1",
    cashier: SELLER,
    openingFloat: Money.of("100.0000", MYR),
  }).id;
});
afterEach(() => {
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const one = (): string =>
  sell(db, store, {
    shiftId,
    cashier: SELLER,
    lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
  }).clientRef;
const payloadOf = (ref: string): Ticket =>
  JSON.parse(
    db.raw
      .prepare<[string], { payload: string }>(
        "select payload from outbox where kind = 'ticket' and ref = ?",
      )
      .get(ref)!.payload,
  ) as Ticket;

describe("tenders, change and POS rounding (§3.7.6 Payment, ADR 0059)", () => {
  it("stores net cash, emits signed rounding evidence and learns the real receipt number only from ACK", async () => {
    const ref = one();
    tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("5.0000", MYR) }],
    });
    expect(shiftTotals(db, shiftId)).toEqual({ tickets: 1, byMethod: { cash: "3.3500" } });
    expect(payloadOf(ref).cashRounding).toEqual({
      lineNo: 1,
      adjustment: { amount: "0.0200", currency: "MYR" },
    });
    expect(buildReceipt(db, ref).tenders).toEqual([
      { method: "cash", amount: "5.0000", reference: null },
    ]);
    expect(buildReceipt(db, ref).documentNumber).toBeNull();
    const ids = db.raw
      .prepare<[string], { id: string }>("select id from outbox where kind='ticket' and ref=?")
      .all(ref)
      .map((row) => row.id);
    await store.markAcked(ids, {
      batchId: "b",
      results: [
        { clientRef: ref, status: "accepted", documentId: "d", number: "POS-000001", error: null },
      ],
      shiftResults: [],
      tillEventResults: [],
      catalogueCursor: "MQ",
    });
    expect(buildReceipt(db, ref).documentNumber).toBe("POS-000001");
  });

  it("rolls back completion, tenders, rounded lines and receipt metadata when the outbox update fails", () => {
    const ref = one();
    db.raw.exec(
      "create trigger refuse_outbox_update before update of payload on outbox begin select raise(abort, 'outbox write unavailable'); end",
    );
    expect(() =>
      tender(db, store, {
        clientRef: ref,
        cashier: SELLER,
        tenders: [{ method: "cash", amount: Money.of("5.0000", MYR) }],
      }),
    ).toThrow("outbox write unavailable");
    expect(db.raw.prepare("select status,total from ticket").get()).toEqual({
      status: "open",
      total: "3.3300",
    });
    expect(db.raw.prepare("select count(*) as n from ticket_tender").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("select discount,total from ticket_line").get()).toEqual({
      discount: "0.0000",
      total: "3.3300",
    });
    expect(payloadOf(ref).tenders).toEqual([]);
    expect(
      db.raw.prepare("select count(*) as n from meta where key like 'received_tenders:%'").get(),
    ).toEqual({ n: 0 });
  });

  it("pins an explicitly untaxed line across a later item tax edit", () => {
    db.raw
      .prepare(
        "update catalogue_item set row_json=json_set(row_json,'$.tax_code_id',null) where id='item-A'",
      )
      .run();
    const ref = one();
    db.raw
      .prepare(
        "update catalogue_item set row_json=json_set(row_json,'$.tax_code_id','tax-std') where id='item-A'",
      )
      .run();
    tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("3.3500", MYR) }],
    });
    expect(payloadOf(ref).lines[0]!).toMatchObject({
      taxCodeId: null,
      taxAmount: { amount: "0.0000", currency: "MYR" },
    });
  });

  it("preserves an offline new customer and clock event through completion", () => {
    const customer = { id: "new-customer", code: "NEW", nameEn: "Customer", phone: null };
    const cashier = { ...SELLER, codes: [...SELLER.codes, "pos.customer.create"] };
    const ref = sell(db, store, {
      shiftId,
      cashier,
      customerId: customer.id,
      newCustomer: customer,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    }).clientRef;
    const prior = payloadOf(ref);
    prior.attendance = [{ kind: "clock_in", principalId: cashier.principalId, at: prior.soldAt }];
    db.raw
      .prepare("update outbox set payload=? where kind='ticket' and ref=?")
      .run(JSON.stringify(prior), ref);
    tender(db, store, {
      clientRef: ref,
      cashier,
      tenders: [{ method: "cash", amount: Money.of("3.3500", MYR) }],
    });
    expect(payloadOf(ref).newCustomer).toEqual(customer);
    expect(payloadOf(ref).attendance).toEqual(prior.attendance);
  });
  it("roundToIncrement rounds to a positive increment and refuses zero", () => {
    expect(roundToIncrement(Money.of("3.3300", MYR), "0.0500").toString()).toBe("3.3500");
    expect(roundToIncrement(Money.of("3.3200", MYR), "0.0500").toString()).toBe("3.3000");
    expect(roundToIncrement(Money.of("3.3250", MYR), "0.0500").toString()).toBe("3.3500"); // half away from zero
    expect(roundToIncrement(Money.of("-3.3300", MYR), "0.0500").toString()).toBe("-3.3500");
    expect(() => roundToIncrement(Money.of("3.3300", MYR), "0.0000")).toThrow("positive");
    expect(roundToIncrement(Money.of("3.3500", MYR), "0.0500").toString()).toBe("3.3500"); // already a multiple
  });

  it("an all-cash ticket rounds, and the gross EQUALS the payable so the policy balances", () => {
    const ref = one();
    const r = tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("5.0000", MYR) }],
    });
    expect(r.payable.toString()).toBe("3.3500");
    // RECEIPT-FACING sign: rounding 3.3300 UP to 3.3500 is "+0.02" to the customer. The DISCOUNT column
    // takes the opposite sign, which the line assertion below pins — `tender` negates once, at that
    // boundary and nowhere else.
    expect(r.rounding.toString()).toBe("0.0200");
    expect(r.change.toString()).toBe("1.6500");
    const p = payloadOf(ref);
    const lineTotal = p.lines.reduce(
      (s, l) => s.add(Money.of(l.total.amount, MYR)),
      Money.zero(MYR),
    );
    const tenderTotal = p.tenders.reduce(
      (s, t) => s.add(Money.of(t.amount.amount, MYR)),
      Money.zero(MYR),
    );
    // The property the whole ADR exists for: Σ tenders === Σ line totals, to the cent, with no residual leg.
    expect(lineTotal.toString()).toBe("3.3500");
    expect(tenderTotal.toString()).toBe("3.3500");
    expect(p.lines[0]!.discount).toEqual({ amount: "-0.0200", currency: "MYR" });
  });

  it("re-extracts tax from the ROUNDED gross, so base + tax === total exactly", () => {
    const ref = one();
    tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("3.3500", MYR) }],
    });
    const l = payloadOf(ref).lines[0]!;
    // 3.3500 / 1.10 = 3.0455 (HALF_AWAY_FROM_ZERO); tax = 0.3045.
    const total = Money.of(l.total.amount, MYR);
    const tax = Money.of(l.taxAmount.amount, MYR);
    expect(total.toString()).toBe("3.3500");
    expect(tax.toString()).toBe("0.3045");
    expect(total.subtract(tax).toString()).toBe("3.0455");
    const row = db.raw
      .prepare<[string], { net_total: string; tax_total: string; total: string }>(
        "select net_total, tax_total, total from ticket where id = ?",
      )
      .get(ref)!;
    expect(row).toEqual({ net_total: "3.0455", tax_total: "0.3045", total: "3.3500" });
  });

  it("a ticket with ANY non-cash tender is NOT rounded — card settles to the cent", () => {
    const ref = one();
    const r = tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [
        { method: "cash", amount: Money.of("1.0000", MYR) },
        { method: "card", amount: Money.of("2.3300", MYR), reference: "auth-771" },
      ],
    });
    expect(r.payable.toString()).toBe("3.3300");
    expect(r.rounding.toString()).toBe("0.0000");
    expect(r.change.toString()).toBe("0.0000");
    expect(payloadOf(ref).lines[0]!.discount).toEqual({ amount: "0.0000", currency: "MYR" });
  });

  it("multi-tender sums across all four methods and writes one ticket_tender row each, numbered from 1", () => {
    const ref = one();
    tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [
        { method: "store_credit", amount: Money.of("1.0000", MYR) },
        { method: "transfer", amount: Money.of("1.0000", MYR), reference: "FT-9" },
        { method: "card", amount: Money.of("1.0000", MYR), reference: "auth-2" },
        { method: "cash", amount: Money.of("0.3300", MYR) },
      ],
    });
    const rows = db.raw
      .prepare<
        [string],
        { tender_no: number; method: string; amount: string; reference: string | null }
      >(
        "select tender_no, method, amount, reference from ticket_tender where ticket_id = ? order by tender_no",
      )
      .all(ref);
    expect(rows.map((r) => r.tender_no)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.method)).toEqual(["store_credit", "transfer", "card", "cash"]);
    expect(rows[1]!.reference).toBe("FT-9");
    expect(rows[3]!.amount).toBe("0.3300");
  });

  it("refuses a short tender and never leaves the ticket completed", () => {
    const ref = one();
    let thrown: unknown;
    try {
      tender(db, store, {
        clientRef: ref,
        cashier: SELLER,
        tenders: [{ method: "cash", amount: Money.of("1.0000", MYR) }],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_VALIDATION_FAILED");
    expect((thrown as TillError).detail).toContain("3.3500");
    expect(
      db.raw
        .prepare<[string], { status: string }>("select status from ticket where id = ?")
        .get(ref)!.status,
    ).toBe("open");
    expect(
      db.raw.prepare<[], { n: number }>("select count(*) as n from ticket_tender").get()!.n,
    ).toBe(0);
  });

  it("refuses change on anything but cash — a card overpayment is not a refund the till can give", () => {
    const ref = one();
    expect(() =>
      tender(db, store, {
        clientRef: ref,
        cashier: SELLER,
        tenders: [{ method: "card", amount: Money.of("10.0000", MYR), reference: "auth-1" }],
      }),
    ).toThrow(/ERR_VALIDATION_FAILED/);
  });

  it("a return tenders NEGATIVE and gives no change — the money goes out, not in", () => {
    const original = one();
    tender(db, store, {
      clientRef: original,
      cashier: SELLER,
      tenders: [{ method: "card", amount: Money.of("3.3300", MYR) }],
    });
    const ref = returnTicket(db, store, {
      shiftId,
      cashier: SELLER,
      returnsClientRef: original,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    }).clientRef;
    const r = tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("-3.3300", MYR) }],
    });
    expect(r.payable.toString()).toBe("-3.3300");
    expect(r.change.toString()).toBe("0.0000");
    const p = payloadOf(ref);
    expect(p.tenders[0]!.amount).toEqual({ amount: "-3.3300", currency: "MYR" });
    expect(p.lines[0]!.total.amount.startsWith("-")).toBe(true);
  });

  it("refuses to tender a ticket twice, and refuses one that does not exist", () => {
    const ref = one();
    tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("3.3500", MYR) }],
    });
    expect(() =>
      tender(db, store, {
        clientRef: ref,
        cashier: SELLER,
        tenders: [{ method: "cash", amount: Money.of("3.3500", MYR) }],
      }),
    ).toThrow(/ERR_VALIDATION_FAILED/);
    expect(() =>
      tender(db, store, {
        clientRef: "nope",
        cashier: SELLER,
        tenders: [{ method: "cash", amount: Money.of("1.0000", MYR) }],
      }),
    ).toThrow(/ERR_NOT_FOUND/);
  });

  it("the outbox payload is REPLACED, not doubled — one row per ticket, with the tenders on it", () => {
    const ref = one();
    expect(payloadOf(ref).tenders).toEqual([]);
    tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("3.3500", MYR) }],
    });
    expect(
      db.raw
        .prepare<[string], { n: number }>("select count(*) as n from outbox where ref = ?")
        .get(ref)!.n,
    ).toBe(1);
    expect(payloadOf(ref).tenders).toHaveLength(1);
    expect(
      db.raw
        .prepare<[string], { acked_at: string | null }>("select acked_at from outbox where ref = ?")
        .get(ref)!.acked_at,
    ).toBeNull();
  });

  it("buildReceipt carries both names, the rounding line, and the honest catalogue facts (spec:1356)", () => {
    const ref = one();
    tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("5.0000", MYR) }],
    });
    const r = buildReceipt(db, ref);
    expect(r.clientRef).toBe(ref);
    expect(r.lines[0]!.nameEn).toBe("Rice");
    expect(r.lines[0]!.nameAr).toBe("أرز");
    expect(r.total).toBe("3.3500");
    expect(r.rounding).toBe("0.0200"); // receipt-facing, matching `tender`'s return value
    expect(r.change).toBe("1.6500");
    expect(r.tenders).toEqual([{ method: "cash", amount: "5.0000", reference: null }]);
    expect(r.documentNumber).toBeNull(); // nothing has been acknowledged yet
    expect(r.catalogueRevision).toBe("14");
    expect(Date.parse(r.catalogueAt!)).toBeGreaterThan(0);
  });
});

/** Extra catalogue items, priced to exercise one rounding direction or one target-line rule each. */
async function addItems(prices: Record<string, string>) {
  let revision = 30n;
  await store.applyChanges(
    Object.entries(prices).flatMap(([id, unitPrice]) => [
      {
        stream: "item" as const,
        op: "upsert" as const,
        id,
        revision: revision++,
        row: {
          id,
          code: id.toUpperCase(),
          barcode: null,
          name_en: id,
          name_ar: null,
          kind: "product",
          base_unit_id: "unit-ea",
          track_lots: false,
          tax_code_id: "tax-std",
        },
      },
      {
        stream: "price_list_line" as const,
        op: "upsert" as const,
        id: `pll-${id}`,
        revision: revision++,
        row: {
          id: `pll-${id}`,
          price_list_id: "pl",
          item_id: id,
          unit_id: null,
          min_quantity: "0.000000",
          unit_price: unitPrice,
        },
      },
    ]),
  );
}
const basket = (...itemIds: string[]): string =>
  sell(db, store, {
    shiftId,
    cashier: SELLER,
    lines: itemIds.map((itemId) => ({ itemId, quantity: Quantity.of("1.000000") })),
  }).clientRef;
const storedTenders = (ref: string) =>
  db.raw
    .prepare<[string], { tender_no: number; method: string; amount: string }>(
      "select tender_no, method, amount from ticket_tender where ticket_id = ? order by tender_no",
    )
    .all(ref);

describe("settled tenders: the change comes off the rows that overpaid (Plan Contracts' 6B tender persistence)", () => {
  const cases: [string, string[], string, string[]][] = [
    // handed over → change, settled wire amounts
    ["an empty second cash row", ["5.0000", "0.0000"], "1.6500", ["3.3500"]],
    ["a second cash row the first already covered", ["5.0000", "1.0000"], "2.6500", ["3.3500"]],
    ["a later row that overpays", ["2.0000", "5.0000"], "3.6500", ["2.0000", "1.3500"]],
  ];
  for (const [name, handed, change, settled] of cases)
    it(`${name}: no settled tender is negative or zero, and they sum to the payable`, () => {
      const ref = one();
      const r = tender(db, store, {
        clientRef: ref,
        cashier: SELLER,
        tenders: handed.map((amount) => ({ method: "cash", amount: Money.of(amount, MYR) })),
      });
      expect(r.payable.toString()).toBe("3.3500");
      expect(r.change.toString()).toBe(change);
      const wire = payloadOf(ref).tenders;
      expect(wire.map((t) => t.amount.amount)).toEqual(settled);
      expect(wire.map((t) => t.tenderNo)).toEqual(settled.map((_, i) => i + 1));
      expect(storedTenders(ref)).toEqual(
        settled.map((amount, i) => ({ tender_no: i + 1, method: "cash", amount })),
      );
      expect(
        wire
          .reduce((sum, t) => sum.add(Money.of(t.amount.amount, MYR)), Money.zero(MYR))
          .toString(),
      ).toBe("3.3500");
      for (const t of wire) {
        expect(Money.of(t.amount.amount, MYR).isNegative()).toBe(false);
        expect(Money.of(t.amount.amount, MYR).isZero()).toBe(false);
      }
      expect(shiftTotals(db, shiftId).byMethod).toEqual({ cash: "3.3500" });
      // The receipt still shows what the customer handed over, and the change they took back.
      expect(buildReceipt(db, ref).tenders).toEqual(
        handed.map((amount) => ({ method: "cash", amount, reference: null })),
      );
      expect(buildReceipt(db, ref).change).toBe(change);
    });

  it("a ticket whose payable is zero keeps one zero tender, so it never reads as an account sale", async () => {
    await addItems({ "item-free": "0.0000" });
    const ref = basket("item-free");
    tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [
        { method: "cash", amount: Money.of("0.0000", MYR) },
        { method: "cash", amount: Money.of("0.0000", MYR) },
      ],
    });
    expect(payloadOf(ref).tenders).toEqual([
      {
        tenderNo: 1,
        method: "cash",
        amount: { amount: "0.0000", currency: "MYR" },
        reference: null,
      },
    ]);
    expect(storedTenders(ref)).toEqual([{ tender_no: 1, method: "cash", amount: "0.0000" }]);
  });
});

describe("cash rounding at the till agrees with the server's target, direction and sign (ADR 0059)", () => {
  it("rounds DOWN: 3.3200 pays 3.3000, the line's discount takes +0.0200 and the evidence −0.0200", async () => {
    await addItems({ "item-332": "3.3200" });
    const ref = basket("item-332");
    const r = tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("3.3000", MYR) }],
    });
    expect(r.payable.toString()).toBe("3.3000");
    expect(r.rounding.toString()).toBe("-0.0200");
    const p = payloadOf(ref);
    expect(p.lines[0]!.discount).toEqual({ amount: "0.0200", currency: "MYR" });
    expect(p.lines[0]!.total).toEqual({ amount: "3.3000", currency: "MYR" });
    expect(p.cashRounding).toEqual({
      lineNo: 1,
      adjustment: { amount: "-0.0200", currency: "MYR" },
    });
  });

  it("two lines of equal gross: the lower line number takes the adjustment", () => {
    const ref = basket("item-A", "item-A"); // 6.6600 → 6.6500
    tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("10.0000", MYR) }],
    });
    const p = payloadOf(ref);
    expect(p.cashRounding).toEqual({
      lineNo: 1,
      adjustment: { amount: "-0.0100", currency: "MYR" },
    });
    expect(p.lines.map((l) => [l.discount.amount, l.total.amount])).toEqual([
      ["0.0100", "3.3200"],
      ["0.0000", "3.3300"],
    ]);
  });

  it("three lines: the greatest gross takes the adjustment wherever it sits", async () => {
    await addItems({ "item-101": "1.0100", "item-667": "6.6700" });
    const ref = basket("item-101", "item-667", "item-A"); // 11.0100 → 11.0000
    const r = tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("11.0000", MYR) }],
    });
    expect(r.payable.toString()).toBe("11.0000");
    const p = payloadOf(ref);
    expect(p.cashRounding).toEqual({
      lineNo: 2,
      adjustment: { amount: "-0.0100", currency: "MYR" },
    });
    expect(p.lines.map((l) => l.total.amount)).toEqual(["1.0100", "6.6600", "3.3300"]);
  });

  it("a blind return rounds AWAY from zero: −3.3300 pays out −3.3500 with evidence −0.0200", () => {
    const cashier = {
      ...SELLER,
      codes: [...SELLER.codes, "pos.ticket.return_blind"],
      limits: { ...SELLER.limits, blindReturnAllowed: true, maxBlindReturnAmount: "50.0000" },
    };
    const ref = returnTicket(db, store, {
      shiftId,
      cashier,
      returnsClientRef: null,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    }).clientRef;
    const r = tender(db, store, {
      clientRef: ref,
      cashier,
      tenders: [{ method: "cash", amount: Money.of("-3.3500", MYR) }],
    });
    expect(r.payable.toString()).toBe("-3.3500");
    expect(r.change.toString()).toBe("0.0000");
    const p = payloadOf(ref);
    expect(p.lines[0]!.total).toEqual({ amount: "-3.3500", currency: "MYR" });
    expect(p.lines[0]!.discount).toEqual({ amount: "0.0200", currency: "MYR" });
    expect(p.cashRounding).toEqual({
      lineNo: 1,
      adjustment: { amount: "-0.0200", currency: "MYR" },
    });
    expect(p.tenders).toEqual([
      {
        tenderNo: 1,
        method: "cash",
        amount: { amount: "-3.3500", currency: "MYR" },
        reference: null,
      },
    ]);
  });
});

describe("persisted receipt item facts", () => {
  it("preserves the sale's original bilingual labels through mirror edits and tombstones", () => {
    const ref = one();
    tender(db, store, {
      clientRef: ref,
      cashier: SELLER,
      tenders: [{ method: "cash", amount: Money.of("5.0000", MYR) }],
    });
    const original = buildReceipt(db, ref).lines;
    db.raw
      .prepare("update catalogue_item set name_en=?,name_ar=?,code=? where id=?")
      .run("Changed", "Changed Arabic", "CHANGED", "item-A");
    expect(buildReceipt(db, ref).lines).toEqual(original);
    db.raw.prepare("delete from catalogue_item where id=?").run("item-A");
    expect(buildReceipt(db, ref).lines).toEqual(original);
  });
  it("refuses to print a ticket that has not completed payment", () => {
    expect(() => buildReceipt(db, one())).toThrow("completed ticket");
  });
});
