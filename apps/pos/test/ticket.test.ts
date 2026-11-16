// apps/pos/test/ticket.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import type { Change, Ticket } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { checkLimits, draftTicket, recordTillEvent, sell } from "../src/main/ticket";
import { tender } from "../src/main/tender";
import { openShift } from "../src/main/shift";
import { clockEvent } from "../src/main/authority";
import { TillError } from "../src/main/errors";
import type { TillCashier } from "../src/main/authority";

const MYR = currency("MYR");
let db: PosDatabase;
let store: SqliteSyncStore;
let shiftId: string;
const dirs: string[] = [];

const LIMITS = {
  maxLineDiscountPct: "0.100000",
  maxTicketDiscountPct: "0.050000",
  maxVoidAmount: "200.0000",
  maxPriceOverridePct: "0.020000",
  blindReturnAllowed: false,
  maxBlindReturnAmount: "0.0000",
  roundingIncrement: "0.0500",
  requireCustomerOver: null,
  maxCashInDrawer: null,
};
const cashier = (codes: string[]): TillCashier => ({
  principalId: "p-1",
  employeeId: "emp-1",
  branchId: "br-1",
  codes,
  limits: LIMITS,
  snapshotRevision: "1",
});
const SELLER = cashier([
  "pos.ticket.sell",
  "pos.ticket.discount",
  "pos.ticket.return",
  "pos.shift.own",
  "pos.attendance.clock",
]);

// The same catalogue Task 5's suite prices against, reduced to one item at 10.0000 and one 10 % tax code.
const CATALOGUE: Change[] = [
  {
    stream: "item",
    op: "upsert",
    id: "item-A",
    revision: 10n,
    row: {
      id: "item-A",
      code: "SKU-A",
      barcode: "9001",
      name_en: "Rice 5kg",
      name_ar: null,
      kind: "product",
      base_unit_id: "unit-ea",
      track_lots: false,
      tax_code_id: "tax-std",
    },
  },
  {
    stream: "price_list",
    op: "upsert",
    id: "pl",
    revision: 11n,
    row: {
      id: "pl",
      code: "RETAIL",
      currency: "MYR",
      customer_kind: null, // the till sells at the walk-in trade level (ADR 0057, POS-02)
      branch_id: null,
      valid_from: null,
      valid_to: null,
    },
  },
  {
    stream: "price_list_line",
    op: "upsert",
    id: "pll",
    revision: 12n,
    row: {
      id: "pll",
      price_list_id: "pl",
      item_id: "item-A",
      unit_id: null,
      min_quantity: "0.000000",
      unit_price: "10.0000",
    },
  },
  {
    stream: "tax_code",
    op: "upsert",
    id: "tax-std",
    revision: 13n,
    row: {
      id: "tax-std",
      code: "SYNTH-OUT-STD",
      rate: "0.10000000",
      kind: "output",
      rounding_mode: "HALF_AWAY_FROM_ZERO",
      output_account_id: "acct-2300",
      input_account_id: null,
      effective_from: "2026-01-01",
      effective_to: null,
    },
  },
  {
    stream: "branch_pos_policy",
    op: "upsert",
    id: "bpp-1",
    revision: 14n,
    row: {
      id: "bpp-1",
      branch_id: "br-1",
      max_line_discount_pct: "0.100000",
      max_ticket_discount_pct: "0.050000",
      max_void_amount: "200.0000",
      max_price_override_pct: "0.020000",
      blind_return_allowed: false,
      max_blind_return_amount: "0.0000",
      max_cash_in_drawer: null,
      require_customer_over: null,
      rounding_increment: "0.0500",
      paid_out_allowed: false,
      max_paid_out_amount: "0.0000",
    },
  },
];

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

const payloadOf = (ref: string): Ticket =>
  JSON.parse(
    db.raw
      .prepare<[string], { payload: string }>(
        "select payload from outbox where kind = 'ticket' and ref = ?",
      )
      .get(ref)!.payload,
  ) as Ticket;

