import {
  costingEngine,
  CostingError,
  Money,
  Quantity,
  remainingLayerValue,
  type CostingMethod,
  type CurrencyCode,
  type Layer,
} from "@dulja/domain";
import { LoadError } from "./types";

/** One legacy stock movement line, mapped (9B plan N8). `quantity` is a positive magnitude; `direction` is the legacy
 *  flag's. `value` is the receipt's cost — `null` on an issue, which the engine costs from the layers, never from a
 *  legacy figure (§5.1 #6). */
export interface LegacyMovement {
  /** The source row's own key, so a refusal names the row that caused it. */
  sourceKey: string;
  itemKey: string;
  warehouseKey: string;
  lotKey: string | null;
  effectiveDate: string;
  sequence: bigint;
  lineNo: number;
  direction: "in" | "out";
  quantity: Quantity;
  value: Money | null;
}

/** One line of an opening: what stands in one batch of one item in one warehouse, at a recomputed cost. Under FIFO a
 *  batch may open as several positions, one per surviving layer it holds, oldest first. */
export interface OpeningPosition {
  itemKey: string;
  warehouseKey: string;
  lotKey: string | null;
  quantity: Quantity;
  /** `value ÷ quantity`, rounded once — display metadata, as a layer's own `unit_cost` is. */
  unitCost: Money;
  /** Exact: the sum of the surviving layers' remaining values, which is what `valuationAsOf` will sum. */
  value: Money;
}

export interface RecostResult {
  positions: OpeningPosition[];
  movementsReplayed: number;
  /** The batch whose history went below zero, and by how much. Its item opens nothing in that warehouse. */
  negatives: { itemKey: string; warehouseKey: string; lotKey: string | null; quantity: string }[];
}

/** NUL separates the parts: no legacy key contains one. */
const pairOf = (m: { itemKey: string; warehouseKey: string }): string =>
  `${m.itemKey}\u0000${m.warehouseKey}`;
const LOT_NONE = "\u0000";
const lotOf = (lotKey: string | null): string => lotKey ?? LOT_NONE;

/** The §4.3.5 chronological key, applied to the legacy world: (effective_date, document sequence, line). The fourth
 *  element (`movement_no`) does not exist in the source and is not invented. Stable for equal keys. */
export function sortLegacyMovements(movements: readonly LegacyMovement[]): LegacyMovement[] {
  return movements.toSorted((a, b) =>
    a.effectiveDate !== b.effectiveDate
      ? a.effectiveDate < b.effectiveDate
        ? -1
        : 1
      : a.sequence !== b.sequence
        ? a.sequence < b.sequence
          ? -1
          : 1
        : a.lineNo - b.lineNo,
  );
}

interface Batch {
  lotKey: string | null;
  quantity: Quantity;
  /** Order of first receipt, which is the order the oldest layers are assigned in. */
  firstSeen: number;
}

interface Pool {
  itemKey: string;
  warehouseKey: string;
  layers: Layer[];
  batches: Map<string, Batch>;
  failed: boolean;
}

const site = (m: LegacyMovement): string =>
  `legacy movement BILLITEMS/${m.sourceKey} (item ${m.itemKey}, warehouse ${m.warehouseKey}, ${m.effectiveDate})`;

/**
 * §5.1 #6, verbatim: "Do not import cost figures. `MatCosts` has no rebuild path and multiple corruption routes.
 * Recompute cost from movement history with the new engine, and reconcile the resulting opening valuation with the
 * customer."
 *
 * This runs 3B's `costingEngine` — the ONE implementation (spec:1228) — over the legacy movement history in memory and
 * returns what survives as opening positions. It writes nothing: `OPENING_STOCK` turns a position into a `cost_layer`
 * through `postDocument` → `applyMovements`, so the layer Dulja carries afterwards is made by the code that makes every
 * later one.
 *
 * It mirrors `applyMovements` where the two could differ:
 *   - **the cost pool is the item's in the warehouse, never the batch's** (`CostingInput.openLayers`, §4.7.1): an AVCO
 *     issue from one batch takes a proportional slice of every open layer of that item there;
 *   - **stock is counted per batch** (`assert_stock_available`, 0031): an issue a batch cannot cover is a negative
 *     position, which Dulja refuses without a second principal's override (acceptance test 18, hazard 17). The replay
 *     cannot supply one, so it REPORTS the batch and opens nothing of that item in that warehouse — the pool's later
 *     cost is unknowable once one of its issues is refused;
 *   - an issue is costed with the company's base-currency zero as its value, a receipt with its own.
 *
 * What survives is laid onto the batches that hold stock: the pool's open layers oldest first against the batches in
 * the order they were first received, each layer's remaining value split exactly (`remainingLayerValue`, so the parts
 * sum to the whole). Under AVCO the parts of one batch merge into one position — every layer is in one pool, so how
 * the value is split across batches changes no later cost. Under FIFO each part stays its own position, in layer order,
 * so the opening consumes in the order the history would have.
 */
