import { describe, expect, it } from "vitest";
import {
  costingEngine,
  currency,
  MIN_MEANINGFUL_QTY,
  Money,
  Quantity,
  type CostingInput,
  type CurrencyCode,
  type Layer,
} from "../../src/index";

const MYR = currency("MYR");
const money = (v: string) => Money.of(v, MYR);
const qty = (v: string) => Quantity.of(v);

/** A layer as `applyMovements` reads one back: chronological, open, in base currency. */
function layer(over: {
  id: string;
  qtyIn: string;
  unitCost: string;
  value?: string;
  qtyRemaining: string;
  seq: number;
  effectiveDate?: string;
  lineNo?: number;
  movementNo?: number;
}): Layer {
  return {
    id: over.id,
    itemId: "item-1",
    warehouseId: "wh-1",
    lotId: "lot-1",
    movementId: `mv-${over.id}`,
    qtyIn: qty(over.qtyIn),
    value:
      over.value === undefined
        ? money(over.unitCost).multiply(qty(over.qtyIn).toDecimal(), "HALF_AWAY_FROM_ZERO")
        : money(over.value),
    unitCost: money(over.unitCost),
    qtyRemaining: qty(over.qtyRemaining),
    effectiveDate: over.effectiveDate ?? "2026-01-01",
    postingSeq: BigInt(over.seq),
    lineNo: over.lineNo ?? 1,
    movementNo: over.movementNo ?? 1,
  };
}

function issue(
  quantity: string,
  openLayers: Layer[],
  over: Partial<CostingInput> = {},
): CostingInput {
  return {
    method: "avco",
    openLayers,
    allowShortfall: false,
    movement: {
      lineNo: 1,
      movementNo: 1,
      itemId: "item-1",
      warehouseId: "wh-1",
      lotId: "lot-1",
      quantity: qty(quantity),
      effect: "issue",
      value: null,
      costing: "consume_layers",
      effectiveDate: "2026-02-01",
      postingSeq: 10n,
      movementId: "mv-issue",
    },
    ...over,
  };
}

function receipt(
  quantity: string,
  value: string | null,
  over: Partial<CostingInput> = {},
): CostingInput {
  return {
    method: "avco",
    openLayers: [],
    allowShortfall: false,
    movement: {
      lineNo: 1,
      movementNo: 1,
      itemId: "item-1",
      warehouseId: "wh-1",
      lotId: "lot-1",
      quantity: qty(quantity),
      effect: "receipt",
      value: value === null ? null : money(value),
      costing: "create_layer",
      effectiveDate: "2026-01-15",
      postingSeq: 5n,
      movementId: "mv-receipt",
    },
    ...over,
  };
}

