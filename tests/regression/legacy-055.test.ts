import { costingEngine, currency, Money, Quantity, rational, type Layer } from "@dulja/domain";
import { describe, expect, it } from "vitest";
import {
  openLayersOf,
  valuationAsOf,
  type CostLayerRow,
  type DatasetRow,
  type ValuationRow,
} from "@dulja/db";
import { withTenant } from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import {
  cachedReportFixture,
  readDefinition,
  readEnvelope,
  runDefinition,
  type ReportFixture,
} from "../invariants/support/reports";

const MYR = currency("MYR");
const layer = (id: string, qty: string, unitCost: string, seq: number, date: string): Layer => ({
  id,
  itemId: "item-1",
  warehouseId: "wh-1",
  lotId: "lot-1",
  movementId: `mv-${id}`,
  qtyIn: Quantity.of(qty),
  value: Money.of(unitCost, MYR).multiply(Quantity.of(qty).toDecimal(), "HALF_AWAY_FROM_ZERO"),
  unitCost: Money.of(unitCost, MYR),
  qtyRemaining: Quantity.of(qty),
  effectiveDate: date,
  postingSeq: BigInt(seq),
  lineNo: 1,
  movementNo: 1,
});

// Not a `thinRegression` call, deliberately: §3.7.3's rule is about the TITLE, and 0B's helper wraps a
// single `it` and invokes the body inside it (0b:5317–5326) — a `test` declared inside a running `test` is a
// Vitest error, not a failed assertion, and this file carries two cases. 2A did the same when it appended to
// 0B's legacy-013 (2a:4664). Both cases are pure: no database, no `sharedDb()`, no container.
describe("LEGACY-055 procMatStorage (FIFO stock ageing) is non-functional — 3B", () => {
  it("the FIFO carry-forward happens on every layer and the walk is a total function (first proven by packages/domain/test/costing/engine.test.ts)", () => {
    // The defect: `if ((Material is not null) or (Material <> aMat)) then aRemain = 0;` — OR where AND was
    // meant, so from the second row onward the condition was always true and `aRemain` reset every
    // iteration. The carry-forward never happened. Separately `aCount` was declared, never initialised,
    // used as `select skip (:aCount)` — NULL forever.
    //
    // The new system has no carry-forward variable to reset and no skip counter: FIFO is one forward pass
    // over layers the engine itself has ordered by the contracts §4.3.5 key, and the residue is the
    // layer's own `qty_remaining` column, which is a stored fact rather than a loop variable.
    const layers = [
      layer("OLDEST", "3.000000", "1.0000", 1, "2026-01-01"),
      layer("MIDDLE", "3.000000", "2.0000", 2, "2026-01-02"),
      layer("NEWEST", "3.000000", "3.0000", 3, "2026-01-03"),
    ];
    const out = costingEngine.cost({
      method: "fifo",
      openLayers: layers,
      allowShortfall: false,
      movement: {
        lineNo: 1,
        movementNo: 1,
        itemId: "item-1",
        warehouseId: "wh-1",
        lotId: "lot-1",
        quantity: Quantity.of("8.000000"),
        effect: "issue",
        value: null,
        costing: "consume_layers",
        effectiveDate: "2026-02-01",
        postingSeq: 10n,
        movementId: "mv-issue",
      },
    });
    // every layer visited, in age order, and the carry-forward reached the third
    expect(out.consumptions.map((c) => [c.layerId, c.quantity.toString()])).toEqual([
      ["OLDEST", "3.000000"],
      ["MIDDLE", "3.000000"],
      ["NEWEST", "2.000000"],
    ]);
    expect(out.consumptions.reduce((a, c) => a.add(c.quantity), Quantity.zero()).toString()).toBe(
      "8.000000",
    );
    expect(out.value.toString()).toBe("15.0000"); // 3×1 + 3×2 + 2×3
    // and the input was not mutated — the residue lives on the row, not in a loop variable
    expect(layers[0]!.qtyRemaining.toString()).toBe("3.000000");
  });

  it("a company can be switched to FIFO with no schema change (spec:1214)", () => {
    // The switch is a column value, and both methods read the same tables. This asserts the two methods
    // are genuinely different answers over identical layers, so the column is not decoration.
    const two = [
      layer("A", "100.000000", "10.0000", 1, "2026-01-10"),
      layer("B", "100.000000", "20.0000", 2, "2026-01-20"),
    ];
    const movement = {
      lineNo: 1,
      movementNo: 1,
      itemId: "item-1",
      warehouseId: "wh-1",
      lotId: "lot-1",
      quantity: Quantity.of("150.000000"),
      effect: "issue" as const,
      value: null,
      costing: "consume_layers" as const,
      effectiveDate: "2026-02-01",
      postingSeq: 10n,
      movementId: "mv-i",
    };
    expect(
      costingEngine
        .cost({ method: "fifo", openLayers: two, allowShortfall: false, movement })
        .value.toString(),
    ).toBe("2000.0000");
    expect(
      costingEngine
        .cost({ method: "avco", openLayers: two, allowShortfall: false, movement })
        .value.toString(),
    ).toBe("2250.0000");
  });
});