describe("sell — one SQLite transaction (spec:1303, 1337)", () => {
  it("refuses a closed or another cashier's shift and rejects negative entered amounts", () => {
    const input = {
      shiftId,
      cashier: SELLER,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    };
    expect(() =>
      sell(db, store, { ...input, cashier: { ...SELLER, principalId: "someone-else" } }),
    ).toThrow("owned shift");
    expect(() =>
      sell(db, store, {
        ...input,
        lines: [{ ...input.lines[0]!, discount: Money.of("-1.0000", MYR) }],
      }),
    ).toThrow("non-negative");
    expect(() =>
      sell(db, store, { ...input, lines: [{ ...input.lines[0]!, quantity: Quantity.zero() }] }),
    ).toThrow("non-zero");
    db.raw.prepare("update shift set closed_at='2026-10-09T12:00:00Z' where id=?").run(shiftId);
    expect(() => sell(db, store, input)).toThrow("open local shift");
    expect(db.raw.prepare("select count(*) as n from ticket").get()).toEqual({ n: 0 });
  });

  it("cannot use a claimed supervisor to rescue a missing base permission or absent supervisor", () => {
    const input = {
      shiftId,
      cashier: SELLER,
      lines: [
        { itemId: "item-A", quantity: Quantity.of("1.000000"), discount: Money.of("2.0000", MYR) },
      ],
      events: [
        {
          kind: "override" as const,
          code: "pos.ticket.override" as const,
          subject: "discount" as const,
          supervisorPrincipalId: "unregistered",
          reason: "claimed approval",
        },
      ],
    };
    expect(() => sell(db, store, input)).toThrow("supervisor is not authorised");
    expect(() =>
      sell(db, store, { ...input, cashier: { ...SELLER, codes: ["pos.ticket.sell"] } }),
    ).toThrow("does not hold pos.ticket.discount");
    expect(db.raw.prepare("select count(*) as n from ticket").get()).toEqual({ n: 0 });
  });
  it("writes the ticket, its lines and its outbox row, and the ref is the clientRef", () => {
    const r = sell(db, store, {
      shiftId,
      cashier: SELLER,
      lines: [{ itemId: "item-A", quantity: Quantity.of("2.000000") }],
    });
    expect(r.clientRef).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/); // a uuidv7, minted at the till
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket").get()!.n).toBe(1);
    expect(
      db.raw.prepare<[], { n: number }>("select count(*) as n from ticket_line").get()!.n,
    ).toBe(1);
    const row = db.raw
      .prepare<
        [string],
        {
          net_total: string;
          tax_total: string;
          total: string;
          status: string;
          catalogue_revision: string;
        }
      >("select net_total, tax_total, total, status, catalogue_revision from ticket where id = ?")
      .get(r.clientRef)!;
    // 10.0000 × 2 = 20.0000 gross incl. tax; base = 20.0000 / 1.10 = 18.1818, tax = 1.8182.
    expect(row.total).toBe("20.0000");
    expect(row.net_total).toBe("18.1818");
    expect(row.tax_total).toBe("1.8182");
    expect(row.status).toBe("open");
    expect(row.catalogue_revision).toBe("14");
    const out = db.raw
      .prepare<[], { kind: string; ref: string; acked_at: string | null }>(
        "select kind, ref, acked_at from outbox where kind='ticket'",
      )
      .get()!;
    expect(out).toEqual({ kind: "ticket", ref: r.clientRef, acked_at: null });
  });

  it("the outbox payload is a wire `Ticket` whose catalogueRevision is a STRING, so JSON.stringify works", () => {
    const r = sell(db, store, {
      shiftId,
      cashier: SELLER,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    });
    const p = payloadOf(r.clientRef) as unknown as Record<string, unknown>;
    // A bigint in the payload would have thrown inside `enqueue`'s JSON.stringify with
    // "Do not know how to serialize a BigInt" — which is why the wire form is BigintString (6A's Zod).
    expect(typeof p["catalogueRevision"]).toBe("string");
    expect(p["catalogueRevision"]).toBe("14");
    expect(p["shiftId"]).toBe(shiftId);
    expect(p["cashierPrincipalId"]).toBe("p-1");
    expect(p["kind"]).toBe("sale");
    expect(p["returnsClientRef"]).toBeNull();
    expect(JSON.parse(JSON.stringify(p))).toEqual(p); // round-trips, which enqueue relies on
  });

  it("rolls the WHOLE unit back when the outbox write fails — no orphan ticket, ever", async () => {
    await clockEvent(db, SELLER, "clock_in");
    const before = db.raw.prepare<[], { n: number }>("select count(*) as n from outbox").get()!.n;
    const write = vi.spyOn(store, "enqueue").mockImplementationOnce(() => {
      throw new Error("disk full at outbox write");
    });
    expect(() =>
      sell(db, store, {
        shiftId,
        cashier: SELLER,
        lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
      }),
    ).toThrow("disk full at outbox write");
    write.mockRestore();
    expect(db.raw.prepare("select count(*) as n from ticket").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("select count(*) as n from ticket_line").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("select count(*) as n from outbox").get()).toEqual({ n: before });
    expect(
      db.raw.prepare("select count(*) as n from attendance where sent_at is null").get(),
    ).toEqual({ n: 1 });
  });

  it("carries the pending attendance events onto the ticket and stamps them sent — in the same transaction", async () => {
    await clockEvent(db, SELLER, "clock_in");
    const r = sell(db, store, {
      shiftId,
      cashier: SELLER,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    });
    const p = payloadOf(r.clientRef);
    expect(p.attendance).toEqual([
      { kind: "clock_in", principalId: "p-1", at: expect.any(String) },
    ]);
    expect(
      db.raw
        .prepare<[], { n: number }>("select count(*) as n from attendance where sent_at is null")
        .get()!.n,
    ).toBe(0);
    // A SECOND ticket must not carry it again — that would create two attendance_event rows for one clock-in.
    const second = sell(db, store, {
      shiftId,
      cashier: SELLER,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    });
    expect(payloadOf(second.clientRef).attendance).toEqual([]);
  });

  it("refuses a cashier without pos.ticket.sell before it prices anything", () => {
    const noSell = cashier(["pos.price.check"]);
    expect(() =>
      sell(db, store, {
        shiftId,
        cashier: noSell,
        lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
      }),
    ).toThrow(/ERR_RBAC_FORBIDDEN/);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket").get()!.n).toBe(0);
  });

  it("refuses a line discount over the branch limit with ERR_TILL_LIMIT_EXCEEDED, and the detail names both figures", () => {
    let thrown: unknown;
    try {
      sell(db, store, {
        shiftId,
        cashier: SELLER,
        lines: [
          {
            itemId: "item-A",
            quantity: Quantity.of("1.000000"),
            discount: Money.of("2.0000", MYR),
          },
        ],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_TILL_LIMIT_EXCEEDED");
    // 6C's `verifyTicket` string, verbatim. Task 12 asserts the two are byte-identical.
    expect((thrown as TillError).detail).toContain(
      "line 1 discount 2.0000 exceeds 0.100000 of 10.0000 (1.0000)",
    );
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket").get()!.n).toBe(0);
  });

  it("a discount override event lifts the line and the ticket refusal, and the ticket commits", async () => {
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
          snapshot: { codes: ["pos.ticket.override"], limits: LIMITS, revision: "99" },
          revoked_at: null,
        },
      },
    ]);
    const r = sell(db, store, {
      shiftId,
      cashier: SELLER,
      lines: [
        { itemId: "item-A", quantity: Quantity.of("1.000000"), discount: Money.of("2.0000", MYR) },
      ],
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "discount",
          supervisorPrincipalId: "sup-1",
          reason: "manager approved",
        },
      ],
    });
    expect(payloadOf(r.clientRef).events).toHaveLength(1);
    expect(payloadOf(r.clientRef).lines[0]!.discount).toEqual({
      amount: "2.0000",
      currency: "MYR",
    });
  });

  it("refuses a price override beyond maxPriceOverridePct and accepts one inside it", () => {
    // 2 % of 10.0000 is 0.2000, so 9.7500 is 0.2500 away and refused; 9.8500 is 0.1500 away and allowed.
    expect(() =>
      sell(db, store, {
        shiftId,
        cashier: SELLER,
        lines: [
          {
            itemId: "item-A",
            quantity: Quantity.of("1.000000"),
            priceOverride: Money.of("9.7500", MYR),
          },
        ],
      }),
    ).toThrow(/ERR_TILL_LIMIT_EXCEEDED/);
    const ok = sell(db, store, {
      shiftId,
      cashier: SELLER,
      lines: [
        {
          itemId: "item-A",
          quantity: Quantity.of("1.000000"),
          priceOverride: Money.of("9.8500", MYR),
        },
      ],
    });
    expect(payloadOf(ok.clientRef).lines[0]!.unitPrice).toEqual({
      amount: "9.8500",
      currency: "MYR",
    });
  });

  it("spreads a ticket discount across lines with allocate, so the parts sum to the whole exactly", () => {
    const r = sell(db, store, {
      shiftId,
      cashier: SELLER,
      // 3 lines at 10.0000, gross 30.0000; 5 % of that is 1.5000; allocate over 3 lines is 0.5000 each.
      lines: [
        { itemId: "item-A", quantity: Quantity.of("1.000000") },
        { itemId: "item-A", quantity: Quantity.of("1.000000") },
        { itemId: "item-A", quantity: Quantity.of("1.000000") },
      ],
      ticketDiscount: Money.of("1.5000", MYR),
    });
    const p = payloadOf(r.clientRef);
    const sum = p.lines.reduce((s, l) => s.add(Money.of(l.discount.amount, MYR)), Money.zero(MYR));
    expect(sum.toString()).toBe("1.5000");
    expect(p.lines.map((l) => l.discount.amount)).toEqual(["0.5000", "0.5000", "0.5000"]);
  });

  it("a return negates quantity, discount, taxAmount and total together, and NEVER the unit price (A9)", () => {
    const r = sell(db, store, {
      shiftId,
      cashier: {
        ...SELLER,
        codes: [...SELLER.codes, "pos.ticket.return_blind"],
        limits: { ...SELLER.limits, blindReturnAllowed: true, maxBlindReturnAmount: "100.0000" },
      },
      kind: "return",
      returnsClientRef: null,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    });
    const line = payloadOf(r.clientRef).lines[0]!;
    expect(line.quantity).toBe("-1.000000");
    expect(line.total).toEqual({ amount: "-10.0000", currency: "MYR" });
    expect(line.taxAmount.amount.startsWith("-")).toBe(true);
    expect(line.unitPrice).toEqual({ amount: "10.0000", currency: "MYR" }); // a price is a price
    expect(payloadOf(r.clientRef).returnsClientRef).toBeNull();
    expect(
      db.raw
        .prepare<[string], { kind: string }>("select kind from ticket where id = ?")
        .get(r.clientRef)!.kind,
    ).toBe("return");
  });

  it("checkLimits produces one refusal per broken limit and none when every limit holds", () => {
    const draft = draftTicket(db, {
      shiftId,
      cashier: SELLER,
      lines: [
        { itemId: "item-A", quantity: Quantity.of("1.000000"), discount: Money.of("2.0000", MYR) },
      ],
    });
    const refusals = checkLimits(SELLER, draft, {
      catalogueUnitPrices: [Money.of("10.0000", MYR)],
      blind: false,
      voided: false,
    });
    expect(refusals.map((r) => r.kind)).toEqual(["line_discount", "ticket_discount"]);
    const clean = draftTicket(db, {
      shiftId,
      cashier: SELLER,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    });
    expect(
      checkLimits(SELLER, clean, {
        catalogueUnitPrices: [Money.of("10.0000", MYR)],
        blind: false,
        voided: false,
      }),
    ).toEqual([]);
  });

  it("recordTillEvent writes an append-only row and an outbox row keyed on its own clientRef", () => {
    const id = recordTillEvent(db, store, { shiftId, kind: "no_sale", cashier: SELLER });
    const row = db.raw
      .prepare<[string], { kind: string; shift_id: string }>(
        "select kind, shift_id from till_event where id = ?",
      )
      .get(id)!;
    expect(row).toEqual({ kind: "no_sale", shift_id: shiftId });
    const out = db.raw
      .prepare<[string], { kind: string }>("select kind from outbox where ref = ?")
      .get(id)!;
    expect(out.kind).toBe("till_event");
  });
});

