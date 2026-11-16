import { Quantity } from "../money/quantity";

/** A price list as both sides hold it: 3A's `app.price_list` columns the resolver reads (contracts §4.6.1). */
export interface PriceListCandidate {
  id: string;
  code: string;
  currency: string;
  customerKind: string | null;
  branchId: string | null;
  /** `YYYY-MM-DD` or null; a `date` column, compared to a date. */
  validFrom: string | null;
  validTo: string | null;
}

/** One `app.price_list_line` (non-archived), with its quantity and price as decimal text. */
export interface PriceListLineCandidate {
  id: string;
  priceListId: string;
  itemId: string;
  unitId: string | null;
  minQuantity: string;
  unitPrice: string;
}

export interface PriceSelectionQuery {
  itemId: string;
  currency: string;
  /** The line quantity as decimal text, compared against `min_quantity`. */
  quantity: string;
  /** The business date, `YYYY-MM-DD`. */
  on: string;
  /** The unit priced; `null` matches only lines whose `unit_id` is null (the item's base unit). */
  unitId: string | null;
  /** The trade level; `null` admits only lists whose `customer_kind` is null. */
  customerKind: string | null;
  /** The branch; `null` admits only company-wide lists. */
  branchId: string | null;
}

export interface PriceSelection {
  list: PriceListCandidate;
  line: PriceListLineCandidate;
}

/** 0 sorts first: a specific (non-null) column before a null one. */
const rank = (specific: boolean): number => (specific ? 0 : 1);

/**
 * The price-list rule of `packages/db/src/inventory/prices.ts`'s `resolvePrice`, as a pure function, so the till
 * (which prices offline and whose price the server never re-computes — `packages/db/src/sync/limits.ts`,
 * decision (c)) answers exactly what the server's resolver answers for the same catalogue (POS-02).
 *
 * Candidates: a list matching `currency`, whose window contains `on`, whose `branch_id` is null or `branchId`,
 * whose `customer_kind` is null or `customerKind`; with a line for the item whose `unit_id` is null or `unitId`
 * and whose `min_quantity <= quantity`. Most specific first: branch-specific, then trade-level-specific, then
 * unit-specific, then the largest quantity break, then the list code ascending. Archived rows are the caller's
 * to leave out (neither side's input holds them). The code tiebreak compares UTF-16 code units; the server's
 * `order by code` uses the database collation, which agrees for the upper-case ASCII codes a shop types.
 */
export function selectPrice(
  lists: readonly PriceListCandidate[],
  lines: readonly PriceListLineCandidate[],
  q: PriceSelectionQuery,
): PriceSelection | null {
  const quantity = Quantity.of(q.quantity);
  const byId = new Map<string, PriceListCandidate>();
  for (const l of lists) {
    if (l.currency !== q.currency) continue;
    if (l.validFrom !== null && l.validFrom > q.on) continue;
    if (l.validTo !== null && l.validTo < q.on) continue;
    if (l.branchId !== null && l.branchId !== q.branchId) continue;
    if (l.customerKind !== null && l.customerKind !== q.customerKind) continue;
    byId.set(l.id, l);
  }
  const candidates: { list: PriceListCandidate; line: PriceListLineCandidate; min: Quantity }[] =
    [];
  for (const line of lines) {
    const list = byId.get(line.priceListId);
    if (list === undefined || line.itemId !== q.itemId) continue;
    if (line.unitId !== null && line.unitId !== q.unitId) continue;
    const min = Quantity.of(line.minQuantity);
    if (min.compare(quantity) > 0) continue;
    candidates.push({ list, line, min });
  }
  candidates.sort(
    (a, b) =>
      rank(a.list.branchId !== null) - rank(b.list.branchId !== null) ||
      rank(a.list.customerKind !== null) - rank(b.list.customerKind !== null) ||
      rank(a.line.unitId !== null) - rank(b.line.unitId !== null) ||
      b.min.compare(a.min) ||
      (a.list.code < b.list.code ? -1 : a.list.code > b.list.code ? 1 : 0),
  );
  const best = candidates[0];
  return best === undefined ? null : { list: best.list, line: best.line };
}