export function replayLegacyMovements(
  movements: readonly LegacyMovement[],
  method: CostingMethod,
  baseCurrency: CurrencyCode,
): RecostResult {
  const pools = new Map<string, Pool>();
  const negatives: RecostResult["negatives"] = [];
  const zero = Money.zero(baseCurrency);
  let movementsReplayed = 0;
  let order = 0;

  for (const move of sortLegacyMovements(movements)) {
    movementsReplayed += 1;
    if (move.direction === "in" && move.value === null)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `legacy receipt ${move.itemKey}/${move.warehouseKey} on ${move.effectiveDate} has no value; a receipt with no cost is never costed at zero (SAH-011, §5.1 #6)`,
      );
    if (move.value !== null && move.value.currency !== baseCurrency)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `${site(move)} is in ${move.value.currency}; the replay costs in the company's base currency ${baseCurrency}`,
      );
    if (move.quantity.compare(Quantity.zero()) <= 0)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `${site(move)} has quantity ${move.quantity.toString()}; a legacy movement's direction is its flag, so its quantity is a positive magnitude`,
      );

    const key = pairOf(move);
    const pool = pools.get(key) ?? {
      itemKey: move.itemKey,
      warehouseKey: move.warehouseKey,
      layers: [],
      batches: new Map<string, Batch>(),
      failed: false,
    };
    pools.set(key, pool);
    if (pool.failed) continue;

    const lot = lotOf(move.lotKey);
    const batch = pool.batches.get(lot) ?? {
      lotKey: move.lotKey,
      quantity: Quantity.zero(),
      firstSeen: order++,
    };
    pool.batches.set(lot, batch);

    if (move.direction === "out" && move.quantity.compare(batch.quantity) > 0) {
      // The legacy system permitted it (SAH-009/018); Dulja does not without an override a second principal records.
      negatives.push({
        itemKey: move.itemKey,
        warehouseKey: move.warehouseKey,
        lotKey: move.lotKey,
        quantity: batch.quantity.subtract(move.quantity).toString(),
      });
      pool.failed = true;
      continue;
    }

    let out;
    try {
      out = costingEngine.cost({
        method,
        openLayers: pool.layers,
        allowShortfall: false,
        movement: {
          lineNo: move.lineNo,
          movementNo: 1,
          itemId: move.itemKey,
          warehouseId: move.warehouseKey,
          lotId: lot,
          quantity: move.quantity,
          effect: move.direction === "in" ? "receipt" : "issue",
          value: move.direction === "in" ? move.value : zero,
          costing: move.direction === "in" ? "create_layer" : "consume_layers",
          effectiveDate: move.effectiveDate,
          postingSeq: move.sequence,
          // The replay's own ordinal, never the source key: a layer id must be unique even if a key were not.
          movementId: `replay/${movementsReplayed}`,
        },
      });
    } catch (error) {
      if (error instanceof CostingError)
        throw new LoadError(
          "ERR_VALIDATION_FAILED",
          `${site(move)} cannot be costed: ${error.message}`,
        );
      throw error;
    }

    const remaining = new Map(out.updatedRemaining.map((u) => [u.layerId, u.qtyRemaining]));
    pool.layers = pool.layers
      .map((l) => {
        const after = remaining.get(l.id);
        return after === undefined ? l : { ...l, qtyRemaining: after };
      })
      .filter((l) => !l.qtyRemaining.isZero());
    if (out.newLayer) pool.layers.push({ ...out.newLayer, id: `replay/${movementsReplayed}` });
    batch.quantity =
      move.direction === "in"
        ? batch.quantity.add(move.quantity)
        : batch.quantity.subtract(move.quantity);
  }

  const positions: OpeningPosition[] = [];
  for (const key of [...pools.keys()].toSorted()) {
    const pool = pools.get(key)!;
    if (!pool.failed) positions.push(...layOut(pool, method));
  }
  return { positions, movementsReplayed, negatives };
}

/** The pool's surviving layers laid onto the batches that hold stock (see `replayLegacyMovements`). Σ layer remaining
 *  equals Σ batch quantity exactly — every issue consumed exactly its own quantity — so the walk ends together. */
function layOut(pool: Pool, method: CostingMethod): OpeningPosition[] {
  const layers = pool.layers.filter((l) => !l.qtyRemaining.isZero());
  const batches = [...pool.batches.values()]
    .filter((b) => !b.quantity.isZero())
    .toSorted((a, b) => a.firstSeen - b.firstSeen);
  const parts: { lotKey: string | null; quantity: Quantity; value: Money }[] = [];
  let li = 0;
  let layerLeft = layers[0]?.qtyRemaining ?? Quantity.zero();
  for (const batch of batches) {
    let batchLeft = batch.quantity;
    while (!batchLeft.isZero()) {
      const layer = layers[li];
      if (layer === undefined)
        throw new LoadError(
          "ERR_VALIDATION_FAILED",
          `the replay of item ${pool.itemKey} in warehouse ${pool.warehouseKey} ended with ${batchLeft.toString()} in batch ${batch.lotKey ?? "(none)"} and no cost layer left to value it`,
        );
      const take = layerLeft.compare(batchLeft) <= 0 ? layerLeft : batchLeft;
      parts.push({
        lotKey: batch.lotKey,
        quantity: take,
        value: remainingLayerValue(layer, layerLeft).subtract(
          remainingLayerValue(layer, layerLeft.subtract(take)),
        ),
      });
      batchLeft = batchLeft.subtract(take);
      layerLeft = layerLeft.subtract(take);
      if (layerLeft.isZero()) {
        li += 1;
        layerLeft = layers[li]?.qtyRemaining ?? Quantity.zero();
      }
    }
  }

  let merged = parts;
  if (method === "avco") {
    const byBatch = new Map<string, (typeof parts)[number]>();
    for (const part of parts) {
      const held = byBatch.get(lotOf(part.lotKey));
      byBatch.set(
        lotOf(part.lotKey),
        held === undefined
          ? part
          : {
              lotKey: part.lotKey,
              quantity: held.quantity.add(part.quantity),
              value: held.value.add(part.value),
            },
      );
    }
    merged = [...byBatch.values()];
  }
  return merged.map((p) => ({
    itemKey: pool.itemKey,
    warehouseKey: pool.warehouseKey,
    lotKey: p.lotKey,
    quantity: p.quantity,
    unitCost: p.value.divide(p.quantity.toDecimal(), "HALF_AWAY_FROM_ZERO"),
    value: p.value,
  }));
}
