import { describe, expect, it } from "vitest";
import { currency, Money, promotionActiveAt, promotionDiscount, Quantity } from "../../src/index";

const MYR = currency("MYR");
const line = (unitPrice: string, quantity: string, itemId = "item-A") => ({
  itemId,
  unitPrice: Money.of(unitPrice, MYR),
  quantity: Quantity.of(quantity),
});

describe("promotionDiscount — the one arithmetic the till prices with and the server verifies with", () => {
  it("percent_off takes the fraction of the line gross, rounded once", () => {
    const terms = { kind: "percent_off", definition: { itemIds: ["item-A"], percent: "0.100000" } };
    expect(promotionDiscount(terms, line("11.5000", "2.000000")).toString()).toBe("2.3000");
    // A return's negative quantity is discounted by its magnitude, never negatively.
    expect(promotionDiscount(terms, line("11.5000", "-2.000000")).toString()).toBe("2.3000");
    expect(promotionDiscount(terms, line("3.3300", "0.100000")).toString()).toBe("0.0333");
  });

  it("amount_off is per unit and bundle per complete group, each in the promotion's own currency", () => {
    const amount = {
      kind: "amount_off",
      definition: { itemIds: ["item-A"], amountPerUnit: "0.5000", currency: "MYR" },
    };
    expect(promotionDiscount(amount, line("11.5000", "4.000000")).toString()).toBe("2.0000");
    const bundle = {
      kind: "bundle",
      definition: {
        itemIds: ["item-A"],
        groupQuantity: "3.000000",
        groupPrice: "30.0000",
        currency: "MYR",
      },
    };
    expect(promotionDiscount(bundle, line("11.5000", "4.000000")).toString()).toBe("4.5000");
    expect(promotionDiscount(bundle, line("11.5000", "2.000000")).toString()).toBe("0.0000");
    expect(
      promotionDiscount(
        { kind: "amount_off", definition: { ...amount.definition, currency: "USD" } },
        line("11.5000", "1.000000"),
      ).toString(),
    ).toBe("0.0000");
  });

  it("never exceeds the line gross and never goes negative", () => {
    const big = {
      kind: "amount_off",
      definition: { itemIds: ["item-A"], amountPerUnit: "20.0000", currency: "MYR" },
    };
    expect(promotionDiscount(big, line("11.5000", "1.000000")).toString()).toBe("11.5000");
    const dearBundle = {
      kind: "bundle",
      definition: {
        itemIds: ["item-A"],
        groupQuantity: "2.000000",
        groupPrice: "30.0000",
        currency: "MYR",
      },
    };
    expect(promotionDiscount(dearBundle, line("11.5000", "2.000000")).toString()).toBe("0.0000");
  });

  it("is zero, never a guess, for another item, an unknown kind or a malformed definition", () => {
    const ok = { itemIds: ["item-A"], percent: "0.100000" };
    for (const terms of [
      { kind: "percent_off", definition: ok, item: "item-B" },
      { kind: "buy_one_get_one", definition: ok },
      { kind: "percent_off", definition: null },
      { kind: "percent_off", definition: [ok] },
      { kind: "percent_off", definition: { itemIds: "item-A", percent: "0.1" } },
      { kind: "percent_off", definition: { itemIds: ["item-A"], percent: 0.1 } },
      { kind: "percent_off", definition: { itemIds: ["item-A"], percent: "-0.1" } },
      { kind: "percent_off", definition: { itemIds: ["item-A"], percent: "1e-1" } },
      {
        kind: "amount_off",
        definition: { itemIds: ["item-A"], amountPerUnit: "0.12345", currency: "MYR" },
      },
      {
        kind: "amount_off",
        definition: { itemIds: ["item-A"], amountPerUnit: "0.5000", currency: "myr" },
      },
      {
        kind: "bundle",
        definition: {
          itemIds: ["item-A"],
          groupQuantity: "0",
          groupPrice: "1.0000",
          currency: "MYR",
        },
      },
    ] as { kind: string; definition: unknown; item?: string }[]) {
      expect(
        promotionDiscount(terms, line("11.5000", "3.000000", terms.item ?? "item-A")).toString(),
        JSON.stringify(terms),
      ).toBe("0.0000");
    }
  });
});

describe("promotionActiveAt — instants, never text (PR 12 review)", () => {
  const window = { startsAt: "2026-06-01T00:00:00+00:00", endsAt: "2026-06-30T23:59:59+00:00" };
  it("includes both ends, which a text comparison against toISOString() dropped at the end", () => {
    // As text, '2026-06-30T23:59:59+00:00' < '2026-06-30T23:59:59.000Z', so the old till dropped the
    // promotion at the very instant it was still meant to apply.
    const [mirrored, tillClock] = ["2026-06-30T23:59:59+00:00", "2026-06-30T23:59:59.000Z"];
    expect([tillClock, mirrored].toSorted()).toEqual([mirrored, tillClock]);
    expect(promotionActiveAt(window, new Date("2026-06-30T23:59:59.000Z"))).toBe(true);
    expect(promotionActiveAt(window, new Date("2026-06-01T00:00:00.000Z"))).toBe(true);
    expect(promotionActiveAt(window, new Date("2026-07-01T00:00:00.000Z"))).toBe(false);
    expect(promotionActiveAt(window, "2026-05-31T23:59:59.999Z")).toBe(false);
  });

  it("reads a non-UTC offset as the instant it names, not as hours early or late", () => {
    // 2026-07-01T07:59:59+08:00 is 2026-06-30T23:59:59Z.
    const local = { startsAt: "2026-06-01T08:00:00+08:00", endsAt: "2026-07-01T07:59:59+08:00" };
    expect(promotionActiveAt(local, new Date("2026-06-30T23:59:59.000Z"))).toBe(true);
    expect(promotionActiveAt(local, new Date("2026-07-01T00:00:00.000Z"))).toBe(false);
    expect(promotionActiveAt(local, new Date("2026-06-01T00:00:00.000Z"))).toBe(true);
    expect(promotionActiveAt(local, new Date("2026-05-31T23:59:59.000Z"))).toBe(false);
  });

  it("truncates microseconds to the millisecond, treats NULL as open and an unreadable bound as closed", () => {
    const micro = { startsAt: null, endsAt: "2026-06-30T23:59:59.999999+00:00" };
    expect(promotionActiveAt(micro, new Date("2026-06-30T23:59:59.999Z"))).toBe(true);
    expect(promotionActiveAt({ startsAt: null, endsAt: null }, new Date(0))).toBe(true);
    expect(promotionActiveAt({ startsAt: "not a time", endsAt: null }, new Date())).toBe(false);
    expect(promotionActiveAt({ startsAt: null, endsAt: null }, "not a time")).toBe(false);
  });
});
