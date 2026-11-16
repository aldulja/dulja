import { Money, type CurrencyCode } from "../money/money";
import { Quantity } from "../money/quantity";
import { QUANTITY_SCALE } from "../money/rounding";
import type { PlannedMovement } from "../posting/evaluate";

/** The company's method (spec:1214; `company.costing_method`, migration 0035). AVCO is the v1 default. */
export type CostingMethod = "avco" | "fifo";

/**
 * The minimum meaningful quantity — spec:1227's clamp, exported as ONE name so no call site retypes it.
 * LEGACY-008(b): the guard in the old system was `if (aCurrentQnt <> 0)`, which excludes only exact zero, and
 * the smallest non-zero numeric(18,4) is 0.0001 — so a divisor could be 10,000x smaller than one unit and a
 * return of 5.0001 against 5.0000 on hand produced a stored unit cost of 500,020.00. Anything below this
 * value is not a denominator; it is a residue, and an issue against it is refused (amendment A22).
 */
export const MIN_MEANINGFUL_QTY: Quantity = Quantity.of("0.000001");

/** One inventory receipt's cost layer (spec:1216-1217). Ordered by the contracts §4.3.5 chronological key. */
export interface Layer {
  id: string;
  itemId: string;
  warehouseId: string;
  lotId: string;
  movementId: string;
  qtyIn: Quantity;
  /** Exact original receipt value; unitCost is rounded display metadata. */
  value: Money;
  unitCost: Money;
  qtyRemaining: Quantity;
  effectiveDate: string;
  postingSeq: bigint;
  lineNo: number;
  movementNo: number;
}

/** Exactly what an issue consumed (spec:1218). `quantity` and `value` are magnitudes. */
export interface Consumption {
  layerId: string;
  quantity: Quantity;
  unitCost: Money;
  value: Money;
}

export interface CostingInput {
  method: CostingMethod;
  /** The OPEN layers of this movement's (company, item, warehouse), in chronological order. Never per-lot. */
  openLayers: Layer[];
  movement: PlannedMovement & {
    effectiveDate: string;
    postingSeq: bigint;
    movementId: string;
    lotId: string;
  };
  /**
   * True when the caller has authority for the layers to fall short: a free-of-charge line
   * (`costing === "zero"`, spec:1055) or a document carrying an `inventory.negative_stock.override`
   * event recorded by a second principal (F-6; tests 7 and 18). The shortfall is then VALUED at the
   * running average and produces no consumption row — there is no layer to point at, and
   * `cost_consumption.layer_id` is NOT NULL because a consumption is a fact about a layer.
   */
  allowShortfall: boolean;
  /** Internally resolved purchase cancellation; never an ordinary issue or partial return. */
  cancellation?: { movementId: string; value: Money };
}

export interface CostingOutput {
  /** A magnitude, never negative. `movement.effect` carries the direction (§4.4.2 amendment A9's discipline). */
  value: Money;
  unitCost: Money;
  consumptions: Consumption[];
  newLayer: Omit<Layer, "id"> | null;
  updatedRemaining: { layerId: string; qtyRemaining: Quantity }[];
}

export interface CostingEngine {
  /**
   * Pure. A receipt creates a layer at the movement's value; an issue consumes per `method` — FIFO takes the
   * oldest layers, AVCO a proportional quantity slice of all open layers (spec:1222; ADR 0039 amendment).
   * Throws `CostingError`: `ERR_COST_NEGATIVE` if a computed unit cost is negative, `ERR_STOCK_INSUFFICIENT`
   * if the open layers cannot cover the issue and `allowShortfall` is false or if the divisor would fall
   * below `MIN_MEANINGFUL_QTY` (spec:1227), `ERR_COST_VALUE_MISSING` if a receipt carries no value (LEGACY-007).
   */
  cost(input: CostingInput): CostingOutput;
  /** Running average for display and valuation: Σ remainingLayerValue ÷ Σ qtyRemaining over open layers. */
  average(openLayers: Layer[], baseCurrency: CurrencyCode): Money;
}