// ── 7B ─────────────────────────────────────────────────────────────────────────────────────────────────────
const AS_OF = "2026-01-31";

/** The three reads the 7B claim compares, in ONE transaction so they cannot be three instants apart. The
 *  report takes no as-of (7A's `age_days` runs from `current_date`, contracts 7B A13); the two 3B reads do. */
async function readAgeing(
  f: ReportFixture,
): Promise<{ layers: CostLayerRow[]; rows: DatasetRow[]; valuation: ValuationRow[] }> {
  const itemId = f.inventory!.itemId;
  return withTenant(f.db.rw, f.s.tenant, f.reader, async (tx) => {
    const layers = await openLayersOf(tx, {
      companyId: f.s.company,
      itemId,
      asOf: AS_OF,
      limit: 100,
    });
    const rows = await runDefinition(tx, readDefinition("inventory.stock_ageing"), {
      companyId: f.s.company,
      itemId,
      warehouseId: null,
    });
    const valuation = await valuationAsOf(tx, {
      companyId: f.s.company,
      asOf: AS_OF,
      itemId,
      limit: 50,
    });
    return { layers, rows, valuation };
  });
}

/** A fixed-scale decimal string as an integer count of 10^-6 units, so a quantity ratio is an exact rational. */
function micros(decimal: string): bigint {
  const [whole = "0", fraction = ""] = decimal.split(".");
  return BigInt(`${whole}${fraction.padEnd(6, "0").slice(0, 6)}`);
}

/** Σ residue value over the report's own rows: the layer's stored RECEIPT `value` × `qty_remaining / qty_in`,
 *  rounded once half away from zero — the per-layer term `valuationAsOf` sums (migration 0118, ADR 0039's
 *  approved exact-value amendment; contracts 7B A5). The harness's tie-out performs the same arithmetic; this
 *  fold exists so the block can state the equality in its own terms rather than add a third path. */
function sumResidue(rows: readonly DatasetRow[]): string {
  return rows
    .reduce((acc, r) => {
      const qtyIn = micros(String(r["qty_in"]));
      if (qtyIn === 0n) return acc;
      return acc.add(
        Money.of(String(r["value"]), MYR).multiply(
          rational(micros(String(r["qty_remaining"])), qtyIn),
          "HALF_AWAY_FROM_ZERO",
        ),
      );
    }, Money.zero(MYR))
    .toString();
}

/** Σ of `valuationAsOf`'s own stored `value` — a camelCase `ValuationRow` fold, kept apart from the snake_case
 *  `DatasetRow` fold above so the two vocabularies never share one signature. */
function sumStored(valuation: readonly ValuationRow[]): string {
  return valuation.reduce((a, v) => a.add(Money.of(v.value, MYR)), Money.zero(MYR)).toString();
}

describe("LEGACY-055 procMatStorage (FIFO stock ageing) is non-functional — 7B", () => {
  // 3B's block proves the ENGINE walks every layer with a real carry-forward. This one proves the REPORT walks
  // nothing: `inventory.stock_ageing`'s rows are `cost_layer` rows, its residue is the layer's stored
  // `qty_remaining`, and its value per item equals `valuationAsOf`. Written for OD-06's `'avco'` default and
  // asserting nothing about consumption ORDER, which is the method's business, not the report's (A12).
  it("the report's rows are the layers, and their value equals the ONE valuation implementation", async () => {
    const { db } = await sharedDb();
    const f = await cachedReportFixture(db, "legacy055-7b", { inventory: true });
    const { layers, rows, valuation } = await readAgeing(f);
    expect(rows.length).toBeGreaterThan(0);
    // `rows` are DatasetRows (snake_case, A3); `layers` are 3B's CostLayerRows (camelCase). The two vocabularies
    // meet in this block and nowhere else.
    expect(rows.map((r) => String(r["layer_id"])).toSorted()).toEqual(
      layers.map((l) => l.layerId).toSorted(),
    );
    for (const r of rows) {
      const stored = layers.find((l) => l.layerId === String(r["layer_id"]))!;
      // a stored column, not a loop variable
      expect(Quantity.of(String(r["qty_remaining"])).toString()).toBe(
        Quantity.of(stored.qtyRemaining).toString(),
      );
    }
    expect(sumResidue(rows)).toBe(sumStored(valuation));
  });

  it("the definition names one registered source and no aggregate of its own", () => {
    const definition = readEnvelope("inventory.stock_ageing").definition;
    expect(definition.dataset.source).toBe("cost_layer");
    expect(JSON.stringify(definition)).not.toMatch(/\bselect\b|sum\(|group by/i);
  });
});
