import {
  costingEngine,
  CostingError,
  Money,
  Quantity,
  type Consumption,
  type CostingMethod,
  type CurrencyCode,
  type DocumentSnapshot,
  type Layer,
  type LineSnapshot,
  type PlannedLedgerLine,
  type PlannedMovement,
  type PostingPlan,
} from "@dulja/domain";
import type { Sql } from "postgres";
import { SENTINEL_LOT_CODE } from "../inventory/lots";
import { PostingError } from "../posting/errors";
import type { TenantContext } from "../with-tenant";
// No cycle: landed-cost.ts imports nothing from this file.
import { landedCostByLine, receiptValue } from "./landed-cost";
import { purchaseCancellation, assertCancellationChronology } from "./purchase-cancellation";
import { lockStockKeys } from "./stock-on-hand";

/**
 * Every item's `NONE` sentinel lot, keyed by item id. One query for the whole document: `applyMovements` needs
 * it only for the movements whose plan carries `lotId === null`, and the evaluator is pure and has no source
 * for the uuid (contracts §4.4.2's note on `PlannedMovement.lotId`).
 */
export async function loadSentinelLots(
  tx: Sql,
  itemIds: readonly string[],
): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx<{ item_id: string; id: string }[]>`
    select item_id, id from app.lot
     where item_id = any(${[...itemIds]}) and code = ${SENTINEL_LOT_CODE}`;
  return new Map(rows.map((r) => [r.item_id, r.id]));
}

/**
 * Every VALID open layer of one (company, item, warehouse), in the contracts §4.3.5 chronological order
 * `(effective_date, posting_seq, line_no, movement_no)` — all four columns, spelled out, never an index's
 * implicit order (spec:1225, LEGACY-067). `line_no` and `movement_no` live on the movement, which is why the
 * join is here and not optional.
 *
 * NO DATE FILTER, deliberately. At step 9 the document being posted is the newest thing in the company, so
 * "every open layer" and "every open layer at or before this key" are the same set — except for a BACK-DATED
 * document, where later layers exist. Filtering them out would let this issue consume a layer that a later,
 * already-posted issue has already emptied, driving that layer's `qty_remaining` below zero into
 * `cost_layer_qty_remaining_check`. The correct sequence is: post now against the layers as they stand, then
 * invalidate from this document's own key forward (step 14) and let the replay recompute the affected tail
 * (spec:1220-1223). A clever date filter here is LEGACY-005's incremental mode reintroduced.
 *
 * The engine sorts its own input anyway (`byChronology`), so this ordering is belt and braces — and it is
 * what makes the query plan use `cost_layer_open_idx` instead of a sort.
 */
export async function openLayersFor(
  tx: Sql,
  input: { companyId: string; itemId: string; warehouseId: string; baseCurrency: CurrencyCode },
): Promise<Layer[]> {
  const rows = await tx<
    {
      id: string;
      item_id: string;
      warehouse_id: string;
      lot_id: string;
      movement_id: string;
      qty_in: string;
      value: string;
      unit_cost: string;
      qty_remaining: string;
      effective_at: string;
      sequence: string;
      line_no: number;
      movement_no: number;
    }[]
  >`
    select l.id::text as id, l.item_id::text as item_id, l.warehouse_id::text as warehouse_id,
           l.lot_id::text as lot_id, l.movement_id::text as movement_id,
           l.qty_in::text as qty_in, l.value::text as value, l.unit_cost::text as unit_cost, l.qty_remaining::text as qty_remaining,
           l.effective_at::text as effective_at, l.sequence::text as sequence,
           m.line_no, m.movement_no
      from app.cost_layer l
      join app.inventory_movement m on m.tenant_id = l.tenant_id and m.id = l.movement_id
     where l.company_id = ${input.companyId}
       and l.item_id = ${input.itemId}
       and l.warehouse_id = ${input.warehouseId}
       and l.invalidated_at is null
       and l.qty_remaining > 0
     order by l.effective_at, l.sequence, m.line_no, m.movement_no`;
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    lotId: r.lot_id,
    movementId: r.movement_id,
    qtyIn: Quantity.of(r.qty_in),
    value: Money.of(r.value, input.baseCurrency),
    unitCost: Money.of(r.unit_cost, input.baseCurrency),
    qtyRemaining: Quantity.of(r.qty_remaining),
    effectiveDate: r.effective_at,
    postingSeq: BigInt(r.sequence),
    lineNo: r.line_no,
    movementNo: r.movement_no,
  }));
}

const pairKey = (itemId: string, warehouseId: string) => `${itemId}/${warehouseId}`;

/** One computed movement, ready to write. `value` is the MAGNITUDE; `effect` still carries the direction. */
interface Computed {
  planIndex: number;
  movementId: string;
  movement: PlannedMovement & { lotId: string };
  unitId: string;
  value: Money;
  unitCost: Money;
  consumptions: Consumption[];
  newLayerId: string | null;
}

/** 3D. Non-negative magnitude of a Money, as a Money. `abs()` is §4.2.1's own member. */
const mag = (m: Money): Money => m.abs();