describe("costingEngine — the ONE implementation (spec:1228; LEGACY-009)", () => {
  it("a receipt creates one layer at value ÷ quantity and consumes nothing", () => {
    const out = costingEngine.cost(receipt("100.000000", "1000.0000"));
    expect(out.value.toString()).toBe("1000.0000");
    expect(out.unitCost.toString()).toBe("10.0000");
    expect(out.consumptions).toEqual([]);
    expect(out.updatedRemaining).toEqual([]);
    expect(out.newLayer).not.toBeNull();
    expect(out.newLayer!.qtyIn.toString()).toBe("100.000000");
    expect(out.newLayer!.qtyRemaining.toString()).toBe("100.000000");
    expect(out.newLayer!.unitCost.toString()).toBe("10.0000");
    expect(out.newLayer!.movementId).toBe("mv-receipt");
    expect(out.newLayer!.postingSeq).toBe(5n);
  });

  it("AVCO issues at the running average and takes a proportional slice of EVERY open layer (spec:1218)", () => {
    // 100 @ 10 and 100 @ 20 → average 15. Issue 50 → value 750, 25 from each layer.
    const layers = [
      layer({
        id: "L1",
        qtyIn: "100.000000",
        unitCost: "10.0000",
        qtyRemaining: "100.000000",
        seq: 1,
      }),
      layer({
        id: "L2",
        qtyIn: "100.000000",
        unitCost: "20.0000",
        qtyRemaining: "100.000000",
        seq: 2,
      }),
    ];
    const out = costingEngine.cost(issue("50.000000", layers));
    expect(out.unitCost.toString()).toBe("15.0000");
    expect(out.value.toString()).toBe("750.0000");
    expect(
      out.consumptions.map((c) => [
        c.layerId,
        c.quantity.toString(),
        c.unitCost.toString(),
        c.value.toString(),
      ]),
    ).toEqual([
      ["L1", "25.000000", "15.0000", "375.0000"],
      ["L2", "25.000000", "15.0000", "375.0000"],
    ]);
    expect(out.updatedRemaining).toEqual([
      { layerId: "L1", qtyRemaining: qty("75.000000") },
      { layerId: "L2", qtyRemaining: qty("75.000000") },
    ]);
    expect(out.newLayer).toBeNull();
  });

  it("the proportional split closes exactly — Σ consumed quantity = the issue, Σ value = the value", () => {
    // Three layers of coprime remainders and a quantity that cannot divide evenly: the largest-remainder
    // split must still close, or a residue would sit on the layers that no later issue could clear.
    const layers = [
      layer({ id: "L1", qtyIn: "7.000000", unitCost: "3.0000", qtyRemaining: "7.000000", seq: 1 }),
      layer({
        id: "L2",
        qtyIn: "11.000000",
        unitCost: "5.0000",
        qtyRemaining: "11.000000",
        seq: 2,
      }),
      layer({
        id: "L3",
        qtyIn: "13.000000",
        unitCost: "7.0000",
        qtyRemaining: "13.000000",
        seq: 3,
      }),
    ];
    const out = costingEngine.cost(issue("10.000000", layers));
    const totalQty = out.consumptions.reduce((a, c) => a.add(c.quantity), Quantity.zero());
    // `Money.zero<CurrencyCode>(MYR)`, never a bare `Money.zero(MYR)`: `currency()` has a `const` type
    // parameter, so `MYR` is `CurrencyCode & "MYR"` and a bare seed makes the reduce accumulator
    // `Money<CurrencyCode & "MYR">` — while `Consumption.value` is the wide `Money<CurrencyCode>`, so
    // `a.add(c.value)` is a compile error. The explicit argument widens the seed instead. 1A hit this exact
    // trap and records the same fix (1a:1572–1577).
    const totalValue = out.consumptions.reduce(
      (a, c) => a.add(c.value),
      Money.zero<CurrencyCode>(MYR),
    );
    expect(totalQty.toString()).toBe("10.000000");
    expect(totalValue.toString()).toBe(out.value.toString());
  });

  it("a layer whose proportional share floors to zero gets no consumption row, and the values still close", () => {
    // The oldest layer holds one micro-unit beside two of a hundred. 1.000000 split by weight gives it
    // 1_000_000 × 1 ÷ 200_000_001 = 0 micro-units, so it must receive neither a consumption row nor an
    // allocation weight — Σ consumption value has to equal out.value exactly, or COST_LAYER_CHECK's sibling
    // invariant and legacy-009's tie-out both drift by the difference.
    const layers = [
      layer({
        id: "TINY",
        qtyIn: "0.000001",
        unitCost: "1.0000",
        qtyRemaining: "0.000001",
        seq: 1,
        effectiveDate: "2026-01-01",
      }),
      layer({
        id: "BIG1",
        qtyIn: "100.000000",
        unitCost: "10.0000",
        qtyRemaining: "100.000000",
        seq: 2,
        effectiveDate: "2026-01-02",
      }),
      layer({
        id: "BIG2",
        qtyIn: "100.000000",
        unitCost: "20.0000",
        qtyRemaining: "100.000000",
        seq: 3,
        effectiveDate: "2026-01-03",
      }),
    ];
    const out = costingEngine.cost(issue("1.000000", layers));
    expect(out.consumptions.map((c) => c.layerId)).toEqual(["BIG1", "BIG2"]);
    expect(
      out.consumptions.reduce((a, c) => a.add(c.value), Money.zero<CurrencyCode>(MYR)).toString(),
    ).toBe(out.value.toString());
    expect(out.consumptions.reduce((a, c) => a.add(c.quantity), Quantity.zero()).toString()).toBe(
      "1.000000",
    );
    // the tiny layer is untouched — it keeps its micro-unit and appears in no updatedRemaining entry
    expect(out.updatedRemaining.map((u) => u.layerId)).toEqual(["BIG1", "BIG2"]);
  });

  it("`average` is Σ(qtyRemaining × unitCost) ÷ Σ qtyRemaining and needs no layer to have a currency", () => {
    const layers = [
      layer({
        id: "L1",
        qtyIn: "100.000000",
        unitCost: "10.0000",
        qtyRemaining: "40.000000",
        seq: 1,
      }),
      layer({
        id: "L2",
        qtyIn: "100.000000",
        unitCost: "20.0000",
        qtyRemaining: "60.000000",
        seq: 2,
      }),
    ];
    expect(costingEngine.average(layers, MYR).toString()).toBe("16.0000");
    expect(costingEngine.average([], MYR).toString()).toBe("0.0000");
  });

  it("MIN_MEANINGFUL_QTY is one micro-unit and is exported, not retyped (spec:1227)", () => {
    expect(MIN_MEANINGFUL_QTY.toString()).toBe("0.000001");
  });

  it("a receipt with no value is refused — value is mandatory on every movement (LEGACY-007)", () => {
    expect(() => costingEngine.cost(receipt("10.000000", null))).toThrow(
      /ERR_COST_VALUE_MISSING.*carries no value/s,
    );
  });

  it("is pure — the same input twice gives byte-identical output", () => {
    const layers = [
      layer({ id: "L1", qtyIn: "3.000000", unitCost: "1.3333", qtyRemaining: "3.000000", seq: 1 }),
    ];
    const a = costingEngine.cost(issue("1.000000", layers));
    const b = costingEngine.cost(issue("1.000000", layers));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // and it did not mutate its input
    expect(layers[0]!.qtyRemaining.toString()).toBe("3.000000");
  });
});

