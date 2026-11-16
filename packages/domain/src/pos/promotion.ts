import { Money, type CurrencyCode } from "../money/money";
import { Quantity } from "../money/quantity";
import type { RoundingMode } from "../money/rounding";

/**
 * The promotion arithmetic the till prices with and the server verifies with (ADR 0059's PR 12 review
 * amendment). One function, so a promotion the till applies offline is recomputed by the server from the same
 * definition, the same unit price and the same quantity, and the two can only agree or refuse — never drift.
 */

const MODE: RoundingMode = "HALF_AWAY_FROM_ZERO"; // hazard 23's mode, the till's and 6C's for the same reason

/** An unsigned plain decimal, as the catalogue stream delivers a definition's figures (numbers become text). */
const DECIMAL = /^\d+(\.\d+)?$/;
/** A money-scale amount: `Money.of` refuses more than four places, so a fifth makes the definition malformed. */
const AMOUNT = /^\d+(\.\d{1,4})?$/;
/** A quantity-scale figure, for the same reason at six places. */
const QUANTITY = /^\d+(\.\d{1,6})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** 3A's `kind` (`promotion_kind_check`) and `definition jsonb`, as the till's mirror or the server's row hold them. */
export interface PromotionTerms {
  kind: string;
  /** The definition with its top-level numbers as decimal text — the catalogue stream's normal form. */
  definition: unknown;
}

export interface PromotionLine<C extends CurrencyCode> {
  itemId: string;
  /** The line's actual unit price — a price override included — never negative (§4.4.2: a price is a price). */
  unitPrice: Money<C>;
  /** Either sign: a return's negative quantity is discounted by its magnitude, as a sale's is. */
  quantity: Quantity;
}

const text = (value: unknown, pattern: RegExp): string | null =>
  typeof value === "string" && pattern.test(value) ? value : null;

/**
 * The discount ONE promotion gives ONE line, as a magnitude: never negative, never more than the line's gross,
 * and **zero** when the promotion does not apply — the item is not in `itemIds`, the promotion is in another
 * currency, its kind is one this build does not know, or a figure in its definition is malformed. A definition
 * nobody can read is no promotion, never a guessed one; the till then sells at the list price and the server
 * refuses evidence that claims otherwise.
 *
 * One shape per `kind`, the shapes 6B Task 5 defined as the reader of 3A's column:
 *  - `percent_off` `{ itemIds, percent }` — `percent` a fraction ("0.100000" is ten per cent) of the line gross;
 *  - `amount_off` `{ itemIds, amountPerUnit, currency }` — that much off each unit;
 *  - `bundle` `{ itemIds, groupQuantity, groupPrice, currency }` — each complete group at `groupPrice`.
 *
 * Exact throughout: the gross is `unitPrice × |quantity|` rounded once to money scale, as the ticket's own gross
 * is, and a bundle's group count is `Decimal.divToInt`, never a float.
 */
export function promotionDiscount<C extends CurrencyCode>(
  terms: PromotionTerms,
  line: PromotionLine<C>,
): Money<C> {
  const cur = line.unitPrice.currency;
  const zero = Money.zero(cur);
  const def = terms.definition;
  if (typeof def !== "object" || def === null || Array.isArray(def)) return zero;
  const d = def as Record<string, unknown>;
  const items = d["itemIds"];
  if (!Array.isArray(items) || !items.some((id) => id === line.itemId)) return zero;

  const magnitude = line.quantity.isNegative() ? line.quantity.negate() : line.quantity;
  const gross = line.unitPrice.abs().multiply(magnitude.toString(), MODE);
  const sameCurrency = () => text(d["currency"], CURRENCY) === (cur as string);

  let discount = zero;
  switch (terms.kind) {
    case "percent_off": {
      const percent = text(d["percent"], DECIMAL);
      if (percent !== null) discount = gross.multiply(percent, MODE);
      break;
    }
    case "amount_off": {
      const perUnit = text(d["amountPerUnit"], AMOUNT);
      if (perUnit !== null && sameCurrency())
        discount = Money.of(perUnit, cur).multiply(magnitude.toString(), MODE);
      break;
    }
    case "bundle": {
      const groupQuantity = text(d["groupQuantity"], QUANTITY);
      const groupPrice = text(d["groupPrice"], AMOUNT);
      if (groupQuantity === null || groupPrice === null || !sameCurrency()) break;
      const size = Quantity.of(groupQuantity).toDecimal();
      if (size.isZero()) break; // a group of nothing is no bundle, and divToInt by zero is Infinity
      // How many complete groups the line contains, as an exact decimal integer and never a float.
      const groups = magnitude.toDecimal().divToInt(size);
      if (groups.lessThanOrEqualTo(0)) break;
      const listPrice = line.unitPrice.abs().multiply(size.times(groups).toFixed(6), MODE);
      const bundlePrice = Money.of(groupPrice, cur).multiply(groups.toFixed(6), MODE);
      discount = listPrice.subtract(bundlePrice);
      break;
    }
    default:
      // 3A's CHECK admits three kinds. A fourth means the catalogue is ahead of this build, and the safe answer
      // is "no promotion" — never a guessed interpretation of a definition nobody wrote.
      break;
  }
  if (discount.isZero() || discount.isNegative()) return zero;
  // Never more than the line is worth: a promotion that outran the price would produce a negative line.
  return discount.compare(gross) > 0 ? gross : discount;
}

/**
 * Whether a promotion's window contains an instant — **both ends inclusive**, as the till has always read it and
 * as `listPromotions`' `activeOn` does. A NULL end is open.
 *
 * Instants are compared, never their text (PR 12 review): the mirrored bounds are PostgreSQL's `to_jsonb`
 * rendering of a `timestamptz` — `2026-06-30T23:59:59+00:00`, or `+08:00` under another session time zone, or
 * with microseconds — and the till's clock is `Date.toISOString()`'s `…59.000Z`. As text, `'+'` sorts before
 * `'.'`, so a promotion was dropped at the very instant it ended, and a non-UTC offset shifted every window by
 * hours. `Date.parse` reads every one of those forms to the millisecond (sub-millisecond digits truncate, on
 * the till and the server alike). A bound that does not parse makes the promotion inactive: an unreadable
 * window is no window anyone chose.
 */
export function promotionActiveAt(
  window: { startsAt: string | null; endsAt: string | null },
  at: Date | string,
): boolean {
  const instant = typeof at === "string" ? Date.parse(at) : at.getTime();
  if (!Number.isFinite(instant)) return false;
  if (window.startsAt !== null) {
    const start = Date.parse(window.startsAt);
    if (!Number.isFinite(start) || start > instant) return false;
  }
  if (window.endsAt !== null) {
    const end = Date.parse(window.endsAt);
    if (!Number.isFinite(end) || end < instant) return false;
  }
  return true;
}