/**
 * The engine's one error class. `packages/domain` may not import `AppError` from `@dulja/contracts`
 * (spec:2389 — domain imports nothing from the other packages), so this mirrors `PolicyEvaluationError`
 * (§4.4.2): one class, four codes, every code a literal member of `ErrCode`. `applyMovements` translates
 * it to `PostingError` with the same code, and `apps/api/src/problem.ts` maps that to the wire `Problem`.
 */
export class CostingError extends Error {
  constructor(
    readonly code:
      | "ERR_COST_NEGATIVE"
      | "ERR_STOCK_INSUFFICIENT"
      | "ERR_COST_VALUE_MISSING"
      | "ERR_DOC_STATUS_ILLEGAL",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CostingError";
  }
}

const QTY_UNIT = 10n ** BigInt(QUANTITY_SCALE);

/** A `Quantity` as an exact integer count of micro-units. `Quantity` is fixed at 6 dp, so this never loses. */
function micro(q: Quantity): bigint {
  return BigInt(q.toDecimal().times(QTY_UNIT.toString()).toFixed(0));
}

function fromMicro(v: bigint): Quantity {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = (abs / QTY_UNIT).toString();
  const frac = (abs % QTY_UNIT).toString().padStart(QUANTITY_SCALE, "0");
  return Quantity.of(`${negative ? "-" : ""}${whole}.${frac}`);
}

/** `Quantity` has no `abs()` (contracts §4.2.1) — direction lives on `effect`, so magnitudes are taken here. */
function magnitudeOf(q: Quantity): Quantity {
  return q.isNegative() ? q.negate() : q;
}

function sumRemaining(layers: readonly Layer[]): Quantity {
  return layers.reduce((a, l) => a.add(l.qtyRemaining), Quantity.zero());
}

/**
 * `value ÷ quantity`, rounded HALF_AWAY_FROM_ZERO at MONEY_SCALE — the same mode and scale base conversion
 * uses (spec:1816), so a unit cost and a base amount round the same way in both directions of the sign.
 * Refuses a divisor below MIN_MEANINGFUL_QTY (spec:1227) and a negative result (LEGACY-008).
 */
function unitCostOf(value: Money, quantity: Quantity, context: string): Money {
  const divisor = quantity.toDecimal();
  if (divisor.lessThan(MIN_MEANINGFUL_QTY.toDecimal())) {
    throw new CostingError(
      "ERR_STOCK_INSUFFICIENT",
      `${context}: quantity ${quantity.toString()} is below the minimum meaningful quantity ${MIN_MEANINGFUL_QTY.toString()} — dividing by a residue is what produced LEGACY-008's stored unit cost of 500,020.00`,
    );
  }
  const unit = value.divide(divisor, "HALF_AWAY_FROM_ZERO");
  if (unit.isNegative()) {
    throw new CostingError(
      "ERR_COST_NEGATIVE",
      `${context}: computed unit cost ${unit.toString()} is negative`,
    );
  }
  return unit;
}

/**
 * Largest-remainder split of `need` across `weights`, in exact micro-units. Σ result === need, always.
 * A proportional AVCO slice that did not close would leave a residue on the layers that no later issue
 * could ever clear, and `qty_remaining` would drift away from `qty_in − Σ consumptions` — which is exactly
 * the invariant the `cost_layer` projection check asserts every night.
 */
function splitQuantity(need: Quantity, weights: readonly Quantity[]): Quantity[] {
  const target = micro(need);
  const w = weights.map(micro);
  const total = w.reduce((a, x) => a + x, 0n);
  if (total <= 0n) {
    throw new CostingError(
      "ERR_STOCK_INSUFFICIENT",
      `no open layer has any quantity remaining to cover a consumption of ${need.toString()}`,
    );
  }
  const parts: bigint[] = [];
  const remainders: { index: number; rest: bigint }[] = [];
  let assigned = 0n;
  w.forEach((weight, index) => {
    const numerator = target * weight;
    const share = numerator / total;
    parts.push(share);
    remainders.push({ index, rest: numerator % total });
    assigned += share;
  });
  let left = target - assigned;
  // Descending remainder, ties broken by the layer's own chronological position — deterministic, which is
  // what makes the golden fixtures byte-comparable.
  remainders.sort((x, y) => (x.rest === y.rest ? x.index - y.index : y.rest > x.rest ? 1 : -1));
  for (const { index } of remainders) {
    if (left <= 0n) break;
    parts[index] = parts[index]! + 1n;
    left -= 1n;
  }
  return parts.map(fromMicro);
}

