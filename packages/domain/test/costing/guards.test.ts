import { describe, expect, it } from "vitest";
import {
  costingEngine,
  CostingError,
  currency,
  MIN_MEANINGFUL_QTY,
  Money,
  Quantity,
  type CostingInput,
  type Layer,
} from "../../src/index";

const MYR = currency("MYR");
const money = (v: string) => Money.of(v, MYR);
const qty = (v: string) => Quantity.of(v);

function layer(
  id: string,
  qtyRemaining: string,
  unitCost: string,
  seq: number,
  effectiveDate = "2026-01-01",
): Layer {
  return {
    id,
    itemId: "item-1",
    warehouseId: "wh-1",
    lotId: "lot-1",
    movementId: `mv-${id}`,
    qtyIn: qty(qtyRemaining),
    value: money(unitCost).multiply(qty(qtyRemaining).toDecimal(), "HALF_AWAY_FROM_ZERO"),
    unitCost: money(unitCost),
    qtyRemaining: qty(qtyRemaining),
    effectiveDate,
    postingSeq: BigInt(seq),
    lineNo: 1,
    movementNo: 1,
  };
}

function move(
  over: Partial<CostingInput["movement"]>,
  openLayers: Layer[],
  rest: Partial<CostingInput> = {},
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
      quantity: qty("1.000000"),
      effect: "issue",
      value: null,
      costing: "consume_layers",
      effectiveDate: "2026-03-01",
      postingSeq: 99n,
      movementId: "mv-x",
      ...over,
    },
    ...rest,
  };
}