/**
 * 3D (§4.7.2 amendment A7). A `transfer` line's ISSUE leg is costed first and prices the RECEIPT leg from
 * the consumed unit cost, BEFORE the destination layer is created — costing the receipt first would need a
 * cost for stock that has not yet left the source, which is why the costing order below is not negotiable.
 *
 * **Equal quantities take the whole issue value, without a division.** `divide` produces a `Money` at
 * MONEY_SCALE 4, so on a value that does not divide by its quantity the round trip loses a cent:
 * `10.0000 / 3 = 3.3333`, and `3.3333 x 3 = 9.9999`. On the common case — everything dispatched arrived —
 * that would hand the two legs of ONE line two different values: `1310` is debited |issue.value| at
 * dispatch and credited |receipt.value| at receipt, so the corridor would never clear and a cent would be
 * stranded on the account for ever. The quantities being equal is exactly the condition under which the
 * unit cost is not needed at all, so the division is skipped rather than rounded.
 *
 * Equal-quantity transfers retain the complete issue value in the destination layer (ADR 0039 amendment).
 */
function transferReceiptValue(
  issueValue: Money,
  issueQuantity: Quantity,
  receiptQuantity: Quantity,
): Money {
  if (issueQuantity.compare(receiptQuantity) === 0) return mag(issueValue);
  const unitCost = mag(issueValue).divide(issueQuantity.toDecimal(), "HALF_AWAY_FROM_ZERO");
  return unitCost.multiply(receiptQuantity.toDecimal(), "HALF_AWAY_FROM_ZERO");
}

/**
 * The movement a single-value line's cost is taken from: the line's ISSUE movement, or its first movement
 * (emission order, which is `movement_no` order) when it has none. The ONE definition of that figure, read in
 * three places so they cannot drift apart (code review 3, R7): `fillTaggedLedgerLines` fills a single-tag cost
 * leg from it — DELIVERY_ORDER's `1250`, TRANSFER's `1310` — `costByLine` writes `document_line.cost` from it,
 * and `convertToInvoice` (packages/db/src/ar-ap/invoice.ts) relieves the corridor by it. A line can carry more
 * than one movement — a `transfer` line carries its issue leg and its receipt leg — and the leg took ONE of
 * them, so an invoice that summed them relieved twice what the delivery debited.
 *
 * Generic over the movement's shape: the planned movement here, the stored row there, whose `effect` is the
 * sign of its quantity (an issue is stored negative — step 2 below).
 */
export function costLegMovement<M extends { readonly effect: string }>(
  movements: readonly M[],
): M | undefined {
  return movements.find((m) => m.effect === "issue") ?? movements[0];
}

/**
 * 3D (§4.7.2). Fills every planned ledger line the evaluator tagged with `fill` (§4.4.2's
 * `PlannedLedgerLine.fill`, ADR 0042) from the movements this call costed. `amount` and `base` are always
 * a NON-NEGATIVE magnitude and `side` is NEVER touched: the direction is the policy's, through a fixed
 * side or `when: { "line.quantity_sign": ... }` (§4.4.2 A9). Both members take the same figure because a
 * cost is already in the company's base currency (amendment A4).
 *
 * The rule is chosen by the TAGS the policy put on the source line, never by how many movements survived
 * the evaluator's zero-quantity drop:
 *   one tag kind on the line  -> that tag receives |the value of the movement `costLegMovement` names|:
 *                                the sole movement, or a transfer's issue leg (its pair at equal quantities
 *                                carries one value on both legs by construction, so the issue leg answers
 *                                for both);
 *   both tag kinds on the line (a two-quantity variance line):
 *     `cost`           -> |receipt.value|, Money.zero when the receipt leg is absent;
 *     `variance_value` -> | |issue.value| - |receipt.value| |, an absent leg counting as zero.
 *
 * That distinction is load-bearing. A TRANSFER_RECEIPT line whose `counted_quantity` is 0 — nothing
 * arrived — loses its receipt movement to the drop (`app.inventory_movement` carries `check (quantity <>
 * 0)`) and leaves ONE movement on a line the policy tagged with both kinds. Keyed on the movement COUNT,
 * both tags would take the dispatched value: the destination's inventory account would be debited in full
 * for goods that do not exist and `1310` credited twice, in a document that balances perfectly and is
 * entirely wrong.
 */
