// apps/pos/test/customer.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import type { Change, Ticket } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { openShift } from "../src/main/shift";
import {
  accountSale,
  checkCredit,
  clearPendingCustomers,
  findCustomers,
  quickCreateCustomer,
} from "../src/main/customer";
import { sell } from "../src/main/ticket";
import { getCustomer } from "../src/main/customer";
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
const SELLER: TillCashier = {
  principalId: "p-1",
  employeeId: "e-1",
  branchId: "br-1",
  codes: ["pos.ticket.sell", "pos.customer.create", "pos.shift.own"],
  limits: LIMITS,
  snapshotRevision: "1",
};

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
      name_en: "Rice",
      name_ar: null,
      kind: "product",
      base_unit_id: "unit-ea",
      track_lots: false,
      tax_code_id: null,
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
    stream: "customer",
    op: "upsert",
    id: "cust-1",
    revision: 13n,
    row: {
      id: "cust-1",
      code: "C-001",
      name_en: "Ahmad Trading",
      name_ar: "أحمد للتجارة",
      phone: "0171234567",
      currency: "MYR",
      credit_limit: "100.0000",
      credit_hold: false,
    },
  },
  {
    stream: "customer",
    op: "upsert",
    id: "cust-hold",
    revision: 14n,
    row: {
      id: "cust-hold",
      code: "C-002",
      name_en: "Slow Payer",
      name_ar: null,
      phone: "0179999999",
      currency: "MYR",
      credit_limit: "500.0000",
      credit_hold: true,
    },
  },
  {
    stream: "customer",
    op: "upsert",
    id: "cust-cash",
    revision: 15n,
    row: {
      id: "cust-cash",
      code: "C-003",
      name_en: "Cash Only",
      name_ar: null,
      phone: null,
      currency: "MYR",
      credit_limit: null,
      credit_hold: false,
    },
  },
  {
    stream: "branch_pos_policy",
    op: "upsert",
    id: "bpp",
    revision: 16n,
    row: {
      id: "bpp",
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
  vi.restoreAllMocks();
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

describe("customers at the till (§3.7.6 Customers, spec:1351)", () => {
  it("finds a customer by code, by phone and by BOTH names", () => {
    expect(findCustomers(db, "C-001").map((c) => c.id)).toEqual(["cust-1"]);
    expect(findCustomers(db, "0171234567").map((c) => c.id)).toEqual(["cust-1"]);
    expect(findCustomers(db, "ahmad").map((c) => c.id)).toEqual(["cust-1"]);
    expect(findCustomers(db, "أحمد").map((c) => c.id)).toEqual(["cust-1"]);
    expect(findCustomers(db, "nobody")).toEqual([]);
  });

  it("quick-creates offline: the party's uuidv7 is minted at the till and is the ticket's customerId", () => {
    const { customer, newCustomer } = quickCreateCustomer(db, SELLER, {
      nameEn: "Walk-in Fatimah",
      phone: "0181112222",
    });
    expect(customer.pending).toBe(true);
    expect(customer.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(newCustomer.id).toBe(customer.id);
    expect(newCustomer.nameEn).toBe("Walk-in Fatimah");
    expect(newCustomer.code).toBe(customer.code);
    // Findable immediately, with no network, which is the whole point of the table.
    expect(findCustomers(db, "0181112222").map((c) => c.id)).toEqual([customer.id]);
    expect(findCustomers(db, "fatimah")[0]!.pending).toBe(true);
  });

  it("refuses a quick-create without pos.customer.create", () => {
    const noCode: TillCashier = { ...SELLER, codes: ["pos.ticket.sell"] };
    expect(() => quickCreateCustomer(db, noCode, { nameEn: "X" })).toThrow(/ERR_RBAC_FORBIDDEN/);
  });

  it("refuses a quick-create whose code collides, rather than silently reusing a party", () => {
    quickCreateCustomer(db, SELLER, { nameEn: "First", code: "WALK-1" });
    expect(() => quickCreateCustomer(db, SELLER, { nameEn: "Second", code: "WALK-1" })).toThrow(
      /ERR_VALIDATION_FAILED/,
    );
  });

  it("checkCredit refuses a customer on credit hold, whatever the limit says", () => {
    const c = checkCredit(db, "cust-hold", Money.of("1.0000", MYR));
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("credit hold");
  });

  it("checkCredit refuses a customer with no limit at all — a cash customer has no account", () => {
    const c = checkCredit(db, "cust-cash", Money.of("1.0000", MYR));
    expect(c.ok).toBe(false);
    expect(c.limit).toBeNull();
    expect(c.detail).toContain("no credit limit");
  });

  it("checkCredit counts THIS TILL's unsynced account sales against the limit, and says the figure is local", () => {
    expect(checkCredit(db, "cust-1", Money.of("60.0000", MYR)).ok).toBe(true);
    accountSale(db, store, {
      shiftId,
      cashier: SELLER,
      customerId: "cust-1",
      lines: [{ itemId: "item-A", quantity: Quantity.of("6.000000") }],
    });
    const after = checkCredit(db, "cust-1", Money.of("60.0000", MYR));
    expect(after.localExposure.toString()).toBe("60.0000");
    expect(after.ok).toBe(false);
    expect(after.detail).toContain("100.0000");
    expect(after.detail).toContain("this till"); // spec:1307's honesty rule applied to credit
  });

  it("accountSale writes a ticket with the customer and NO tender, so the server posts it to receivables", () => {
    const r = accountSale(db, store, {
      shiftId,
      cashier: SELLER,
      customerId: "cust-1",
      lines: [{ itemId: "item-A", quantity: Quantity.of("2.000000") }],
    });
    const p = payloadOf(r.clientRef);
    expect(p.customerId).toBe("cust-1");
    expect(p.tenders).toEqual([]);
    expect(
      db.raw
        .prepare<[string], { status: string }>("select status from ticket where id = ?")
        .get(r.clientRef)!.status,
    ).toBe("completed");
    expect(
      db.raw.prepare<[], { n: number }>("select count(*) as n from ticket_tender").get()!.n,
    ).toBe(0);
  });

  it("accountSale over the limit is refused with ERR_TILL_LIMIT_EXCEEDED and writes nothing", () => {
    let thrown: unknown;
    try {
      accountSale(db, store, {
        shiftId,
        cashier: SELLER,
        customerId: "cust-1",
        lines: [{ itemId: "item-A", quantity: Quantity.of("20.000000") }],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_TILL_LIMIT_EXCEEDED");
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket").get()!.n).toBe(0);
  });

  it("an account sale to a quick-created customer carries newCustomer on the ticket", () => {
    const { customer, newCustomer } = quickCreateCustomer(db, SELLER, {
      nameEn: "New Account",
      phone: "0182223333",
    });
    // A pending customer has no credit limit until the back office gives one, so an account sale is refused.
    expect(() =>
      accountSale(db, store, {
        shiftId,
        cashier: SELLER,
        customerId: customer.id,
        lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
      }),
    ).toThrow(/ERR_TILL_LIMIT_EXCEEDED/);
    // A cash sale to them does carry the newCustomer block.
    const r = sell(db, store, {
      shiftId,
      cashier: SELLER,
      customerId: customer.id,
      newCustomer,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    });
    expect(payloadOf(r.clientRef).newCustomer).toEqual(newCustomer);
  });

  it("an acknowledged pending customer stays findable before its mirror arrives", () => {
    const { customer } = quickCreateCustomer(db, SELLER, { nameEn: "Temp" });
    clearPendingCustomers(db, [customer.id]);
    expect(findCustomers(db, "Temp").map((c) => c.id)).toEqual([customer.id]);
  });
  it("rolls back account completion, lines, attendance and outbox on a real enqueue failure", () => {
    const before = db.raw.prepare<[], { n: number }>("select count(*) as n from outbox").get()!.n;
    vi.spyOn(store, "enqueue").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() =>
      accountSale(db, store, {
        shiftId,
        cashier: SELLER,
        customerId: "cust-1",
        lines: [{ itemId: "item-A", quantity: Quantity.of("1") }],
      }),
    ).toThrow("disk full");
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket").get()!.n).toBe(0);
    expect(
      db.raw.prepare<[], { n: number }>("select count(*) as n from ticket_line").get()!.n,
    ).toBe(0);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from outbox").get()!.n).toBe(
      before,
    );
  });
  it("prefers an arrived mirror over the retained acknowledged local customer", async () => {
    const { customer } = quickCreateCustomer(db, SELLER, { nameEn: "Arrived", code: "ARR" });
    clearPendingCustomers(db, [customer.id]);
    await store.applyChanges([
      {
        stream: "customer",
        op: "upsert",
        id: customer.id,
        revision: 100n,
        row: {
          id: customer.id,
          code: "ARR",
          name_en: "Arrived",
          name_ar: null,
          phone: null,
          currency: "MYR",
          credit_limit: "50.0000",
          credit_hold: false,
        },
      },
    ]);
    expect(findCustomers(db, "ARR")).toHaveLength(1);
    expect(getCustomer(db, customer.id)!.pending).toBe(false);
    expect(() => quickCreateCustomer(db, SELLER, { nameEn: "Other", code: "ARR" })).toThrow(
      /already in use/,
    );
  });
});