// 6B Task 6 (with Task 5's promotions): "a promotion is the shop's decision and a line discount is the
// cashier's, and the branch limit below is checked against the cashier's alone". Before the PR 12 review the
// till added the two together, so selling a promoted item needed `pos.ticket.discount` and broke every branch
// limit below the promotion — at the default policy (zero), every promoted sale was refused.
/** One unit of `item-A` (10.0000 at the till's list price), with whatever else the case adds. */
const one = (extra: Record<string, unknown> = {}) => [
  { itemId: "item-A", quantity: Quantity.of("1.000000"), ...extra },
];
describe("promotions are the shop's discount, not the cashier's (ADR 0059's PR 12 review amendment)", () => {
  const ZERO = { ...LIMITS, maxLineDiscountPct: "0.000000", maxTicketDiscountPct: "0.000000" };
  const PLAIN = { ...cashier(["pos.ticket.sell", "pos.shift.own"]), limits: ZERO };
  const DISCOUNTER = { ...SELLER, limits: ZERO };
  let revision = 40n; // a page at or below the stream's cursor is skipped, so every change moves it on
  const promotion = (id: string, definition: Record<string, unknown>, kind = "percent_off") =>
    store.applyChanges([
      {
        stream: "promotion",
        op: "upsert",
        id,
        revision: (revision += 1n),
        row: {
          id,
          code: id.toUpperCase(),
          kind,
          branch_id: null,
          starts_at: null,
          ends_at: null,
          definition,
        },
      },
    ]);
  beforeEach(() => promotion("pr-10", { itemIds: ["item-A"], percent: "0.100000" }));

  it("sells a promoted item at a zero-limit branch with and without pos.ticket.discount, carrying the evidence", () => {
    for (const who of [PLAIN, DISCOUNTER]) {
      const r = sell(db, store, { shiftId, cashier: who, lines: one() });
      const line = payloadOf(r.clientRef).lines[0]!;
      expect(line.discount).toEqual({ amount: "1.0000", currency: "MYR" });
      expect(line.total).toEqual({ amount: "9.0000", currency: "MYR" });
      expect(line.promotion).toEqual({
        promotionId: "pr-10",
        discount: { amount: "1.0000", currency: "MYR" },
      });
      expect(r.draft.lines[0]!.promotion?.discount.toString()).toBe("1.0000");
    }
    // checkLimits reads the cashier's share only, so the promoted draft breaks no limit at all.
    const draft = draftTicket(db, { shiftId, cashier: PLAIN, lines: one() });
    expect(
      checkLimits(PLAIN, draft, {
        catalogueUnitPrices: [Money.of("10.0000", MYR)],
        blind: false,
        voided: false,
      }),
    ).toEqual([]);
  });

  it("a 10 % promotion plus a manual discount inside the 10 % line limit sells, and only the manual part needs authority", () => {
    const r = sell(db, store, {
      shiftId,
      cashier: SELLER,
      lines: one({ discount: Money.of("0.5000", MYR) }),
    });
    const line = payloadOf(r.clientRef).lines[0]!;
    expect(line.discount.amount).toBe("1.5000");
    expect(line.promotion?.discount.amount).toBe("1.0000");
    // The manual 0.5000 still needs the code: the promotion does not launder a cashier's discount.
    expect(() =>
      sell(db, store, {
        shiftId,
        cashier: { ...PLAIN, limits: LIMITS },
        lines: one({ discount: Money.of("0.5000", MYR) }),
      }),
    ).toThrow("does not hold pos.ticket.discount");
  });

  it("refuses a manual discount over the limit and names the manual figure, never the promotion's", () => {
    let thrown: unknown;
    try {
      sell(db, store, {
        shiftId,
        cashier: SELLER,
        lines: one({ discount: Money.of("2.0000", MYR) }),
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as TillError).code).toBe("ERR_TILL_LIMIT_EXCEEDED");
    expect((thrown as TillError).detail).toContain(
      "line 1 discount 2.0000 exceeds 0.100000 of 10.0000 (1.0000)",
    );
    expect((thrown as TillError).detail).toContain(
      "ticket discount 2.0000 exceeds 0.050000 of 10.0000",
    );
    expect((thrown as TillError).detail).not.toContain("3.0000");
  });

  it("a promoted blind return negates the evidence with the discount", () => {
    const r = sell(db, store, {
      shiftId,
      cashier: {
        ...PLAIN,
        codes: [...PLAIN.codes, "pos.ticket.return", "pos.ticket.return_blind"],
        limits: { ...ZERO, blindReturnAllowed: true, maxBlindReturnAmount: "100.0000" },
      },
      kind: "return",
      lines: one(),
    });
    const line = payloadOf(r.clientRef).lines[0]!;
    expect(line.quantity).toBe("-1.000000");
    expect(line.discount).toEqual({ amount: "-1.0000", currency: "MYR" });
    expect(line.promotion).toEqual({
      promotionId: "pr-10",
      discount: { amount: "-1.0000", currency: "MYR" },
    });
    expect(line.total).toEqual({ amount: "-9.0000", currency: "MYR" });
  });

  it("promotes an overridden price afresh, since the wire price is what the server recomputes from", () => {
    const r = sell(db, store, {
      shiftId,
      cashier: PLAIN,
      lines: one({ priceOverride: Money.of("9.9000", MYR) }),
    });
    const line = payloadOf(r.clientRef).lines[0]!;
    expect(line.unitPrice.amount).toBe("9.9000");
    expect(line.promotion?.discount.amount).toBe("0.9900");
    expect(line.discount.amount).toBe("0.9900");
  });

  it("tender keeps the evidence on the replaced payload, beside cash rounding on the same line", async () => {
    await promotion(
      "pr-3sen",
      { itemIds: ["item-A"], amountPerUnit: "0.0300", currency: "MYR" },
      "amount_off",
    );
    // 10 % (1.0000) beats 0.0300 and is a multiple of the increment, so the percent promotion is removed here.
    await store.applyChanges([
      {
        stream: "promotion",
        op: "delete",
        id: "pr-10",
        revision: (revision += 1n),
        row: null,
      },
    ]);
    const r = sell(db, store, { shiftId, cashier: PLAIN, lines: one() });
    expect(payloadOf(r.clientRef).lines[0]!.total.amount).toBe("9.9700");
    const done = tender(db, store, {
      clientRef: r.clientRef,
      cashier: PLAIN,
      tenders: [{ method: "cash", amount: Money.of("10.0000", MYR) }],
    });
    expect(done.payable.toString()).toBe("9.9500");
    const wire = payloadOf(r.clientRef);
    expect(wire.tenders).toHaveLength(1);
    expect(wire.cashRounding).toEqual({
      lineNo: 1,
      adjustment: { amount: "-0.0200", currency: "MYR" },
    });
    // The discount carries promotion and rounding together; the evidence names the promotion's share alone.
    expect(wire.lines[0]!.discount.amount).toBe("0.0500");
    expect(wire.lines[0]!.promotion).toEqual({
      promotionId: "pr-3sen",
      discount: { amount: "0.0300", currency: "MYR" },
    });
  });
});