describe("costingEngine — FIFO shares the layer model (spec:1214, LEGACY-055)", () => {
  const layers = () => [
    layer({
      id: "L2",
      qtyIn: "100.000000",
      unitCost: "20.0000",
      qtyRemaining: "100.000000",
      seq: 2,
      effectiveDate: "2026-01-20",
    }),
    layer({
      id: "L1",
      qtyIn: "100.000000",
      unitCost: "10.0000",
      qtyRemaining: "100.000000",
      seq: 1,
      effectiveDate: "2026-01-10",
    }),
  ];

  it("consumes the OLDEST layer first, whatever order the caller passed them in", () => {
    const out = costingEngine.cost(issue("150.000000", layers(), { method: "fifo" }));
    expect(
      out.consumptions.map((c) => [
        c.layerId,
        c.quantity.toString(),
        c.unitCost.toString(),
        c.value.toString(),
      ]),
    ).toEqual([
      ["L1", "100.000000", "10.0000", "1000.0000"],
      ["L2", "50.000000", "20.0000", "1000.0000"],
    ]);
    expect(out.value.toString()).toBe("2000.0000");
    // the movement's own unit cost is the weighted result, not either layer's
    expect(out.unitCost.toString()).toBe("13.3333");
    expect(out.updatedRemaining).toEqual([
      { layerId: "L1", qtyRemaining: qty("0.000000") },
      { layerId: "L2", qtyRemaining: qty("50.000000") },
    ]);
  });

  it("FIFO and AVCO answer differently over the same layers — the method is a real switch", () => {
    const fifo = costingEngine.cost(issue("150.000000", layers(), { method: "fifo" }));
    const avco = costingEngine.cost(issue("150.000000", layers(), { method: "avco" }));
    expect(fifo.value.toString()).toBe("2000.0000");
    expect(avco.value.toString()).toBe("2250.0000"); // 150 × the 15.0000 average
    expect(fifo.consumptions[0]!.unitCost.toString()).toBe("10.0000");
    expect(avco.consumptions[0]!.unitCost.toString()).toBe("15.0000");
  });

  it("the FIFO carry-forward is total — every layer touched, none skipped, and the quantities close (LEGACY-055)", () => {
    // procMatStorage's `if ((Material is not null) or (Material <> aMat))` reset the carry-forward on every
    // row, so the FIFO walk never happened. This asserts the opposite: the walk visits layers in order until
    // the need is met and Σ consumed = the issue exactly.
    const three = [
      layer({
        id: "A",
        qtyIn: "3.000000",
        unitCost: "1.0000",
        qtyRemaining: "3.000000",
        seq: 1,
        effectiveDate: "2026-01-01",
      }),
      layer({
        id: "B",
        qtyIn: "3.000000",
        unitCost: "2.0000",
        qtyRemaining: "3.000000",
        seq: 2,
        effectiveDate: "2026-01-02",
      }),
      layer({
        id: "C",
        qtyIn: "3.000000",
        unitCost: "3.0000",
        qtyRemaining: "3.000000",
        seq: 3,
        effectiveDate: "2026-01-03",
      }),
    ];
    const out = costingEngine.cost(issue("7.000000", three, { method: "fifo" }));
    expect(out.consumptions.map((c) => c.layerId)).toEqual(["A", "B", "C"]);
    expect(out.consumptions.reduce((a, c) => a.add(c.quantity), Quantity.zero()).toString()).toBe(
      "7.000000",
    );
    expect(out.value.toString()).toBe("12.0000"); // 3×1 + 3×2 + 1×3
  });

  it("two layers with the same date and sequence are ordered by (line_no, movement_no) — the key is total (LEGACY-067)", () => {
    const sameKey = [
      layer({
        id: "SECOND",
        qtyIn: "1.000000",
        unitCost: "9.0000",
        qtyRemaining: "1.000000",
        seq: 4,
        lineNo: 1,
        movementNo: 2,
      }),
      layer({
        id: "FIRST",
        qtyIn: "1.000000",
        unitCost: "1.0000",
        qtyRemaining: "1.000000",
        seq: 4,
        lineNo: 1,
        movementNo: 1,
      }),
    ];
    const out = costingEngine.cost(issue("1.000000", sameKey, { method: "fifo" }));
    expect(out.consumptions.map((c) => c.layerId)).toEqual(["FIRST"]);
  });
});

