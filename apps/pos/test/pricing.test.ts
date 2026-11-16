// apps/pos/test/pricing.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import type { Change } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import {
  assertCatalogueFresh,
  findItemByBarcode,
  priceCheck,
  resolvePrice,
  searchItems,
  taxItemLine,
  tillCurrency,
} from "../src/main/pricing";
import { TillError } from "../src/main/errors";
import type { TillCashier } from "../src/main/authority";

const MYR = currency("MYR");
let db: PosDatabase;
let store: SqliteSyncStore;
const dirs: string[] = [];

const CASHIER: TillCashier = {
  principalId: "p-1",
  employeeId: "emp-1",
  branchId: "br-1",
  codes: ["pos.ticket.sell", "pos.price.check"],
  limits: {
    maxLineDiscountPct: "0.100000",
    maxTicketDiscountPct: "0.050000",
    maxVoidAmount: "200.0000",
    maxPriceOverridePct: "0.020000",
    blindReturnAllowed: false,
    maxBlindReturnAmount: "0.0000",
    roundingIncrement: "0.0500",
    requireCustomerOver: null,
    maxCashInDrawer: null,
  },
  snapshotRevision: "1",
};

/** The catalogue the whole suite prices against. Every row is the shape 6A's `readCatalogue` emits:
 *  `to_jsonb(row) - 'tenant_id'`, so the keys are the PostgreSQL column names of 3A and 5A. */
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
      name_ar: "أرز ٥ كجم",
      kind: "product",
      base_unit_id: "unit-ea",
      track_lots: false,
      tax_code_id: "tax-std",
    },
  },
  {
    stream: "item",
    op: "upsert",
    id: "item-B",
    revision: 11n,
    row: {
      id: "item-B",
      code: "SKU-B",
      barcode: "9002",
      name_en: "Rice 10kg",
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
    id: "pl-retail",
    revision: 12n,
    row: {
      id: "pl-retail",
      code: "RETAIL",
      currency: "MYR",
      customer_kind: null, // a walk-in list: the till sells at the null trade level (POS-02)
      branch_id: null,
      valid_from: null,
      valid_to: null,
    },
  },
  {
    stream: "price_list",
    op: "upsert",
    id: "pl-branch",
    revision: 13n,
    row: {
      id: "pl-branch",
      code: "BR1",
      currency: "MYR",
      customer_kind: null, // a walk-in list: the till sells at the null trade level (POS-02)
      branch_id: "br-1",
      valid_from: null,
      valid_to: null,
    },
  },
  {
    stream: "price_list",
    op: "upsert",
    id: "pl-wholesale",
    revision: 14n,
    row: {
      id: "pl-wholesale",
      code: "WHOLE",
      currency: "MYR",
      customer_kind: "wholesale",
      branch_id: null,
      valid_from: null,
      valid_to: null,
    },
  },
  // RETAIL: 12.00 from 1, 11.00 from 10. BR1: 11.50 flat. WHOLE: 9.00 flat.
  {
    stream: "price_list_line",
    op: "upsert",
    id: "pll-1",
    revision: 15n,
    row: {
      id: "pll-1",
      price_list_id: "pl-retail",
      item_id: "item-A",
      unit_id: null,
      min_quantity: "0.000000",
      unit_price: "12.0000",
    },
  },
  {
    stream: "price_list_line",
    op: "upsert",
    id: "pll-2",
    revision: 16n,
    row: {
      id: "pll-2",
      price_list_id: "pl-retail",
      item_id: "item-A",
      unit_id: null,
      min_quantity: "10.000000",
      unit_price: "11.0000",
    },
  },
  {
    stream: "price_list_line",
    op: "upsert",
    id: "pll-3",
    revision: 17n,
    row: {
      id: "pll-3",
      price_list_id: "pl-branch",
      item_id: "item-A",
      unit_id: null,
      min_quantity: "0.000000",
      unit_price: "11.5000",
    },
  },
  {
    stream: "price_list_line",
    op: "upsert",
    id: "pll-4",
    revision: 18n,
    row: {
      id: "pll-4",
      price_list_id: "pl-wholesale",
      item_id: "item-A",
      unit_id: null,
      min_quantity: "0.000000",
      unit_price: "9.0000",
    },
  },
  {
    stream: "customer",
    op: "upsert",
    id: "cust-w",
    revision: 19n,
    row: {
      id: "cust-w",
      code: "C-WHOLE",
      name_en: "Wholesale Co",
      name_ar: null,
      phone: "0170000001",
      currency: "MYR",
      credit_limit: "5000.0000",
      credit_hold: false,
      customer_kind: "wholesale",
      price_list_id: "pl-wholesale",
    },
  },
  {
    stream: "tax_code",
    op: "upsert",
    id: "tax-std",
    revision: 20n,
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
    id: "policy-1",
    revision: 21n,
    row: {
      id: "policy-1",
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
});
afterEach(() => {
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A 10 % promotion on item-A with no start, as 6A's catalogue stream delivers it. */
const promotion = (id: string, revision: bigint, endsAt: string | null, branchId = "br-1") => ({
  stream: "promotion" as const,
  op: "upsert" as const,
  id,
  revision,
  row: {
    id,
    code: id.toUpperCase(),
    kind: "percent_off",
    branch_id: branchId,
    starts_at: null,
    ends_at: endsAt,
    definition: { itemIds: ["item-A"], percent: "0.100000" },
  },
});

describe("pricing at the till (§3.7.6 Pricing, spec:1345-1348)", () => {
  it("keeps adjacent quantity breaks exact when a float would merge them", async () => {
    db.raw.prepare("delete from catalogue_price_list_line where id='pll-3'").run();
    await store.applyChanges([
      {
        stream: "price_list_line",
        op: "upsert",
        id: "precise-break",
        revision: 99n,
        row: {
          id: "precise-break",
          price_list_id: "pl-retail",
          item_id: "item-A",
          unit_id: null,
          min_quantity: "9007199254740.000002",
          unit_price: "8.0000",
        },
      },
    ]);
    expect(
      resolvePrice(db, {
        itemId: "item-A",
        quantity: Quantity.of("9007199254740.000001"),
      }).unitPrice.toString(),
    ).toBe("11.0000");
    expect(
      resolvePrice(db, {
        itemId: "item-A",
        quantity: Quantity.of("9007199254740.000002"),
      }).unitPrice.toString(),
    ).toBe("8.0000");
  });

  it("uses explicit unit prices and applies shared exempt-code arithmetic", async () => {
    await store.applyChanges([
      {
        stream: "price_list_line",
        op: "upsert",
        id: "carton-price",
        revision: 98n,
        row: {
          id: "carton-price",
          price_list_id: "pl-branch",
          item_id: "item-A",
          unit_id: "unit-carton",
          min_quantity: "0.000000",
          unit_price: "100.0000",
        },
      },
      {
        stream: "tax_code",
        op: "upsert",
        id: "tax-exempt",
        revision: 99n,
        row: {
          id: "tax-exempt",
          code: "EXEMPT",
          rate: "0.10000000",
          kind: "exempt",
          rounding_mode: "HALF_AWAY_FROM_ZERO",
          output_account_id: null,
          input_account_id: null,
          effective_from: "2026-01-01",
          effective_to: null,
        },
      },
    ]);
    expect(
      resolvePrice(db, {
        itemId: "item-A",
        unitId: "unit-carton",
        quantity: Quantity.of("1.000000"),
      }).unitPrice.toString(),
    ).toBe("100.0000");
    expect(
      taxItemLine(db, {
        itemId: "item-A",
        gross: Money.of("100.0000", MYR),
        taxCodeId: "tax-exempt",
      }).tax.toString(),
    ).toBe("0.0000");
    expect(
      taxItemLine(db, { itemId: "item-A", gross: Money.of("100.0000", MYR), taxCodeId: null })
        .taxCodeId,
    ).toBeNull();
  });

  it("allows compatibility fallback only for an absent field and excludes archived codes", () => {
    db.raw
      .prepare(
        "update catalogue_item set row_json=json_remove(row_json,'$.tax_code_id') where id='item-B'",
      )
      .run();
    expect(taxItemLine(db, { itemId: "item-B", gross: Money.of("11.0000", MYR) }).taxCodeId).toBe(
      "tax-std",
    );
    db.raw
      .prepare("update catalogue_tax_code set archived_at='2026-01-01' where id='tax-std'")
      .run();
    expect(
      taxItemLine(db, { itemId: "item-B", gross: Money.of("11.0000", MYR) }).taxCodeId,
    ).toBeNull();
    expect(() => taxItemLine(db, { itemId: "item-A", gross: Money.of("11.0000", MYR) })).toThrow(
      "missing, archived or not effective",
    );
  });
  it("refuses to price on a till that has never pulled, with ERR_TILL_CATALOGUE_STALE", () => {
    const dir = mkdtempSync(join(tmpdir(), "dulja-till-"));
    dirs.push(dir);
    const fresh = openPosDatabase(join(dir, "till.sqlite"));
    let thrown: unknown;
    try {
      assertCatalogueFresh(fresh);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_TILL_CATALOGUE_STALE");
    fresh.close();
    // And the pulled one does not throw.
    expect(() => assertCatalogueFresh(db)).not.toThrow();
  });

  it("finds an item by barcode, which is all a keyboard-wedge scanner does (D18)", () => {
    expect(findItemByBarcode(db, "9001")?.code).toBe("SKU-A");
    expect(findItemByBarcode(db, "0000")).toBeNull();
  });

  it("searches by code and by BOTH names, so an Arabic-first shop can search at all", () => {
    expect(
      searchItems(db, "rice")
        .map((i) => i.code)
        .toSorted(),
    ).toEqual(["SKU-A", "SKU-B"]);
    expect(searchItems(db, "SKU-B").map((i) => i.code)).toEqual(["SKU-B"]);
    expect(searchItems(db, "أرز").map((i) => i.code)).toEqual(["SKU-A"]);
  });

  it("prefers the BRANCH price list over the company-wide one (spec:1312 'price list per shop')", () => {
    const q = resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("1.000000") });
    expect(q.unitPrice.toString()).toBe("11.5000");
    expect(q.priceListId).toBe("pl-branch");
    expect(q.source).toBe("price_list");
  });

  it("applies the highest quantity break at or below the line quantity", () => {
    // BR1 has one flat line, so the break test uses the customer whose list carries two.
    const one = resolvePrice(db, {
      itemId: "item-A",
      quantity: Quantity.of("1.000000"),
      customerId: null,
    });
    expect(one.unitPrice.toString()).toBe("11.5000");
    // Delete the branch list's line so RETAIL wins, and the two breaks become visible.
    db.raw.prepare("delete from catalogue_price_list_line where id = 'pll-3'").run();
    expect(
      resolvePrice(db, {
        itemId: "item-A",
        quantity: Quantity.of("9.000000"),
      }).unitPrice.toString(),
    ).toBe("12.0000");
    expect(
      resolvePrice(db, {
        itemId: "item-A",
        quantity: Quantity.of("10.000000"),
      }).unitPrice.toString(),
    ).toBe("11.0000");
    expect(
      resolvePrice(db, {
        itemId: "item-A",
        quantity: Quantity.of("500.000000"),
      }).unitPrice.toString(),
    ).toBe("11.0000");
  });

  it("prices a customer-specific list ahead of the branch list (A10b)", () => {
    const q = resolvePrice(db, {
      itemId: "item-A",
      quantity: Quantity.of("1.000000"),
      customerId: "cust-w",
    });
    expect(q.unitPrice.toString()).toBe("9.0000");
    expect(q.priceListId).toBe("pl-wholesale");
  });

  it("answers no_price with a ZERO price rather than a null, and never guesses", () => {
    const q = resolvePrice(db, { itemId: "item-B", quantity: Quantity.of("1.000000") });
    expect(q.source).toBe("no_price");
    expect(q.priceListId).toBeNull();
    expect(q.unitPrice.toString()).toBe("0.0000");
  });

  it("ignores a price list whose validity window has closed", () => {
    db.raw
      .prepare("update catalogue_price_list set valid_to = '2026-01-31' where id = 'pl-branch'")
      .run();
    const q = resolvePrice(db, {
      itemId: "item-A",
      quantity: Quantity.of("1.000000"),
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(q.priceListId).toBe("pl-retail");
    expect(q.unitPrice.toString()).toBe("12.0000");
  });

  it("applies a percent_off promotion inside its window and nothing outside it", async () => {
    await store.applyChanges([
      {
        stream: "promotion",
        op: "upsert",
        id: "pr-1",
        revision: 30n,
        row: {
          id: "pr-1",
          code: "JUNE10",
          kind: "percent_off",
          branch_id: null,
          starts_at: "2026-06-01T00:00:00.000Z",
          ends_at: "2026-06-30T23:59:59.000Z",
          definition: { itemIds: ["item-A"], percent: "0.100000" },
        },
      },
    ]);
    const inside = resolvePrice(db, {
      itemId: "item-A",
      quantity: Quantity.of("2.000000"),
      at: new Date("2026-06-15T10:00:00.000Z"),
    });
    // 11.5000 × 2 = 23.0000; 10 % of that is 2.3000.
    expect(inside.promotionId).toBe("pr-1");
    expect(inside.promotionDiscount.toString()).toBe("2.3000");
    const outside = resolvePrice(db, {
      itemId: "item-A",
      quantity: Quantity.of("2.000000"),
      at: new Date("2026-07-01T10:00:00.000Z"),
    });
    expect(outside.promotionId).toBeNull();
    expect(outside.promotionDiscount.toString()).toBe("0.0000");
  });

  it("applies amount_off per unit and bundle per whole group, and takes the LARGEST discount when two match", async () => {
    await store.applyChanges([
      {
        stream: "promotion",
        op: "upsert",
        id: "pr-amt",
        revision: 31n,
        row: {
          id: "pr-amt",
          code: "OFF50SEN",
          kind: "amount_off",
          branch_id: "br-1",
          starts_at: null,
          ends_at: null,
          definition: { itemIds: ["item-A"], amountPerUnit: "0.5000", currency: "MYR" },
        },
      },
      {
        stream: "promotion",
        op: "upsert",
        id: "pr-bundle",
        revision: 32n,
        row: {
          id: "pr-bundle",
          code: "3FOR30",
          kind: "bundle",
          branch_id: null,
          starts_at: null,
          ends_at: null,
          definition: {
            itemIds: ["item-A"],
            groupQuantity: "3.000000",
            groupPrice: "30.0000",
            currency: "MYR",
          },
        },
      },
    ]);
    // amount_off on 4 units: 4 × 0.5000 = 2.0000.
    // bundle on 4 units at 11.5000: one group of 3 costs 30.0000 instead of 34.5000 → 4.5000 off.
    const q = resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("4.000000") });
    expect(q.promotionId).toBe("pr-bundle");
    expect(q.promotionDiscount.toString()).toBe("4.5000");
    // Two units: bundle gives nothing (no complete group), amount_off gives 1.0000 and wins.
    const two = resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("2.000000") });
    expect(two.promotionId).toBe("pr-amt");
    expect(two.promotionDiscount.toString()).toBe("1.0000");
  });

  it("compares the window as instants: the exact end applies, and a +08:00 row is not shifted (PR 12 review)", async () => {
    // The mirror holds PostgreSQL's `to_jsonb(timestamptz)` text — no milliseconds, in the server session's
    // offset — and the till's clock is `toISOString()`. Compared as text, '+' sorts before '.', so the old
    // till dropped a promotion at the very instant its window still covered, and read a +08:00 window as if
    // it were UTC, eight hours late.
    await store.applyChanges([
      {
        stream: "promotion",
        op: "upsert",
        id: "pr-utc",
        revision: 34n,
        row: {
          id: "pr-utc",
          code: "JUNEUTC",
          kind: "percent_off",
          branch_id: null,
          starts_at: "2026-06-01T00:00:00+00:00",
          ends_at: "2026-06-30T23:59:59+00:00",
          definition: { itemIds: ["item-A"], percent: "0.100000" },
        },
      },
      {
        stream: "promotion",
        op: "upsert",
        id: "pr-kl",
        revision: 35n,
        row: {
          id: "pr-kl",
          code: "JULYKL",
          kind: "percent_off",
          branch_id: null,
          // 2026-07-01 00:00 to 23:59:59 in Kuala Lumpur: 2026-06-30T16:00Z to 2026-07-01T15:59:59Z.
          starts_at: "2026-07-01T00:00:00+08:00",
          ends_at: "2026-07-01T23:59:59.999999+08:00",
          definition: { itemIds: ["item-A"], percent: "0.200000" },
        },
      },
    ]);
    const at = (iso: string) =>
      resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("1.000000"), at: new Date(iso) });
    // The last instant of the UTC window: still June's 10 %, not nothing.
    expect(at("2026-06-30T15:59:59.999Z").promotionId).toBe("pr-utc");
    // From 16:00Z both windows cover, and the LARGEST wins (20 % of 11.5000).
    expect(at("2026-06-30T23:59:59.000Z").promotionId).toBe("pr-kl");
    expect(at("2026-06-30T23:59:59.000Z").promotionDiscount.toString()).toBe("2.3000");
    // KL's window runs to 15:59:59.999Z on 1 July, not to 23:59:59Z as its text would say.
    expect(at("2026-07-01T15:59:59.999Z").promotionId).toBe("pr-kl");
    expect(at("2026-07-01T16:00:00.000Z").promotionId).toBeNull();
    // And the UTC window's own end is inclusive.
    await store.applyChanges([
      { stream: "promotion", op: "delete", id: "pr-kl", revision: 36n, row: null },
    ]);
    expect(at("2026-06-30T23:59:59.000Z").promotionId).toBe("pr-utc");
    expect(at("2026-07-01T00:00:00.000Z").promotionId).toBeNull();
  });

  it("reads only promotions that can still be live, and never drops one a day behind in its offset (PR 12 review)", async () => {
    // 3A has no archived_at on a promotion: a retired one only has an ends_at in the past, and stays in the
    // mirror for good. Reading every one of them on every price made a sale cost lines × every promotion the
    // shop ever ran, on the sell keystroke. The SELECT now drops rows that ended days before the till's clock
    // and other branches' rows, and the instant comparison still decides everything it keeps.
    await store.applyChanges([
      promotion("pr-2025", 40n, "2025-12-31T23:59:59+00:00"),
      promotion("pr-retired", 41n, "2026-06-28T23:59:59+00:00"),
      // 2026-06-30 23:00 at UTC−12 is 2026-07-01T11:00Z: live at the till's 05:00Z, though its leading date is
      // a day behind the till's UTC date — the most any live row can be behind.
      promotion("pr-behind", 42n, "2026-06-30T23:00:00-12:00"),
      // Kept by the prefilter (its leading date is not two days behind) and refused by its instant.
      promotion("pr-yesterday", 43n, "2026-06-30T00:00:00+00:00"),
      promotion("pr-other-branch", 44n, null, "br-2"),
    ]);
    const prepare = db.raw.prepare.bind(db.raw);
    const read: string[][] = [];
    vi.spyOn(db.raw, "prepare").mockImplementation(((source: string) => {
      const statement = prepare(source);
      if (!source.includes("from catalogue_promotion")) return statement;
      const all = statement.all.bind(statement);
      return Object.assign(statement, {
        all: (...args: unknown[]) => {
          const rows = all(...(args as [])) as { id: string }[];
          read.push(rows.map((r) => r.id));
          return rows;
        },
      });
    }) as typeof db.raw.prepare);
    try {
      const q = resolvePrice(db, {
        itemId: "item-A",
        quantity: Quantity.of("1.000000"),
        at: new Date("2026-07-01T05:00:00.000Z"),
      });
      expect(q.promotionId).toBe("pr-behind");
      expect(q.promotionDiscount.toString()).toBe("1.1500");
      expect(read).toEqual([["pr-behind", "pr-yesterday"]]);
    } finally {
      vi.restoreAllMocks();
    }
    // Six hours later the same row has ended, by its instant and not by its text.
    expect(
      resolvePrice(db, {
        itemId: "item-A",
        quantity: Quantity.of("1.000000"),
        at: new Date("2026-07-01T11:00:00.001Z"),
      }).promotionId,
    ).toBeNull();
  });

  it("a promotion for a different branch is not applied — Form B down-syncs both, the till chooses", async () => {
    await store.applyChanges([
      {
        stream: "promotion",
        op: "upsert",
        id: "pr-b2",
        revision: 33n,
        row: {
          id: "pr-b2",
          code: "OTHER",
          kind: "percent_off",
          branch_id: "br-2",
          starts_at: null,
          ends_at: null,
          definition: { itemIds: ["item-A"], percent: "0.500000" },
        },
      },
    ]);
    expect(
      resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("1.000000") }).promotionId,
    ).toBeNull();
  });

  it("extracts tax from the gross with the CODE's rate and the CODE's rounding mode (5A's inclusive branch)", () => {
    // 11.5000 × 2 = 23.0000 gross; rate 0.10 → base = 23.0000 / 1.10 = 20.9091 (HALF_AWAY_FROM_ZERO),
    // tax = 23.0000 − 20.9091 = 2.0909. base + tax === gross EXACTLY, which is the property 6A's step (g)
    // compares against.
    const taxed = taxItemLine(db, { gross: Money.of("23.0000", MYR), itemId: "item-A" });
    expect(taxed.taxCodeId).toBe("tax-std");
    expect(taxed.base.toString()).toBe("20.9091");
    expect(taxed.tax.toString()).toBe("2.0909");
    expect(taxed.total.toString()).toBe("23.0000");
    expect(taxed.base.add(taxed.tax).toString()).toBe(taxed.total.toString());
  });

  it("an item with no tax code is taxed at nothing, and says so with a null code", () => {
    const taxed = taxItemLine(db, { gross: Money.of("10.0000", MYR), itemId: "item-B" });
    expect(taxed.taxCodeId).toBeNull();
    expect(taxed.tax.toString()).toBe("0.0000");
    expect(taxed.base.toString()).toBe("10.0000");
  });

  it("refuses a referenced tax code whose effective window has closed", () => {
    db.raw
      .prepare("update catalogue_tax_code set effective_to = '2026-01-31' where id = 'tax-std'")
      .run();
    expect(() =>
      taxItemLine(db, {
        gross: Money.of("23.0000", MYR),
        itemId: "item-A",
        at: new Date("2026-06-01T00:00:00.000Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "ERR_TILL_CATALOGUE_STALE" }));
  });

  it("counts only UNARCHIVED output codes: one archived and one live still resolves to the live one", async () => {
    // spec:2049 — master data is archived, never deleted (5A's `app.tax_code.archived_at`, 5A:591). A regime
    // that replaced one output rate with another leaves two rows whose effective windows both contain today.
    // Without `archived_at is null` the fallback would count 2, answer `null`, tax the line at nothing, and
    // 6A's step (g) would refuse every ticket in the shop — with the catalogue perfectly correct.
    await store.applyChanges([
      {
        stream: "tax_code",
        op: "upsert",
        id: "tax-old",
        revision: 99n,
        row: {
          id: "tax-old",
          code: "SYNTH-OUT-OLD",
          rate: "0.06000000",
          kind: "output",
          rounding_mode: "HALF_AWAY_FROM_ZERO",
          output_account_id: "acct-2300",
          input_account_id: null,
          effective_from: "2026-01-01",
          effective_to: null,
          archived_at: "2026-05-31T00:00:00.000Z",
        },
      },
    ]);
    expect(
      db.raw
        .prepare<[], { n: number }>(
          "select count(*) as n from catalogue_tax_code where kind = 'output'",
        )
        .get()!.n,
    ).toBe(2);
    const taxed = taxItemLine(db, { gross: Money.of("23.0000", MYR), itemId: "item-A" });
    expect(taxed.taxCodeId).toBe("tax-std"); // the LIVE code, at 10 %, not `null`
    expect(taxed.tax.toString()).toBe("2.0909");
  });

  it("a negative gross — a return line — extracts a negative tax with the same two calls", () => {
    const taxed = taxItemLine(db, { gross: Money.of("-23.0000", MYR), itemId: "item-A" });
    expect(taxed.base.toString()).toBe("-20.9091");
    expect(taxed.tax.toString()).toBe("-2.0909");
    expect(taxed.total.toString()).toBe("-23.0000");
  });

  it("priceCheck needs pos.price.check and writes NOTHING", () => {
    const before = db.raw
      .prepare<[], { n: number }>(
        "select (select count(*) from ticket) + (select count(*) from outbox) + (select count(*) from till_event) as n",
      )
      .get()!.n;
    const results = priceCheck(db, CASHIER, { barcode: "9001" });
    expect(results).toHaveLength(1);
    expect(results[0]!.item.code).toBe("SKU-A");
    expect(results[0]!.quote.unitPrice.toString()).toBe("11.5000");
    expect(results[0]!.taxed.total.toString()).toBe("11.5000");
    const after = db.raw
      .prepare<[], { n: number }>(
        "select (select count(*) from ticket) + (select count(*) from outbox) + (select count(*) from till_event) as n",
      )
      .get()!.n;
    expect(after).toBe(before);

    const noCode: TillCashier = { ...CASHIER, codes: ["pos.ticket.sell"] };
    expect(() => priceCheck(db, noCode, { barcode: "9001" })).toThrow(TillError);
    try {
      priceCheck(db, noCode, { barcode: "9001" });
    } catch (e) {
      expect((e as TillError).code).toBe("ERR_RBAC_FORBIDDEN");
    }
  });

  it("priceCheck quotes at quantity ONE, because a lookup is not a line", () => {
    // The break at 10 must not appear in a price check: the customer asked what one costs.
    db.raw.prepare("delete from catalogue_price_list_line where id = 'pll-3'").run();
    expect(priceCheck(db, CASHIER, { code: "SKU-A" })[0]!.quote.unitPrice.toString()).toBe(
      "12.0000",
    );
  });

  it("priceCheck by free text returns every match, so a cashier can pick", () => {
    expect(
      priceCheck(db, CASHIER, { text: "rice" })
        .map((r) => r.item.code)
        .toSorted(),
    ).toEqual(["SKU-A", "SKU-B"]);
  });
});

const priceListChange = (
  id: string,
  code: string,
  cur: string,
  kind: string | null,
  revision: bigint,
) => ({
  stream: "price_list" as const,
  op: "upsert" as const,
  id,
  revision,
  row: {
    id,
    code,
    currency: cur,
    customer_kind: kind,
    branch_id: null,
    valid_from: null,
    valid_to: null,
  },
});
const priceLineChange = (id: string, listId: string, price: string, revision: bigint) => ({
  stream: "price_list_line" as const,
  op: "upsert" as const,
  id,
  revision,
  row: {
    id,
    price_list_id: listId,
    item_id: "item-A",
    unit_id: null,
    min_quantity: "0.000000",
    unit_price: price,
  },
});

describe("the till resolves a price list exactly as the server does (POS-02, POS-16; ADR 0057)", () => {
  const one = Quantity.of("1.000000");
  it("never prices a walk-in from a wholesale list, even when it is the only list with a line", () => {
    db.raw
      .prepare("delete from catalogue_price_list_line where price_list_id <> 'pl-wholesale'")
      .run();
    const q = resolvePrice(db, { itemId: "item-A", quantity: one });
    expect(q.priceListId).toBeNull();
    expect(q.source).toBe("no_price");
    // The customer whose own list it is still gets it (A10b).
    expect(
      resolvePrice(db, { itemId: "item-A", quantity: one, customerId: "cust-w" }).priceListId,
    ).toBe("pl-wholesale");
  });

  it("never prices a walk-in from a trade-level list whose code sorts first", async () => {
    await store.applyChanges([
      priceListChange("pl-aaa", "AAA", "MYR", "wholesale", 40n),
      priceLineChange("pll-aaa", "pl-aaa", "1.0000", 41n),
    ]);
    db.raw.prepare("delete from catalogue_price_list_line where price_list_id = 'pl-branch'").run();
    const q = resolvePrice(db, { itemId: "item-A", quantity: one });
    expect(q.priceListId).toBe("pl-retail");
    expect(q.unitPrice.toString()).toBe("12.0000");
  });

  it("a foreign-currency list with a trade level neither sets the till's currency nor prices a walk-in", async () => {
    await store.applyChanges([
      priceListChange("pl-usd", "AAA-USD", "USD", "export", 42n),
      priceLineChange("pll-usd", "pl-usd", "2.0000", 43n),
    ]);
    // Company-wide lists only, so the foreign list's code sorts first among them.
    db.raw.prepare("delete from catalogue_price_list where id = 'pl-branch'").run();
    expect(tillCurrency(db)).toBe("MYR");
    const q = resolvePrice(db, { itemId: "item-A", quantity: one });
    expect(q.unitPrice.currency).toBe("MYR");
    expect(q.priceListId).toBe("pl-retail");
  });

  it("refuses, rather than guesses, when the walk-in lists disagree on the currency", async () => {
    await store.applyChanges([priceListChange("pl-usd", "AAA-USD", "USD", null, 42n)]);
    expect(() => tillCurrency(db)).toThrow(TillError);
    expect(() => resolvePrice(db, { itemId: "item-A", quantity: one })).toThrow(/currency/);
  });

  it("orders a unit-specific line ahead of a larger base-unit break, as the server's resolver does", async () => {
    db.raw.prepare("delete from catalogue_price_list_line where id = 'pll-3'").run();
    // RETAIL carries base-unit (null) lines 12.00 from 1 and 11.00 from 10; add an explicit-unit line at 12.50.
    await store.applyChanges([
      {
        stream: "price_list_line",
        op: "upsert",
        id: "pll-explicit",
        revision: 44n,
        row: {
          id: "pll-explicit",
          price_list_id: "pl-retail",
          item_id: "item-A",
          unit_id: "unit-ea",
          min_quantity: "1.000000",
          unit_price: "12.5000",
        },
      },
    ]);
    const base = db.raw
      .prepare<[], { base_unit_id: string }>(
        "select base_unit_id from catalogue_item where id = 'item-A'",
      )
      .get()!;
    expect(base.base_unit_id).toBe("unit-ea");
    const q = resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("10.000000") });
    expect(q.unitPrice.toString()).toBe("12.5000");
  });

  it("keeps the branch's own lists and promotions when the branch has no POS policy row (POS-16)", async () => {
    db.raw.prepare("delete from catalogue_branch_pos_policy").run();
    db.raw.prepare("insert or replace into meta (key, value) values ('branch_id', 'br-1')").run();
    await store.applyChanges([promotion("promo-br", 45n, null)]);
    const q = resolvePrice(db, { itemId: "item-A", quantity: one });
    expect(q.priceListId).toBe("pl-branch");
    expect(q.promotionId).toBe("promo-br");
  });
});