/**
 * The contracts §4.3.5 chronological key, written out in full: (effective_date, posting_seq, line_no,
 * movement_no). The engine sorts its own input rather than trusting the caller's order, and that is
 * deliberate: LEGACY-005's whole defect was one path ordering by document **id** while the other ordered by
 * **date**, so "the incremental mode" and "the batch replay" disagreed about what "the newest transaction"
 * meant. There is one ordering, in one function, and neither `applyMovements` nor `replay` can get it wrong.
 * spec:1225 — "the chronological key is explicit and total — never dependent on an index definition (LEGACY-067)".
 */
function byChronology(a: Layer, b: Layer): number {
  if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate ? -1 : 1;
  if (a.postingSeq !== b.postingSeq) return a.postingSeq < b.postingSeq ? -1 : 1;
  if (a.lineNo !== b.lineNo) return a.lineNo - b.lineNo;
  return a.movementNo - b.movementNo;
}

function costReceipt(input: CostingInput): CostingOutput {
  const { movement } = input;
  const context = `receipt movement ${movement.movementNo} of line ${movement.lineNo}`;
  const quantity = magnitudeOf(movement.quantity);
  if (quantity.isZero()) {
    throw new CostingError(
      "ERR_COST_VALUE_MISSING",
      `${context}: quantity is zero — a movement of nothing has no cost`,
    );
  }
  if (movement.value === null) {
    throw new CostingError(
      "ERR_COST_VALUE_MISSING",
      `${context} carries no value; value is a mandatory non-null attribute of every stock movement and is rejected at write time if absent (LEGACY-007, spec:1226)`,
    );
  }
  if (movement.value.isNegative()) {
    throw new CostingError(
      "ERR_COST_NEGATIVE",
      `${context}: value ${movement.value.toString()} is negative`,
    );
  }
  const unitCost = unitCostOf(movement.value, quantity, context);
  return {
    value: movement.value,
    unitCost,
    consumptions: [],
    newLayer: {
      itemId: movement.itemId,
      warehouseId: movement.warehouseId,
      lotId: movement.lotId,
      movementId: movement.movementId,
      qtyIn: quantity,
      value: movement.value,
      unitCost,
      qtyRemaining: quantity,
      effectiveDate: movement.effectiveDate,
      postingSeq: movement.postingSeq,
      lineNo: movement.lineNo,
      movementNo: movement.movementNo,
    },
    updatedRemaining: [],
  };
}

/** Exact remaining receipt value, rounded once at the money boundary (ADR 0039 amendment). */
export function remainingLayerValue(layer: Layer, quantity: Quantity = layer.qtyRemaining): Money {
  if (layer.qtyIn.toDecimal().lessThan(MIN_MEANINGFUL_QTY.toDecimal())) {
    throw new CostingError(
      "ERR_STOCK_INSUFFICIENT",
      "a cost layer has no meaningful original quantity",
    );
  }
  if (layer.value.isNegative() || layer.unitCost.isNegative()) {
    throw new CostingError(
      "ERR_COST_NEGATIVE",
      "a cost layer carries a negative receipt value or unit cost",
    );
  }
  return Money.fromDecimal(
    layer.value.toDecimal().times(quantity.toDecimal()).div(layer.qtyIn.toDecimal()),
    layer.value.currency,
    "HALF_AWAY_FROM_ZERO",
  );
}