function fillTaggedLedgerLines(plan: PostingPlan, costed: readonly PlannedMovement[]): PostingPlan {
  const bySource = new Map<number, PlannedMovement[]>();
  for (const m of costed) {
    const list = bySource.get(m.lineNo) ?? [];
    list.push(m);
    bySource.set(m.lineNo, list);
  }
  // Which fill references the policy resolved on each source line. Two kinds on one line means the policy
  // is describing a matched value AND a difference, which is only true of a two-quantity variance line.
  const tagKinds = new Map<number, Set<NonNullable<PlannedLedgerLine["fill"]>>>();
  for (const l of plan.ledgerLines) {
    if (l.fill === undefined || l.sourceLineNo === null) continue;
    const kinds = tagKinds.get(l.sourceLineNo) ?? new Set<NonNullable<PlannedLedgerLine["fill"]>>();
    kinds.add(l.fill);
    tagKinds.set(l.sourceLineNo, kinds);
  }
  const ledgerLines = plan.ledgerLines.map((l) => {
    if (l.fill === undefined || l.sourceLineNo === null) return l;
    const ms = bySource.get(l.sourceLineNo);
    if (ms === undefined || ms.length === 0 || ms.some((m) => m.value === null)) return l;
    const issue = ms.find((m) => m.effect === "issue");
    const receipt = ms.find((m) => m.effect === "receipt");
    // `l.amount` is the plan's stand-in zero for a tagged line (amendment A5), so its currency is already
    // the base currency and the zero below needs no second source.
    const zero = Money.zero(l.amount.currency);
    let amount: Money;
    if ((tagKinds.get(l.sourceLineNo)?.size ?? 1) < 2) {
      // A single-value line — DELIVERY_ORDER, TRANSFER, STOCK_COUNT, EXPIRY_WRITE_OFF, PURCHASE_RETURN.
      amount = mag(costLegMovement(ms)!.value ?? zero);
    } else {
      // `arrivedValue`, not `receiptValue`: the module already imports a function of that name from
      // ./landed-cost and shadowing it here would be a `no-shadow` violation.
      const dispatchedValue = issue === undefined ? zero : mag(issue.value ?? zero);
      const arrivedValue = receipt === undefined ? zero : mag(receipt.value ?? zero);
      amount = l.fill === "cost" ? arrivedValue : mag(dispatchedValue.subtract(arrivedValue));
    }
    return { ...l, amount, base: amount };
  });
  // The evaluator's stand-in warning ("line N: cost is not yet computed; the costing engine fills it at
  // post") is false for every line this call filled, and `PostResult.warnings` is handed to the caller.
  // Before 3D the step-9 re-evaluation dropped it by re-planning from the costed snapshot.
  const prefixes = [...bySource]
    .filter(([, ms]) => ms.some((m) => m.value !== null))
    .map(([lineNo]) => `line ${lineNo}:`);
  const warnings = plan.warnings.filter((w) => !prefixes.some((p) => w.startsWith(p)));
  return { ...plan, ledgerLines, warnings };
}

/**
 * 3D. §4.3.2 step 6's zero-drop, applied once the costing engine has supplied the value the evaluator
 * could not (amendment A5). `evaluatePolicy` keeps a tagged line at Money.zero instead of dropping it,
 * because at step 6 a zero there means "not yet computed"; after the fill a zero means the value IS zero —
 * a free-of-charge issue (spec:1055, `costing: "zero"`), or the `cost` pair of a TRANSFER_RECEIPT where
 * nothing arrived — and the line is dropped exactly as the evaluator would have dropped it had the cost
 * been known. A tagged line whose source line has NO movement never arrives here at a zero —
 * `refuseUnfilledCost` refused it on entry (4A) — and one whose movement the engine somehow left unvalued
 * keeps its zero, which `postDocument`'s step-9b guard still refuses. `lineNo` is left as it stands: gaps
 * are legal under `unique (document_id, line_no)` and renumbering would move a line the caller may already
 * have logged.
 */
function dropFilledZeroLines(plan: PostingPlan, costed: readonly PlannedMovement[]): PostingPlan {
  const filled = new Set(costed.filter((m) => m.value !== null).map((m) => m.lineNo));
  return {
    ...plan,
    ledgerLines: plan.ledgerLines.filter(
      (l) =>
        l.fill === undefined ||
        l.sourceLineNo === null ||
        !l.amount.isZero() ||
        !filled.has(l.sourceLineNo),
    ),
  };
}

/**
 * 3D. `document_line.cost` per source line: the `fill: "cost"` magnitude when the policy addressed one,
 * otherwise the magnitude of the movement `costLegMovement` names — the sole movement, and for a `transfer`
 * line with no tag the value that LEFT the source warehouse, once, never the sum of both legs. Never negative
 * (§4.7.2), and zero on a total-loss transfer receipt. Read on the FILLED plan, before `dropFilledZeroLines`
 * removes a legitimately zero `cost` pair: the column follows the fill, not the survival of the ledger line.
 */
function costByLine(plan: PostingPlan): Map<number, Money> {
  const out = new Map<number, Money>();
  const costed = new Set(plan.movements.filter((m) => m.value !== null).map((m) => m.lineNo));
  for (const l of plan.ledgerLines) {
    // `costed.has` is what keeps an UNFILLED tag out of the column: a `fill: "cost"` line whose source line
    // produced no movement at all is either carrying a cost another document supplied (4A — the column
    // already holds it) or it was refused on entry by `refuseUnfilledCost`; nothing here computed it, so
    // nothing here may write it.
    if (
      l.fill === "cost" &&
      l.sourceLineNo !== null &&
      costed.has(l.sourceLineNo) &&
      !out.has(l.sourceLineNo)
    ) {
      out.set(l.sourceLineNo, mag(l.amount));
    }
  }
  const byLine = new Map<number, PlannedMovement[]>();
  for (const m of plan.movements) byLine.set(m.lineNo, [...(byLine.get(m.lineNo) ?? []), m]);
  for (const [lineNo, ms] of byLine) {
    const booked = costLegMovement(ms);
    if (out.has(lineNo) || booked === undefined || booked.value === null) continue;
    out.set(lineNo, mag(booked.value));
  }
  return out;
}

