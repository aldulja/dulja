import { currency, Money, Quantity } from "@dulja/domain";
import { describe, expect, it } from "vitest";
import {
  replayLegacyMovements,
  sortLegacyMovements,
  type LegacyMovement,
  type OpeningPosition,
} from "../../src/load/recost";

const MYR = currency("MYR");
const m = (over: Partial<LegacyMovement>): LegacyMovement => ({
  sourceKey: "1",
  itemKey: "10",
  warehouseKey: "1",
  lotKey: null,
  effectiveDate: "2025-06-01",
  sequence: 1n,
  lineNo: 1,
  direction: "in",
  quantity: Quantity.of("10.000000"),
  value: Money.of("100.0000", MYR),
  ...over,
});

/** One position as text, so a failure prints the whole figure. */
const show = (p: OpeningPosition): string =>
  `${p.itemKey}/${p.warehouseKey}/${p.lotKey ?? "-"}:${p.quantity.toString()}@${p.unitCost.toString()}=${p.value.toString()}`;

describe("replayLegacyMovements — §5.1 #6, through 3B's one costing engine", () => {
  it("sorts by the §4.3.5 chronological key (effective_date, sequence, line_no)", () => {
    const out = sortLegacyMovements([
      m({ effectiveDate: "2025-06-02", sequence: 1n, lineNo: 1 }),
      m({ effectiveDate: "2025-06-01", sequence: 9n, lineNo: 1 }),
      m({ effectiveDate: "2025-06-01", sequence: 2n, lineNo: 2 }),
      m({ effectiveDate: "2025-06-01", sequence: 2n, lineNo: 1 }),
    ]);
    expect(out.map((x) => `${x.effectiveDate}/${x.sequence}/${x.lineNo}`)).toEqual([
      "2025-06-01/2/1",
      "2025-06-01/2/2",
      "2025-06-01/9/1",
      "2025-06-02/1/1",
    ]);
  });

  it("opens the AVCO survivors as one position per (item, warehouse, lot) — the history is re-costed by the 3B engine, never carried (acceptance test 5, re-run)", () => {
    const out = replayLegacyMovements(
      [
        m({ sequence: 1n, quantity: Quantity.of("10.000000"), value: Money.of("100.0000", MYR) }), // 10 @ 10.00
        m({ sequence: 2n, quantity: Quantity.of("10.000000"), value: Money.of("140.0000", MYR) }), // 10 @ 14.00
        m({ sequence: 3n, direction: "out", quantity: Quantity.of("5.000000"), value: null }), // issue 5
      ],
      "avco",
      MYR,
    );
    expect(out.movementsReplayed).toBe(3);
    expect(out.positions.map(show)).toEqual(["10/1/-:15.000000@12.0000=180.0000"]);
    expect(out.negatives).toEqual([]);
  });

  it("keeps each batch its own position and quantity, at the value its layers carry", () => {
    const out = replayLegacyMovements(
      [
        m({ lotKey: "9000", quantity: Quantity.of("4.000000"), value: Money.of("40.0000", MYR) }),
        m({
          lotKey: "9001",
          sequence: 2n,
          quantity: Quantity.of("4.000000"),
          value: Money.of("60.0000", MYR),
        }),
      ],
      "avco",
      MYR,
    );
    expect(out.positions.map(show)).toEqual([
      "10/1/9000:4.000000@10.0000=40.0000",
      "10/1/9001:4.000000@15.0000=60.0000",
    ]);
  });

  it("costs an item in a warehouse as ONE pool across its batches, as applyMovements does (§4.7.1: open layers are never per lot)", () => {
    // Posted in Dulja, the issue of 4 from batch 9000 takes a proportional slice of BOTH layers (AVCO), so what is
    // left is 2 of the 10.00 layer and 2 of the 15.00 layer — 50.0000 — all of it standing in batch 9001. Costing each
    // batch apart would open 9001 at 60.0000, a valuation Dulja itself would never have reached.
    const out = replayLegacyMovements(
      [
        m({ lotKey: "9000", quantity: Quantity.of("4.000000"), value: Money.of("40.0000", MYR) }),
        m({
          lotKey: "9001",
          sequence: 2n,
          quantity: Quantity.of("4.000000"),
          value: Money.of("60.0000", MYR),
        }),
        m({
          lotKey: "9000",
          sequence: 3n,
          direction: "out",
          quantity: Quantity.of("4.000000"),
          value: null,
        }),
      ],
      "avco",
      MYR,
    );
    expect(out.positions.map(show)).toEqual(["10/1/9001:4.000000@12.5000=50.0000"]);
  });

  it("under FIFO keeps every surviving layer's own cost, oldest first, so the opening consumes in the order the history would have", () => {
    const out = replayLegacyMovements(
      [
        m({ sequence: 1n, quantity: Quantity.of("10.000000"), value: Money.of("100.0000", MYR) }),
        m({ sequence: 2n, quantity: Quantity.of("10.000000"), value: Money.of("140.0000", MYR) }),
        m({ sequence: 3n, direction: "out", quantity: Quantity.of("5.000000"), value: null }),
      ],
      "fifo",
      MYR,
    );
    expect(out.positions.map(show)).toEqual([
      "10/1/-:5.000000@10.0000=50.0000",
      "10/1/-:10.000000@14.0000=140.0000",
    ]);
  });

  it("reports a position the legacy history drove negative rather than opening it (acceptance test 18, re-run)", () => {
    const out = replayLegacyMovements(
      [
        m({ sequence: 1n, quantity: Quantity.of("2.000000"), value: Money.of("20.0000", MYR) }),
        m({ sequence: 2n, direction: "out", quantity: Quantity.of("5.000000"), value: null }),
      ],
      "avco",
      MYR,
    );
    expect(out.positions).toEqual([]);
    expect(out.negatives).toEqual([
      { itemKey: "10", warehouseKey: "1", lotKey: null, quantity: "-3.000000" },
    ]);
    expect(out.movementsReplayed).toBe(2);
  });

  it("drops every batch of the pool when one batch goes negative — their cost is one pool, and the history cannot be replayed under Dulja's rules", () => {
    const out = replayLegacyMovements(
      [
        m({ lotKey: "9000", quantity: Quantity.of("4.000000"), value: Money.of("40.0000", MYR) }),
        m({
          lotKey: "9001",
          sequence: 2n,
          quantity: Quantity.of("4.000000"),
          value: Money.of("60.0000", MYR),
        }),
        m({
          lotKey: "9001",
          sequence: 3n,
          direction: "out",
          quantity: Quantity.of("5.000000"),
          value: null,
        }),
        // Another item in the same warehouse is untouched by the failure.
        m({ itemKey: "11", sequence: 4n, quantity: Quantity.of("1.000000") }),
      ],
      "avco",
      MYR,
    );
    expect(out.positions.map(show)).toEqual(["11/1/-:1.000000@100.0000=100.0000"]);
    expect(out.negatives).toEqual([
      { itemKey: "10", warehouseKey: "1", lotKey: "9001", quantity: "-1.000000" },
    ]);
  });

  it("drops a position that nets to exactly zero — an opening of nothing is not an opening", () => {
    const out = replayLegacyMovements(
      [
        m({ sequence: 1n, quantity: Quantity.of("3.000000"), value: Money.of("30.0000", MYR) }),
        m({ sequence: 2n, direction: "out", quantity: Quantity.of("3.000000"), value: null }),
      ],
      "avco",
      MYR,
    );
    expect(out.positions).toEqual([]);
    expect(out.negatives).toEqual([]);
  });

  it("refuses a receipt with no value rather than costing it at zero (LEGACY-011)", () => {
    expect(() => replayLegacyMovements([m({ value: null })], "avco", MYR)).toThrow(
      // A string, not a regex literal: `dependency-rule`'s token scanner stalls on `#6` after an escaped `\/` in one.
      "ERR_VALIDATION_FAILED: legacy receipt 10/1 on 2025-06-01 has no value; a receipt with no cost is never costed at zero (LEGACY-011, §5.1 #6)",
    );
  });

  it("refuses a movement of no quantity or of a negative one — the direction is the flag's, never the sign's", () => {
    expect(() =>
      replayLegacyMovements([m({ quantity: Quantity.of("0.000000") })], "avco", MYR),
    ).toThrow(
      /^ERR_VALIDATION_FAILED: legacy movement BILLITEMS\/1 \(item 10, warehouse 1, 2025-06-01\) has quantity 0\.000000;/,
    );
    expect(() =>
      replayLegacyMovements([m({ quantity: Quantity.of("-1.000000") })], "avco", MYR),
    ).toThrow(/has quantity -1\.000000;/);
  });

  it("raises the engine's own refusal as a load error naming the legacy row (a negative receipt value)", () => {
    expect(() =>
      replayLegacyMovements([m({ value: Money.of("-1.0000", MYR) })], "avco", MYR),
    ).toThrow(
      /^ERR_VALIDATION_FAILED: legacy movement BILLITEMS\/1 \(item 10, warehouse 1, 2025-06-01\) cannot be costed: ERR_COST_NEGATIVE: /,
    );
  });

  it("refuses a value in another currency than the company's base", () => {
    expect(() =>
      replayLegacyMovements([m({ value: Money.of("1.0000", currency("USD")) })], "avco", MYR),
    ).toThrow(/is in USD; the replay costs in the company's base currency MYR/);
  });
});