function costCancellation(input: CostingInput): CostingOutput {
  const source = input.openLayers.find((l) => l.movementId === input.cancellation!.movementId);
  const need = magnitudeOf(input.movement.quantity);
  if (
    !source ||
    source.itemId !== input.movement.itemId ||
    source.warehouseId !== input.movement.warehouseId ||
    source.lotId !== input.movement.lotId ||
    source.effectiveDate > input.movement.effectiveDate ||
    (source.effectiveDate === input.movement.effectiveDate &&
      source.postingSeq >= input.movement.postingSeq) ||
    source.qtyRemaining.compare(source.qtyIn) !== 0 ||
    source.qtyIn.compare(need) !== 0 ||
    source.value.compare(input.cancellation!.value) !== 0
  ) {
    throw new CostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      "purchase reversal requires its untouched receipt layer at the original value; use the ordinary return or correction path",
    );
  }
  const unitCost = unitCostOf(source.value, source.qtyIn, "purchase cancellation");
  return {
    value: source.value,
    unitCost,
    consumptions: [{ layerId: source.id, quantity: need, value: source.value, unitCost }],
    newLayer: null,
    updatedRemaining: [{ layerId: source.id, qtyRemaining: Quantity.zero() }],
  };
}

function costIssue(input: CostingInput): CostingOutput {
  const { method, openLayers, movement, allowShortfall } = input;
  const context = `issue movement ${movement.movementNo} of line ${movement.lineNo}`;
  const need = magnitudeOf(movement.quantity);
  if (need.isZero()) {
    throw new CostingError(
      "ERR_COST_VALUE_MISSING",
      `${context}: quantity is zero — a movement of nothing has no cost`,
    );
  }
  const open = [...openLayers]
    .filter((l) => !l.qtyRemaining.isZero() && !l.qtyRemaining.isNegative())
    // `toSorted`, not `sort`: oxlint's unicorn/no-array-sort refuses the mutating form, and the copy is
    // the point — `cost` must not reorder its caller's array, which the purity case asserts.
    .toSorted(byChronology);
  const baseCurrency = open[0]?.unitCost.currency ?? movement.value?.currency ?? null;
  if (baseCurrency === null) {
    // No layer to borrow a currency from and no value on the movement. Legal only for an authorised
    // shortfall against an empty layer set (a free-of-charge line at zero stock, spec:1055).
    if (!allowShortfall) {
      throw new CostingError(
        "ERR_STOCK_INSUFFICIENT",
        `${context}: ${need.toString()} requested and no open cost layer exists for item ${movement.itemId} in warehouse ${movement.warehouseId}`,
      );
    }
    throw new CostingError(
      "ERR_COST_VALUE_MISSING",
      `${context}: an authorised shortfall against an empty layer set carries no currency; applyMovements must supply the company's base currency on movement.value`,
    );
  }
  const zero = Money.zero(baseCurrency);
  const available = sumRemaining(open);
  const short = available.compare(need) < 0;
  if (short && !allowShortfall) {
    throw new CostingError(
      "ERR_STOCK_INSUFFICIENT",
      `${context}: ${need.toString()} requested but only ${available.toString()} remains in the open cost layers of item ${movement.itemId} in warehouse ${movement.warehouseId} — refuse rather than absorb (LEGACY-008)`,
    );
  }
  const covered = short ? available : need;
  const shortfall = need.subtract(covered);

  const consumptions: Consumption[] = [];
  const updatedRemaining: { layerId: string; qtyRemaining: Quantity }[] = [];
  let coveredValue = zero;

  if (!covered.isZero()) {
    if (method === "avco") {
      const runningAverage = average(open, baseCurrency);
      const parts = splitQuantity(
        covered,
        open.map((l) => l.qtyRemaining),
      );
      // Price the exact reduction in remaining layer values, then allocate down. A very small layer beside large ones can
      // floor to a 0.000000 share, and such a layer gets NO consumption row — so it must not be a weight
      // either: allocate over the surviving shares only and zip positionally against them. (0D's allocate
      // orders the residue by largest remainder with ties to the lowest index, 0d:474-477, so a zero weight
      // could not in fact win a unit while a positive-remainder share is unpaid; filtering makes Σ
      // consumption value = out.value true by construction rather than by that argument.)
      const taking = open
        .map((layer, i) => ({ layer, quantity: parts[i]! }))
        .filter((t) => !t.quantity.isZero());
      coveredValue = taking.reduce(
        (total, t) =>
          total.add(
            remainingLayerValue(t.layer).subtract(
              remainingLayerValue(t.layer, t.layer.qtyRemaining.subtract(t.quantity)),
            ),
          ),
        zero,
      );
      const values = coveredValue.allocate(
        taking.map((t) => micro(t.quantity)),
        "HALF_AWAY_FROM_ZERO",
      );
      taking.forEach((t, i) => {
        consumptions.push({
          layerId: t.layer.id,
          quantity: t.quantity,
          unitCost: runningAverage,
          value: values[i]!,
        });
        updatedRemaining.push({
          layerId: t.layer.id,
          qtyRemaining: t.layer.qtyRemaining.subtract(t.quantity),
        });
      });
    } else {
      // FIFO: the oldest layers first, using each layer's exact remaining value reduction. `open` is already in
      // chronological order, so this is a single forward pass with no re-sorting and no lot filter — the
      // oldest layer wins whatever lot it belongs to. FEFO picking (3A's app.pick_lots_fefo) is what chooses
      // the lot on the document line; the layer order is a costing question, not a picking question.
      let left = covered;
      for (const l of open) {
        if (left.isZero()) break;
        const take = l.qtyRemaining.compare(left) <= 0 ? l.qtyRemaining : left;
        const takenValue = remainingLayerValue(l).subtract(
          remainingLayerValue(l, l.qtyRemaining.subtract(take)),
        );
        consumptions.push({
          layerId: l.id,
          quantity: take,
          unitCost: l.unitCost,
          value: takenValue,
        });
        updatedRemaining.push({ layerId: l.id, qtyRemaining: l.qtyRemaining.subtract(take) });
        coveredValue = coveredValue.add(takenValue);
        left = left.subtract(take);
      }
      if (!left.isZero()) {
        // Unreachable: `covered` is min(need, available) and `available` is Σ over the same filtered set.
        // It is here because LEGACY-055's carry-forward bug was exactly a loop that silently did not finish.
        throw new CostingError(
          "ERR_STOCK_INSUFFICIENT",
          `${context}: the FIFO walk ended with ${left.toString()} unconsumed over ${open.length} open layer(s)`,
        );
      }
    }
  }

  const shortfallValue = shortfall.isZero()
    ? zero
    : average(open, baseCurrency).multiply(shortfall.toDecimal(), "HALF_AWAY_FROM_ZERO");
  const value = coveredValue.add(shortfallValue);
  const unitCost = unitCostOf(value, need, context);
  return { value, unitCost, consumptions, newLayer: null, updatedRemaining };
}

function average(openLayers: Layer[], baseCurrency: CurrencyCode): Money {
  const zero = Money.zero(baseCurrency);
  if (openLayers.length === 0) return zero;
  const totalQty = sumRemaining(openLayers);
  // A residue below one micro-unit is not a denominator (spec:1227). Returning zero here is safe because
  // valuation never computes `average × quantity` — `valuationAsOf` sums exact remaining receipt values
  // per layer directly — so this value reaches a display, never a stored amount.
  if (totalQty.toDecimal().lessThan(MIN_MEANINGFUL_QTY.toDecimal())) return zero;
  const totalValue = openLayers.reduce((a, l) => a.add(remainingLayerValue(l)), zero);
  return totalValue.divide(totalQty.toDecimal(), "HALF_AWAY_FROM_ZERO");
}

function cost(input: CostingInput): CostingOutput {
  if (input.movement.effect === "receipt") return costReceipt(input);
  return input.cancellation ? costCancellation(input) : costIssue(input);
}

/** THE one implementation (spec:1228). Reports, valuation and posting import this and never re-implement it. */
export const costingEngine: CostingEngine = { cost, average };