/**
 * Contracts §4.7.2 (4A amendment 4) — 2A's step-9b refusal, stated where step 9 now lives. A `fill`-tagged
 * planned ledger line whose source `document_line` has no surviving `PlannedMovement` is LEFT EXACTLY AS THE
 * EVALUATOR EMITTED IT: `fillTaggedLedgerLines` fills nothing on it and `costByLine` writes nothing for it.
 * Two cases reach that state, and they must be told apart:
 *
 *   - the source line carries a NON-NULL cost: a figure another document computed and this one copied forward
 *     (4A's two conversion services, §4.7.2's "who may write document_line.cost"). The line already stands at
 *     its real amount and needs no movement. This is every `SALES_INVOICE` and every credit note.
 *   - the source line's cost is NULL, so the line's amount is the evaluator's stand-in `Money.zero` (amendment
 *     A5 keeps it alive). Nothing will ever fill it, and inserting the zero would post a silent zero-value
 *     cost-of-goods-sold row. REFUSE, naming the document line.
 *
 * Both conditions are tested, not either alone: a genuinely zero cost that a movement filled is legal (a
 * free-of-charge line, spec:1055), and a non-zero amount with no movement is the copied-cost case. Pure, and
 * called FIRST — before `applyMovements`' no-movement return, because an `effect: "none"` plan carries no
 * movement and is exactly the plan this refuses, and before any read or write, so a refused document leaves
 * no row behind. `postDocument`'s step-9b zero guard stays as the backstop for a movement the engine left
 * unvalued; it cannot name the document line, which is why this refusal is not left to it.
 */
function refuseUnfilledCost(plan: PostingPlan, snapshot: DocumentSnapshot): void {
  const moved = new Set(plan.movements.map((m) => m.lineNo));
  for (const planned of plan.ledgerLines) {
    if (planned.fill === undefined) continue;
    if (planned.sourceLineNo !== null && moved.has(planned.sourceLineNo)) continue;
    const source =
      planned.sourceLineNo === null
        ? undefined
        : snapshot.lines.find((l) => l.lineNo === planned.sourceLineNo);
    if (planned.amount.isZero() && (source === undefined || source.cost === null)) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `document line ${planned.sourceLineNo ?? "?"} has no cost: document ${snapshot.header.id}'s policy plans a ${planned.fill} leg on it, no movement fills it, and no document supplied one. Raise this document by converting the delivery or receipt that carries the cost, or take the ${planned.fill} leg out of the policy`,
      );
    }
  }
}

/**
 * `postDocument` step 9 (contracts §4.3.2, §4.7.2) — the ONLY writer of `app.inventory_movement`,
 * `app.cost_layer` and `app.cost_consumption` anywhere in the system (the `posting-only-tables` lint
 * enforces it). The signature is 3A's and does not change; only the body grew.
 *
 * Compute first, write second, and write in exactly this order: the engine call (pure) for every movement in
 * COSTING order — emission order but for a `transfer` line's two legs, whose issue leg is costed before its
 * receipt leg prices itself from the result (3D) — threading each movement's layer effect into the next;
 * then, back in EMISSION order, the `inventory_movement` inserts
 * (the BEFORE INSERT `assert_stock_available` trigger fires here and counts this transaction's earlier rows);
 * then `cost_layer`, whose FK `(tenant_id, movement_id) → inventory_movement(tenant_id, id)` makes the
 * reverse order a `23503`; then `cost_consumption`, whose FK points at both; then `document_line.cost`.
 * `inventory_movement.value` is NOT NULL and an issue's value is not known until the engine has walked the
 * layers — which is why the compute pass cannot be interleaved with the inserts.
 *
 * Returns the plan with `value` filled on every movement AND with every ledger line the evaluator tagged
 * `fill` filled from those values (3D, §4.7.2) — `postDocument` step 9 posts what comes back from here.
 */