describe("exact receipt value conservation", () => {
  it.each(["avco", "fifo"] as const)(
    "%s preserves a non-divisible receipt through partial and full depletion",
    (method) => {
      let current = layer({
        id: "thirds",
        qtyIn: "3",
        qtyRemaining: "3",
        unitCost: "3.3333",
        value: "10",
        seq: 1,
      });
      const values: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const out = costingEngine.cost(issue("1", [current], { method }));
        values.push(out.value.toString());
        current = { ...current, qtyRemaining: out.updatedRemaining[0]!.qtyRemaining };
      }
      expect(values).toEqual(["3.3333", "3.3334", "3.3333"]);
      expect(current.qtyRemaining.isZero()).toBe(true);
    },
  );

  it.each(["avco", "fifo"] as const)(
    "%s cancels only the identified untouched receipt",
    (method) => {
      const first = layer({
        id: "first",
        qtyIn: "100",
        qtyRemaining: "100",
        unitCost: "10",
        seq: 1,
      });
      const second = layer({
        id: "second",
        qtyIn: "100",
        qtyRemaining: "100",
        unitCost: "20",
        seq: 2,
      });
      const out = costingEngine.cost(
        issue("100", [first, second], {
          method,
          cancellation: { movementId: second.movementId, value: money("2000") },
        }),
      );
      expect(out.value.toString()).toBe("2000.0000");
      expect(out.consumptions.map((c) => c.layerId)).toEqual([second.id]);
      expect(out.updatedRemaining[0]!.qtyRemaining.isZero()).toBe(true);
    },
  );

  it.each(["consumed", "mismatched", "missing"])(
    "refuses a %s cancellation even with a stock override",
    (kind) => {
      const source = layer({
        id: "source",
        qtyIn: "3",
        qtyRemaining: kind === "consumed" ? "2" : "3",
        unitCost: "3.3333",
        value: "10",
        seq: 1,
      });
      expect(() =>
        costingEngine.cost(
          issue("3", kind === "missing" ? [] : [source], {
            allowShortfall: true,
            cancellation: {
              movementId: source.movementId,
              value: money(kind === "mismatched" ? "9.9999" : "10"),
            },
          }),
        ),
      ).toThrow(/ERR_DOC_STATUS_ILLEGAL/);
    },
  );
});