describe("costing guards — acceptance test 6 (spec:2424; LEGACY-007, LEGACY-008)", () => {
  it("(a) a return exceeding stock is REFUSED, not absorbed — LEGACY-008(a)'s exact numbers", () => {
    // On hand 5 @ 10; return 6 to the supplier. The old system computed (10·5 − 30)/(−1) = −20.00 and
    // stored it, so every later sale booked negative COGS. Here the issue is refused before any arithmetic.
    const layers = [layer("L1", "5.000000", "10.0000", 1)];
    expect(() => costingEngine.cost(move({ quantity: qty("6.000000") }, layers))).toThrow(
      /ERR_STOCK_INSUFFICIENT.*6\.000000 requested but only 5\.000000 remains/s,
    );
    // and it threw the class, not a bare Error, so applyMovements can translate the code
    try {
      costingEngine.cost(move({ quantity: qty("6.000000") }, layers));
      expect.unreachable("the issue must be refused");
    } catch (e) {
      expect(e).toBeInstanceOf(CostingError);
      expect((e as CostingError).code).toBe("ERR_STOCK_INSUFFICIENT");
    }
  });

  it("(b) a sub-micro divisor is unrepresentable, and one micro-unit is a real denominator — LEGACY-008(b)", () => {
    // The old guard was `if (aCurrentQnt <> 0)`, which excludes only exact zero; the smallest non-zero
    // numeric(18,4) is 0.0001, so returning 5.0001 against 5.0000 left a divisor of −0.0001 and stored a unit
    // cost of 500,020.00. Two things close that here, and this case asserts both.
    //
    // FIRST: the type refuses the value. `Quantity.of` tests /^-?\d+(\.\d{1,6})?$/ and throws (0d:1034-1039),
    // so a 0.0000005 quantity cannot be constructed, let alone divided by. The engine's own refusal below
    // MIN_MEANINGFUL_QTY (amendment A22 — refused, not clamped: clamping 0.0000005 to 0.000001 still returns
    // an exploded unit cost) is therefore unreachable from a `Quantity` and stays as the guard that catches a
    // future QUANTITY_SCALE change rather than a runtime input.
    expect(() => Quantity.of("0.0000005")).toThrow(/at most 6 decimal places/);
    expect(MIN_MEANINGFUL_QTY.toString()).toBe("0.000001");

    // SECOND: the smallest representable quantity IS a denominator, and the boundary sits ON
    // MIN_MEANINGFUL_QTY, which `lessThan` admits. A one-micro-unit issue against a one-micro-unit layer
    // therefore posts: it empties the layer and its value rounds to 0.0000 at MONEY_SCALE. Nothing explodes
    // and nothing is falsely refused — which is the pair of failures LEGACY-008(b) actually produced.
    const layers = [layer("L1", "0.000001", "10.0000", 1)];
    const out = costingEngine.cost(move({ quantity: qty("0.000001") }, layers));
    expect(out.value.toString()).toBe("0.0000"); // round(0.000001 × 10.0000, 4) = 0.0000
    expect(out.unitCost.toString()).toBe("0.0000"); // 0.0000 ÷ 0.000001 is 0.0000, never 10,000×
    expect(out.updatedRemaining).toEqual([{ layerId: "L1", qtyRemaining: qty("0.000000") }]);
  });

  it("(c) a wash line — a movement of zero quantity — is refused, never costed at zero (LEGACY-008(c))", () => {
    // A landed-cost or reconciliation line posted at zero stock set Cost = 0 in the old system and every
    // later sale booked zero COGS. A movement of nothing has no cost; in 3C a landed cost adjusts a LAYER's
    // unit_cost and is not a movement at all.
    expect(() =>
      costingEngine.cost(
        move({ quantity: qty("0.000000") }, [layer("L1", "5.000000", "10.0000", 1)]),
      ),
    ).toThrow(/ERR_COST_VALUE_MISSING.*quantity is zero/s);
    expect(() =>
      costingEngine.cost(
        move(
          {
            quantity: qty("0.000000"),
            effect: "receipt",
            value: money("50.0000"),
            costing: "create_layer",
          },
          [],
        ),
      ),
    ).toThrow(/ERR_COST_VALUE_MISSING.*quantity is zero/s);
  });

  it("(d) a value-less receipt is refused — LEGACY-007's NULL poisoning", () => {
    // procProducePackage inserted both legs with no BtmPureTotal; (42·500 + NULL)/500 = NULL, coalesced to
    // 0.00 on the next sale, and a full recompute hit the same NULL. Value is mandatory here.
    expect(() =>
      costingEngine.cost(
        move(
          { effect: "receipt", value: null, costing: "create_layer", quantity: qty("500.000000") },
          [],
        ),
      ),
    ).toThrow(/ERR_COST_VALUE_MISSING.*mandatory non-null attribute/s);
  });

  it("(e) a negative receipt value is a hard error, not a stored cost", () => {
    expect(() =>
      costingEngine.cost(
        move(
          {
            effect: "receipt",
            value: money("-30.0000"),
            costing: "create_layer",
            quantity: qty("6.000000"),
          },
          [],
        ),
      ),
    ).toThrow(/ERR_COST_NEGATIVE.*value -30\.0000 is negative/s);
  });

  it("(f) an issue with no open layer at all is refused unless a shortfall is authorised", () => {
    expect(() => costingEngine.cost(move({ quantity: qty("1.000000") }, []))).toThrow(
      /ERR_STOCK_INSUFFICIENT.*no open cost layer exists/s,
    );
  });

  it("an AUTHORISED shortfall is valued at the running average and layers only what it could take (F-6, test 7)", () => {
    // 3A's assert_stock_available refuses this unless an inventory.negative_stock.override event exists,
    // recorded by a second principal. When it does, applyMovements sets allowShortfall and the excursion is
    // valued — 6 units at the 10.0000 average — but only the 5 that existed produce a consumption row,
    // because cost_consumption.layer_id is NOT NULL and there is no layer for the sixth.
    const layers = [layer("L1", "5.000000", "10.0000", 1)];
    const out = costingEngine.cost(
      move({ quantity: qty("6.000000") }, layers, { allowShortfall: true }),
    );
    expect(out.value.toString()).toBe("60.0000");
    expect(out.unitCost.toString()).toBe("10.0000");
    expect(out.consumptions).toHaveLength(1);
    expect(out.consumptions[0]!.quantity.toString()).toBe("5.000000");
    expect(out.consumptions[0]!.value.toString()).toBe("50.0000");
    expect(out.updatedRemaining).toEqual([{ layerId: "L1", qtyRemaining: qty("0.000000") }]);
  });

  it("an AUTHORISED override issue against NO layers is valued at zero, not refused (F-6, tests 7 and 18)", () => {
    // The negative-stock excursion at its extreme: an override issue when the item has never been received.
    // `applyMovements` gives every issue `Money.zero(baseCurrency)` (Task 7 note 3), so the engine always has
    // a currency to answer in and never reaches its own "no currency to borrow" refusal on this path. The
    // shortfall is the whole quantity, the running average of an empty layer set is 0.0000, and the movement
    // is therefore valued at 0.0000 with no consumption row — the layer-less half of ADR 0038 note 7.
    const out = costingEngine.cost(
      move({ quantity: qty("6.000000"), value: money("0.0000") }, [], { allowShortfall: true }),
    );
    expect(out.value.toString()).toBe("0.0000");
    expect(out.unitCost.toString()).toBe("0.0000");
    expect(out.consumptions).toEqual([]);
    expect(out.updatedRemaining).toEqual([]);
    expect(out.newLayer).toBeNull();
  });

  it("a free-of-charge line at zero stock costs at zero (spec:1055) when the caller supplies the currency", () => {
    // `costing: "zero"` with no layers: applyMovements passes Money.zero(baseCurrency) on the movement so the
    // engine has a currency to answer in, and the line consumes nothing.
    const out = costingEngine.cost(
      move({ quantity: qty("2.000000"), costing: "zero", value: money("0.0000") }, [], {
        allowShortfall: true,
      }),
    );
    expect(out.value.toString()).toBe("0.0000");
    expect(out.unitCost.toString()).toBe("0.0000");
    expect(out.consumptions).toEqual([]);
  });
});