export async function applyMovements(
  tx: Sql,
  ctx: TenantContext,
  plan: PostingPlan,
  snapshot: DocumentSnapshot,
): Promise<PostingPlan> {
  // 4A (§4.7.2): the unfilled-cost refusal runs on EVERY plan, the movement-free ones included.
  refuseUnfilledCost(plan, snapshot);
  if (plan.movements.length === 0) return plan;

  const documentId = snapshot.header.id;
  const companyId = snapshot.header.companyId;
  const baseCurrency = snapshot.company.baseCurrency;
  const method: CostingMethod = snapshot.company.costingMethod;
  const effectiveDate = snapshot.header.effectiveDate;

  // posting_seq was assigned at step 8, before any row that carries it (contracts §4.3.2).
  const [doc] = await tx<{ posting_seq: string | null }[]>`
    select posting_seq::text as posting_seq from app.document where id = ${documentId}`;
  if (!doc?.posting_seq) {
    throw new PostingError(
      "ERR_INTERNAL",
      `document ${documentId} reached applyMovements with no posting_seq — step 8 of the posting algorithm did not run`,
    );
  }
  const postingSeq = BigInt(doc.posting_seq);

  // F-6 / test 18: the ONLY door to a shortfall is a recorded override event by a second principal (§4.5.3),
  // and since migration 0114 it admits only the stock lines it approved — `app.stock_override_admits`, the
  // one spelling the trigger asks too (spec:624, LEGACY-048 "who overrode what"). `recorded` is kept apart so a
  // refusal can say when an override exists but approved other lines than the document now carries.
  const [override] = await tx<{ admits: boolean; recorded: boolean }[]>`
    select app.stock_override_admits(${documentId}) as admits,
           exists (
             select 1 from app.document_event
              where document_id = ${documentId} and event_kind = 'override'
                and override_code = 'inventory.negative_stock.override') as recorded`;
  const overridden = override?.admits === true;
  const staleOverride = override?.recorded === true && !overridden;

  const sentinels = await loadSentinelLots(tx, [
    ...new Set(plan.movements.filter((m) => m.lotId === null).map((m) => m.itemId)),
  ]);
  const linesByNo = new Map(snapshot.lines.map((l) => [l.lineNo, l]));
  const ids = await tx<{ id: string }[]>`
    select uuidv7()::text as id from generate_series(1, ${plan.movements.length * 2})`;
  let nextId = 0;
  const takeId = (): string => {
    const row = ids[nextId];
    nextId += 1;
    if (row === undefined) {
      throw new PostingError(
        "ERR_INTERNAL",
        `document ${documentId}: applyMovements ran out of pre-generated identifiers`,
      );
    }
    return row.id;
  };

  // ── 0. Resolve each movement's lot and unit, purely ─────────────────────────────────────────────
  interface Resolved {
    planIndex: number;
    movement: PlannedMovement & { lotId: string };
    line: LineSnapshot;
    unitId: string;
  }
  const resolved: Resolved[] = plan.movements.map((movement, planIndex) => {
    const line = linesByNo.get(movement.lineNo);
    if (line === undefined) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `movement ${movement.movementNo} names line ${movement.lineNo}, which the snapshot does not have`,
      );
    }
    const lotId = movement.lotId ?? sentinels.get(movement.itemId) ?? null;
    if (lotId === null) {
      // Unreachable: migration 0029's item_sentinel_lot trigger creates the NONE lot with every item, and
      // 0031 makes inventory_movement.lot_id NOT NULL. Named loudly rather than passed through as a null
      // that would fail on the column instead of on the reason (ADR 0034).
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `item ${movement.itemId} has no '${SENTINEL_LOT_CODE}' lot; every item is created with one (ADR 0034)`,
      );
    }
    // The BASE unit, always: `inventory_movement.quantity` is in base units (3A — migration 0032's
    // document_line_base_quantity trigger is what converts the entered pair), so writing the line's ENTERED
    // unit here would leave the row's quantity and its unit disagreeing.
    const item = snapshot.refs.items[movement.itemId];
    if (item === undefined) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `item ${movement.itemId} is not in the snapshot's item map`,
      );
    }
    return { planIndex, movement: { ...movement, lotId }, line, unitId: item.baseUnitId };
  });

  // 3D. One identifier per movement, taken in EMISSION order and before the compute loop — which walks the
  // movements in COSTING order (a transfer line's issue leg before its receipt leg, below). Allocating
  // inside that loop would hand the two legs of a flipped transfer their identifiers in the reverse of the
  // order their rows are written in. Whatever is left in the pool stays with `takeId` for the layers.
  const movementIdByIndex = new Map(resolved.map((r) => [r.planIndex, takeId()]));

  // 3D (§4.7.2 amendment A7). The COSTING order, which is not the emission order. A `transfer` line emits
  // two legs on ONE line_no and the receipt leg is priced from the issue leg's consumed value (branch 2 of
  // the receipt-value rule below), so the issue leg must have been costed already when the receipt leg is
  // reached. The evaluator emits the WAREHOUSE leg first whichever way the stock is going, and `orientLeg`
  // flips a negatively resolved leg's effect, so emission order alone does not guarantee it. Lines keep
  // their emission order — only the two legs within a line are ordered, issue first — and every WRITE
  // below is put back into emission order, which `assert_stock_available` depends on.
  const firstIndexOfLine = new Map<number, number>();
  for (const r of resolved) {
    if (!firstIndexOfLine.has(r.movement.lineNo)) {
      firstIndexOfLine.set(r.movement.lineNo, r.planIndex);
    }
  }
  const costingOrder = resolved.toSorted(
    (a, b) =>
      (firstIndexOfLine.get(a.movement.lineNo) ?? a.planIndex) -
        (firstIndexOfLine.get(b.movement.lineNo) ?? b.planIndex) ||
      (a.movement.effect === "issue" ? 0 : 1) - (b.movement.effect === "issue" ? 0 : 1) ||
      a.planIndex - b.planIndex,
  );

  // The stock keys are locked BEFORE the first cost layer is READ and before the first movement row is
  // inserted, and stay locked for the rest of the transaction. `assert_stock_available` fires inside the
  // insert below and reads `sum(quantity)` over app.inventory_movement; §4.3.2 step 1's `for update` on
  // app.document serialises posters of one DOCUMENT and no more, so without this lock two documents issuing
  // the same (company, item, warehouse, lot) both read the same committed sum, both pass the trigger and
  // both commit — negative stock with no override event, which is acceptance test 18's invariant defeated by
  // concurrency alone. Contracts §4.7.2 says in as many words that 3B keeps this call: a body that computes
  // through costingEngine.cost() and inserts without locking reintroduces the double-issue, and no test in
  // 3B's own suite would catch it because the case is 3A's. See lockStockKeys' own comment and assumption 16
  // (READ COMMITTED is what makes the second transaction's re-read see the first's row).
  await lockStockKeys(
    tx,
    companyId,
    resolved.map((r) => ({
      itemId: r.movement.itemId,
      warehouseId: r.movement.warehouseId,
      lotId: r.movement.lotId,
    })),
  );

  // ── 1. Compute, purely, in emission order, threading the layer state ────────────────────────────
  const layerState = new Map<string, Layer[]>();
  const docCurrency = snapshot.header.currency;
  // Empty for every document but a shipment or a receipt someone allocated freight onto (§4.7.2 branch 3).
  const landedCost = await landedCostByLine(tx, documentId);
  /** Amendment A8's "one warning": a count surplus met with no open layer to take an average from. */
  const surplusWarnings: string[] = [];
  /** Every layer this document touched, at the value it ends the document with. Filled by the compute loop. */
  const finalRemaining = new Map<string, Quantity>();
  const computed: Computed[] = [];

  for (const { planIndex, movement, unitId } of costingOrder) {
    const key = pairKey(movement.itemId, movement.warehouseId);
    if (!layerState.has(key)) {
      layerState.set(
        key,
        await openLayersFor(tx, {
          companyId,
          itemId: movement.itemId,
          warehouseId: movement.warehouseId,
          baseCurrency,
        }),
      );
    }
    const openLayers = layerState.get(key)!;

    // ── The receipt-value rule (§4.7.2, four branches IN THIS ORDER — 3C) ─────────────────────────
    // Note 3 (3B) still holds for the issue branch: an ISSUE is costed from the layers, never from its
    // planned value, and the engine reads that value only to learn which currency to answer in — so every
    // issue gets the company's base-currency zero, unconditionally. That is what lets a free-of-charge line
    // (spec:1055) AND an authorised negative-stock excursion against an empty layer set (F-6) both post,
    // instead of one of them dying on ERR_COST_VALUE_MISSING. It is a SUBSTITUTION, not a fallback: an
    // issue's planned value would be a document-currency figure and would hand the engine the sales currency
    // to cost in. A RECEIPT keeps its own money: that value IS the layer's cost, and zeroing a
    // `costing: "zero"` receipt would open every free-of-charge receipt's layer at 0.0000.
    let value: Money | null;
    if (movement.effect === "issue") {
      value = Money.zero(baseCurrency);
    } else {
      const line = linesByNo.get(movement.lineNo) ?? null;
      // Branch 2's leg is already in `computed`: a transfer line emits its issue before its receipt (§4.7.3).
      const sameLineIssue = computed.find(
        (c) => c.movement.lineNo === movement.lineNo && c.movement.effect === "issue",
      );
      // A COUNTED line carries both count columns: a STOCK_COUNT line (branch 2b) or a TRANSFER_RECEIPT line
      // (branch 2). Branch 1 never prices one, whoever wrote its `cost`: no drafting service sets `cost` on
      // a counted line (count.ts and transfer.ts insert it NULL) and reverseDocument's mirror copies `cost`
      // but not the count columns, so a counted line that reaches a post with a cost carries a figure an
      // `app_rw` session wrote by hand while it was a draft, where 0113 admits every change. Priced by
      // branch 1, that figure became the value of a STOCK_COUNT surplus the checker never approved — maker ≠
      // checker defeated one status before 0113's issued-line rule (code review 3, R2). Section 6 writes the
      // computed figure over it. The test reads the line's own columns, which that same draft write can
      // clear: a line UN-counted that way is not counted here and would be priced by branch 1 or 3. Under an
      // approval-required policy it never reaches this branch — postDocument's step 6g refuses a moved line
      // whose rules chose its direction from the sign of its variance and which lacks either count column,
      // and step 6e refuses a moved line that meets no rule at all (its kind changed) — so this order is the
      // valuation rule and those steps are the control.
      const counted =
        line !== null && line.expectedQuantity !== null && line.countedQuantity !== null;
      if (line?.cost != null && !counted && !sameLineIssue) {
        // 1. An already-costed one-leg line: a reversal (whose copy carries `cost` — reverse.ts) or a re-post. A4
        //    makes it base currency and a magnitude, so it is used as it stands.
        value = line.cost;
      } else if (sameLineIssue) {
        // 2. The transfer case, including a reversal with a copied line cost: what left the first warehouse is what arrives at the second. Re-pricing it
        //    from `line.amount` would create value out of a movement. 3D's TRANSFER_RECEIPT depends on
        //    this, and on the two legs not having to carry ONE quantity: `transferReceiptValue` prices an
        //    unequal receipt from the issue leg's consumed unit cost and hands an equal one the issue's
        //    value whole (§4.7.2 amendment A7). The issue leg is in `computed` because the COSTING ORDER
        //    put it there, never because of emission order, which `orientLeg` may flip.
        value = transferReceiptValue(
          sameLineIssue.value,
          sameLineIssue.movement.quantity,
          movement.quantity,
        );
      } else if (line !== null && counted) {
        // 2b. A COUNTED line's receipt — a STOCK_COUNT surplus (3D amendment A8, contracts §4.7.1). Stock that
        //     simply appeared has no purchase price: `line.amount` is the sheet's placeholder zero, and
        //     branch 3 would open the layer at 0.0000 and post a ledger of nothing. It is valued at
        //     `average(openLayers)` instead; with no open layer that average is zero and one warning says so.
        //     A TRANSFER_RECEIPT line also carries both count columns, but branch 2 has already taken it.
        value = costingEngine
          .average(openLayers, baseCurrency)
          .multiply(movement.quantity.toDecimal(), "HALF_AWAY_FROM_ZERO");
        if (!openLayers.some((l) => !l.qtyRemaining.isZero() && !l.qtyRemaining.isNegative())) {
          surplusWarnings.push(
            `line ${movement.lineNo}: a count surplus of ${movement.quantity.toString()} met no open cost ` +
              `layer, so it is valued at zero (amendment A8)`,
          );
        }
      } else if (line) {
        // 3. The genuine purchase-side receipt: GOODS_RECEIPT, SHIPMENT, 9B's OPENING_STOCK.
        const allocated = landedCost.get(line.id);
        value = receiptValue(
          line,
          allocated === undefined ? Money.zero(docCurrency) : Money.of(allocated, docCurrency),
          snapshot.header.exchangeRate,
        );
      } else {
        // 4. No source line at all — an internal inconsistency, not a free receipt. Left null on purpose so
        //    the engine raises ERR_COST_VALUE_MISSING naming the movement (LEGACY-007).
        value = null;
      }
    }
    const movementId = movementIdByIndex.get(planIndex)!;

    const cancellation =
      movement.effect === "issue"
        ? await purchaseCancellation(tx, {
            companyId,
            documentId,
            lineNo: movement.lineNo,
            itemId: movement.itemId,
            warehouseId: movement.warehouseId,
            lotId: movement.lotId,
            quantity: movement.quantity,
            baseCurrency,
          })
        : undefined;
    if (movement.effect === "issue") {
      await assertCancellationChronology(tx, {
        companyId,
        itemId: movement.itemId,
        warehouseId: movement.warehouseId,
        effectiveDate,
        postingSeq,
        baseCurrency,
      });
    }
    if (cancellation) {
      const [pending] = await tx<{ pending: boolean }[]>`
        select exists (select 1 from app.cost_booking b join app.inventory_movement m on m.tenant_id = b.tenant_id and m.id = b.movement_id
          where b.company_id = ${companyId} and m.item_id = ${movement.itemId} and m.warehouse_id = ${movement.warehouseId} and b.pending is not null)
          or exists (select 1 from app.cost_layer l where l.company_id = ${companyId} and l.item_id = ${movement.itemId} and l.warehouse_id = ${movement.warehouseId} and l.invalidated_at is not null) as pending`;
      if (pending?.pending)
        throw new PostingError(
          "ERR_DOC_STATUS_ILLEGAL",
          "purchase reversal requires completed cost replay; finish replay before reversing",
        );
    }
    let out;
    try {
      out = costingEngine.cost({
        method,
        ...(cancellation ? { cancellation } : {}),
        openLayers,
        allowShortfall: movement.costing === "zero" || overridden,
        movement: { ...movement, value, effectiveDate, postingSeq, movementId },
      });
    } catch (error) {
      // packages/domain may not import AppError, so the engine throws its own class and the hook translates
      // it to the code postDocument's caller already knows how to render (§4.2.4, amendment A3).
      if (error instanceof CostingError) {
        throw new PostingError(
          error.code,
          error.code === "ERR_STOCK_INSUFFICIENT" && staleOverride
            ? `${error.detail}; the negative-stock override on document ${documentId} approved other stock lines than it now carries — record the override again`
            : error.detail,
        );
      }
      throw error;
    }

    const remaining = new Map(out.updatedRemaining.map((u) => [u.layerId, u.qtyRemaining]));
    const next: Layer[] = openLayers.map((l) => {
      const after = remaining.get(l.id);
      return after === undefined ? l : { ...l, qtyRemaining: after };
    });
    let newLayerId: string | null = null;
    if (out.newLayer !== null) {
      newLayerId = takeId();
      next.push({ ...out.newLayer, id: newLayerId });
    }
    // Emptied layers are KEPT in the state, not filtered out. The engine already ignores a zero-remaining
    // layer (its own `open` filter), and dropping one here loses the final figure for a layer created and
    // fully consumed by the SAME document — the write below would then fall back to `qty_in` and store a
    // residue the document does not have.
    layerState.set(key, next);
    for (const l of next) finalRemaining.set(l.id, l.qtyRemaining);

    computed.push({
      planIndex,
      movementId,
      movement,
      unitId,
      value: out.value,
      unitCost: out.unitCost,
      consumptions: out.consumptions,
      newLayerId,
    });
  }

  // 3D. Back into EMISSION order for every write below. Only the compute pass runs in costing order; the
  // rows must land in the order the evaluator emitted them, for the reason stated in section 2.
  const inEmissionOrder = computed.toSorted((a, b) => a.planIndex - b.planIndex);

  // ── 2. The movements, in emission order — assert_stock_available fires per row ───────────────────
  // The order is load-bearing: the trigger sums `app.inventory_movement` for the same
  // (company, item, warehouse, lot) and therefore sees this transaction's EARLIER rows (§4.7.3). A document
  // that receives on line 1 and issues on line 2, or a transfer whose source leg must land before its
  // destination leg, is correct only in this order — a single multi-row insert would fire the trigger per row
  // in an order Postgres does not promise.
  for (const c of inEmissionOrder) {
    const signedQuantity =
      c.movement.effect === "issue" ? c.movement.quantity.negate() : c.movement.quantity;
    const signedValue = c.movement.effect === "issue" ? c.value.negate() : c.value;
    await tx`
      insert into app.inventory_movement
        (id, tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
      values (${c.movementId}, ${ctx.tenantId}, ${companyId}, ${documentId}, ${c.movement.lineNo},
              ${c.movement.movementNo}, ${c.movement.itemId}, ${c.movement.warehouseId},
              ${c.movement.lotId}, ${c.unitId}, ${signedQuantity.toString()}, ${signedValue.toString()},
              ${effectiveDate}, ${postingSeq.toString()})`;
  }

  // ── 3. The new layers, at their FINAL qty_remaining ─────────────────────────────────────────────
  // One write per layer, not one per consumption: the compute pass already recorded what each layer ends at
  // in `finalRemaining`, and `unique (movement_id)` makes a second row for the same receipt impossible.
  for (const c of inEmissionOrder) {
    if (c.newLayerId === null) continue;
    const remaining = finalRemaining.get(c.newLayerId) ?? c.movement.quantity;
    await tx`
      insert into app.cost_layer
        (id, tenant_id, company_id, item_id, warehouse_id, lot_id, movement_id, qty_in, unit_cost, value,
         qty_remaining, effective_at, sequence)
      values (${c.newLayerId}, ${ctx.tenantId}, ${companyId}, ${c.movement.itemId},
              ${c.movement.warehouseId}, ${c.movement.lotId}, ${c.movementId},
              ${c.movement.quantity.toString()}, ${c.unitCost.toString()}, ${c.value.toString()}, ${remaining.toString()},
              ${effectiveDate}, ${postingSeq.toString()})`;
  }

  // ── 4. The consumptions, then the pre-existing layers' residues ─────────────────────────────────
  for (const c of inEmissionOrder) {
    for (const consumption of c.consumptions) {
      await tx`
        insert into app.cost_consumption
          (tenant_id, company_id, movement_id, layer_id, quantity, unit_cost, value)
        values (${ctx.tenantId}, ${companyId}, ${c.movementId}, ${consumption.layerId},
                ${consumption.quantity.toString()}, ${consumption.unitCost.toString()},
                ${consumption.value.toString()})`;
    }
  }
  // Only PRE-EXISTING layers need an UPDATE — a layer this document created was inserted at its final figure
  // two steps above, and updating it again would be a second write for no gain.
  const created = new Set(
    computed.map((c) => c.newLayerId).filter((id): id is string => id !== null),
  );
  const touched = new Set(
    computed.flatMap((c) => c.consumptions.map((k) => k.layerId)).filter((id) => !created.has(id)),
  );
  for (const layerId of touched) {
    const remaining = finalRemaining.get(layerId) ?? Quantity.zero();
    await tx`
      update app.cost_layer set qty_remaining = ${remaining.toString()} where id = ${layerId}`;
  }

  // ── 5. Fill `value` on the plan's movements (contracts §4.7.2) ──────────────────────────────────
  const byPlanIndex = new Map(computed.map((c) => [c.planIndex, c]));
  const movements = plan.movements.map((m, index) => {
    const c = byPlanIndex.get(index)!;
    return { ...m, lotId: c.movement.lotId, value: c.value };
  });

  // ── 6. 3D: the tagged ledger lines, then document_line.cost ─────────────────────────────────────
  // The evaluator left every line that addresses `line.cost` or `line.variance_value` at a stand-in zero
  // (amendment A5) because the cost did not exist at step 6; it exists now, and this is the one place that
  // holds both the tags and the costed movements. A re-read of `document_line.cost` cannot serve instead:
  // the two references resolve from that ONE column (evaluate.ts's `lineAmount`), and a two-quantity
  // variance line needs two different figures out of it.
  const filled = fillTaggedLedgerLines({ ...plan, movements }, movements);

  // `document_line.cost` — read off the filled plan BEFORE the zero-drop, base currency, magnitude, one
  // figure per source line (4A and 7B read this column; branch 1 above reads it back on a reversal).
  //
  // This UPDATE runs migration 0032's `document_line_base_quantity` BEFORE UPDATE trigger. It is a no-op
  // here: `unit_id`, `unit_quantity` and `quantity` are unchanged, so the trigger re-derives the same figure
  // and its agreement branch passes. It also runs 0113's `document_line_frozen_after_draft`, which freezes
  // every column of a non-draft line but `cost` and admits a `cost` change at `issued` — the status step 7
  // left this document in — only inside the posting transaction: step 8 has set `posting_seq` and step 2
  // above has inserted the line's movement (code review 3, R2). So this is the write that guard exists to let
  // through, and the only one.
  for (const [lineNo, cost] of costByLine(filled)) {
    await tx`
      update app.document_line set cost = ${cost.toString()}
       where document_id = ${documentId} and line_no = ${lineNo}`;
  }

  // After the fill, whose own filter drops every `line N:` warning on a costed line — this one is true.
  return dropFilledZeroLines(
    surplusWarnings.length === 0
      ? filled
      : { ...filled, warnings: [...filled.warnings, ...surplusWarnings] },
    movements,
  );
}
