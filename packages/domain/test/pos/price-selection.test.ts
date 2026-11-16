import { describe, expect, it } from "vitest";
import { selectPrice, type PriceListCandidate, type PriceListLineCandidate } from "../../src/index";

const list = (id: string, over: Partial<PriceListCandidate> = {}): PriceListCandidate => ({
  id,
  code: id.toUpperCase(),
  currency: "MYR",
  customerKind: null,
  branchId: null,
  validFrom: null,
  validTo: null,
  ...over,
});
const line = (
  id: string,
  priceListId: string,
  over: Partial<PriceListLineCandidate> = {},
): PriceListLineCandidate => ({
  id,
  priceListId,
  itemId: "item",
  unitId: null,
  minQuantity: "0.000000",
  unitPrice: "1.0000",
  ...over,
});
const q = {
  itemId: "item",
  currency: "MYR",
  quantity: "1.000000",
  on: "2026-06-01",
  unitId: "pc",
  customerKind: null,
  branchId: "br",
};
const pick = (lists: PriceListCandidate[], lines: PriceListLineCandidate[], over = {}) =>
  selectPrice(lists, lines, { ...q, ...over })?.line.id ?? null;

describe("selectPrice — the server resolver's rule, shared with the till (POS-02)", () => {
  it("admits only the query's currency, window, branch and trade level", () => {
    expect(pick([list("a", { currency: "USD" })], [line("x", "a")])).toBeNull();
    expect(pick([list("a", { validFrom: "2026-06-02" })], [line("x", "a")])).toBeNull();
    expect(pick([list("a", { validTo: "2026-05-31" })], [line("x", "a")])).toBeNull();
    expect(
      pick([list("a", { validFrom: "2026-06-01", validTo: "2026-06-01" })], [line("x", "a")]),
    ).toBe("x");
    expect(pick([list("a", { branchId: "other" })], [line("x", "a")])).toBeNull();
    expect(pick([list("a", { customerKind: "wholesale" })], [line("x", "a")])).toBeNull();
    expect(
      pick([list("a", { customerKind: "wholesale" })], [line("x", "a")], {
        customerKind: "wholesale",
      }),
    ).toBe("x");
  });

  it("admits a line for the item whose unit is null or the query's and whose break is reached", () => {
    expect(pick([list("a")], [line("x", "a", { itemId: "other" })])).toBeNull();
    expect(pick([list("a")], [line("x", "a", { unitId: "ctn" })])).toBeNull();
    expect(pick([list("a")], [line("x", "a", { minQuantity: "1.000001" })])).toBeNull();
    expect(pick([list("a")], [line("x", "a", { unitId: "pc" })], { unitId: null })).toBeNull();
  });

  it("orders branch, then trade level, then unit, then the largest break, then the code", () => {
    const lists = [
      list("b"),
      list("a"),
      list("br", { branchId: "br" }),
      list("k", { customerKind: "k" }),
    ];
    expect(pick(lists, [line("a1", "a"), line("br1", "br")])).toBe("br1");
    expect(pick(lists, [line("a1", "a"), line("k1", "k")], { customerKind: "k" })).toBe("k1");
    expect(
      pick(lists, [
        line("a1", "a", { minQuantity: "1.000000" }),
        line("a2", "a", { unitId: "pc" }),
      ]),
    ).toBe("a2");
    expect(pick(lists, [line("a1", "a"), line("a2", "a", { minQuantity: "1.000000" })])).toBe("a2");
    expect(pick(lists, [line("b1", "b"), line("a1", "a")])).toBe("a1");
  });
});
