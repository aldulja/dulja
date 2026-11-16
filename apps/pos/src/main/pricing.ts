import {
  computeTaxLine,
  type TaxCodeDef,
  Money,
  Quantity,
  currency,
  promotionActiveAt,
  promotionDiscount,
  selectPrice,
  type CurrencyCode,
  type PriceListCandidate,
  type PriceListLineCandidate,
  type RoundingMode,
} from "@dulja/domain";
import { PERMISSION } from "@dulja/contracts";
import type { PosDatabase } from "./database";
import { TillError } from "./errors";
import { requireCode, type TillCashier } from "./authority";

export interface TillItem {
  itemId: string;
  code: string;
  barcode: string | null;
  nameEn: string;
  nameAr: string | null;
  baseUnitId: string;
  trackLots: boolean;
  stockHint: string | null;
  stockHintAt: string | null;
}

export interface PriceRequest {
  itemId: string;
  unitId?: string | null;
  quantity: Quantity;
  customerId?: string | null;
  at?: Date;
}

export interface PriceQuote {
  itemId: string;
  unitId: string;
  unitPrice: Money;
  priceListId: string | null;
  promotionId: string | null;
  promotionDiscount: Money;
  source: "price_list" | "no_price";
}

export interface TaxedLine {
  taxCodeId: string | null;
  base: Money;
  tax: Money;
  total: Money;
}
export interface PriceCheckResult {
  item: TillItem;
  quote: PriceQuote;
  taxed: TaxedLine;
}

/**
 * The till's own currency, read from its price lists rather than declared.
 *
 * **There is no `Seed.currency` and no company row at the till** (the header's fact (1)), so a module
 * constant `"MYR"` here would be a jurisdiction fact this plan may not state. The server refuses a ticket in
 * any currency but the company's (`packages/db/src/sync/apply.ts`, D-currency), so the answer is the currency
 * of the lists a walk-in at this till can be priced from — this branch's and the company-wide ones at the
 * till's trade level (`customer_kind` null, `TILL_TRADE_LEVEL`) — or, when there are none, of every list the
 * till holds. **Never the first list by code** (POS-02): a company-wide foreign-currency list that sorts first
 * would otherwise set the shift's currency. When those lists disagree the till cannot tell which is the
 * company's and says so, rather than guess; the company's base currency is not mirrored to the till.
 */
export function tillCurrency(db: PosDatabase): CurrencyCode {
  const branchId = tillBranchId(db);
  const currencies = (walkInOnly: boolean): string[] =>
    db.raw
      .prepare<[string | null, number], { currency: string }>(
        `select distinct currency from catalogue_price_list
          where (branch_id is null or branch_id = ?) and (? = 0 or customer_kind is null)
          order by currency`,
      )
      .all(branchId, walkInOnly ? 1 : 0)
      .map((r) => r.currency);
  let found = currencies(true);
  if (found.length === 0) found = currencies(false);
  if (found.length === 0) {
    throw new TillError(
      "ERR_TILL_CATALOGUE_STALE",
      "this till holds no price list and cannot price a ticket",
    );
  }
  if (found.length > 1) {
    throw new TillError(
      "ERR_TILL_CATALOGUE_STALE",
      `this till's price lists are in ${found.join(", ")}; it cannot tell which is the company's currency`,
    );
  }
  return currency(found[0]!);
}

/**
 * spec:1345's honest failure. A till whose `catalogue_pulled_at` is absent has never completed a pull, so
 * every mirror is empty and every price would be a guess. `ERR_TILL_CATALOGUE_STALE` is the answer, and the
 * offline indicator (T3's `SyncState`) shows the same two facts the cashier needs to fix it.
 */
export function assertCatalogueFresh(db: PosDatabase): void {
  const pulled = db.raw
    .prepare<[], { value: string }>("select value from meta where key = 'catalogue_ready'")
    .get();
  if (pulled?.value !== "1") {
    throw new TillError(
      "ERR_TILL_CATALOGUE_STALE",
      "this till has never completed a catalogue update and cannot price a ticket",
    );
  }
}

interface ItemDbRow {
  id: string;
  code: string;
  barcode: string | null;
  name_en: string;
  name_ar: string | null;
  base_unit_id: string;
  track_lots: number;
  stock_hint: string | null;
  stock_hint_at: string | null;
}
const toItem = (r: ItemDbRow): TillItem => ({
  itemId: r.id,
  code: r.code,
  barcode: r.barcode,
  nameEn: r.name_en,
  nameAr: r.name_ar,
  baseUnitId: r.base_unit_id,
  trackLots: r.track_lots === 1,
  stockHint: r.stock_hint,
  stockHintAt: r.stock_hint_at,
});

export function findItemByBarcode(db: PosDatabase, barcode: string): TillItem | null {
  const row = db.raw
    .prepare<[string], ItemDbRow>(
      `select id, code, barcode, name_en, name_ar, base_unit_id, track_lots, stock_hint, stock_hint_at from catalogue_item where barcode = ?`,
    )
    .get(barcode);
  return row === undefined ? null : toItem(row);
}

export function findItemByCode(db: PosDatabase, code: string): TillItem | null {
  const row = db.raw
    .prepare<[string], ItemDbRow>(
      `select id, code, barcode, name_en, name_ar, base_unit_id, track_lots, stock_hint, stock_hint_at from catalogue_item where code = ?`,
    )
    .get(code);
  return row === undefined ? null : toItem(row);
}

/**
 * Search by code or by **either** name.
 *
 * `name_ar` is in the `where` for a reason that is not symmetry: spec:2061 and acceptance test 23 make Arabic
 * a first-class direction, and a shop whose staff read the Arabic label would otherwise be unable to find any
 * item by name at all. SQLite's `like` is ASCII-case-insensitive only, which is exactly right here — Arabic
 * has no case — and the `lower()` on both sides covers the Latin half.
 */
export function searchItems(db: PosDatabase, text: string, limit = 20): TillItem[] {
  const needle = `%${text.trim().toLowerCase()}%`;
  return db.raw
    .prepare<[string, string, string, number], ItemDbRow>(
      `select id, code, barcode, name_en, name_ar, base_unit_id, track_lots, stock_hint, stock_hint_at from catalogue_item
      where lower(code) like ? or lower(name_en) like ? or lower(coalesce(name_ar, '')) like ?
      order by code limit ?`,
    )
    .all(needle, needle, needle, limit)
    .map(toItem);
}

/**
 * Which price list applies (POS-02; ADR 0057's 2026-11-15 amendment).
 *
 * 1. **The customer's own list**, when the ticket has a customer and that customer's mirrored row carries a
 *    `price_list_id` — §3.7.6's *"customer-specific pricing"* (A10b). It is the one way a ticket reaches a list
 *    with a trade level: `app.party` has no trade level of its own.
 * 2. **Otherwise the server's rule**, through the domain's `selectPrice` — the same candidate filters and the
 *    same order as `packages/db/src/inventory/prices.ts`'s `resolvePrice`: the till's currency, the business
 *    date inside the window, this branch's lists and the company-wide ones, the till's trade level
 *    (`TILL_TRADE_LEVEL`, so a list tagged `wholesale` — or any level — never prices a walk-in), and then
 *    branch-specific, unit-specific, the largest quantity break, the code. The server never re-prices a ticket
 *    (`packages/db/src/sync/limits.ts`, decision (c)), so any other rule here posts a price nobody chose.
 *
 * One deliberate narrowing of the server's rule: a line whose `unit_id` is null is the item's **base unit**
 * price (3A), so it prices only a base-unit request. The server's SQL admits it for any unit.
 *
 * **The till's branch is not a parameter.** It is the branch the terminal was enrolled into
 * (`meta.branch_id`), falling back to the one `catalogue_branch_pos_policy` row only for a file enrolled
 * before that key existed — a branch with no policy row keeps its own lists and promotions (POS-16).
 */
function tillBranchId(db: PosDatabase): string | null {
  const meta = db.raw
    .prepare<[], { value: string }>("select value from meta where key = 'branch_id'")
    .get();
  if (meta !== undefined && meta.value !== "") return meta.value;
  const row = db.raw
    .prepare<[], { branch_id: string }>(
      "select branch_id from catalogue_branch_pos_policy order by id limit 1",
    )
    .get();
  return row?.branch_id ?? null;
}

/**
 * The trade level a till sells at: `null`, the server resolver's answer for a caller that names no
 * `customerKind`. No party carries a trade level, and none is configured per till or branch; whether a till
 * should sell at a named level is an owner question (ADR 0057's 2026-11-15 amendment).
 */
const TILL_TRADE_LEVEL: string | null = null;

interface PriceListDbRow {
  id: string;
  code: string;
  currency: string;
  customer_kind: string | null;
  branch_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
}
interface PriceListLineDbRow {
  id: string;
  price_list_id: string;
  unit_id: string | null;
  min_quantity: string;
  unit_price: string;
}

const toList = (l: PriceListDbRow): PriceListCandidate => ({
  id: l.id,
  code: l.code,
  currency: l.currency,
  customerKind: l.customer_kind,
  branchId: l.branch_id,
  validFrom: l.valid_from,
  validTo: l.valid_to,
});

/** The business date the till compares list windows and tax-code windows against (POS-05: still UTC). */
const businessDay = (at: Date): string => at.toISOString().slice(0, 10);

function customerPriceList(
  db: PosDatabase,
  customerId: string | null,
  lists: readonly PriceListCandidate[],
): PriceListCandidate | null {
  if (customerId === null) return null;
  const cust = db.raw
    .prepare<[string], { row_json: string }>("select row_json from catalogue_customer where id = ?")
    .get(customerId);
  if (cust === undefined) return null;
  const listId =
    (JSON.parse(cust.row_json) as { price_list_id?: string | null }).price_list_id ?? null;
  return lists.find((l) => l.id === listId) ?? null;
}

export function resolvePrice(db: PosDatabase, req: PriceRequest): PriceQuote {
  assertCatalogueFresh(db);
  const cur = tillCurrency(db);
  const at = req.at ?? new Date();
  const item = db.raw
    .prepare<[string], { base_unit_id: string }>(
      "select base_unit_id from catalogue_item where id = ?",
    )
    .get(req.itemId);
  if (item === undefined) {
    throw new TillError("ERR_NOT_FOUND", `no item ${req.itemId} in this till's catalogue`);
  }
  const unitId = req.unitId ?? item.base_unit_id;
  // `unit_id is null` in 3A means "the item's base unit", so a request for the base unit must match BOTH the
  // explicit row and the null row, and a request for any other unit must not see the null row.
  const matchesBase = unitId === item.base_unit_id;

  const lists = db.raw
    .prepare<[], PriceListDbRow>(
      "select id, code, currency, customer_kind, branch_id, valid_from, valid_to from catalogue_price_list",
    )
    .all()
    .map(toList);
  const lines: PriceListLineCandidate[] = db.raw
    .prepare<[string, string, number], PriceListLineDbRow>(
      `select id, price_list_id, unit_id, min_quantity, unit_price from catalogue_price_list_line
        where item_id = ? and (unit_id = ? or (unit_id is null and ? = 1))`,
    )
    .all(req.itemId, unitId, matchesBase ? 1 : 0)
    .map((l) => ({
      id: l.id,
      priceListId: l.price_list_id,
      itemId: req.itemId,
      unitId: l.unit_id,
      minQuantity: l.min_quantity,
      unitPrice: l.unit_price,
    }));
  const magnitude = req.quantity.isNegative() ? req.quantity.negate() : req.quantity;
  const query = {
    itemId: req.itemId,
    currency: cur,
    quantity: magnitude.toString(),
    on: businessDay(at),
    unitId,
    customerKind: TILL_TRADE_LEVEL,
    branchId: tillBranchId(db),
  };

  let chosen: { listId: string; unitPrice: Money } | null = null;
  const customerList = customerPriceList(db, req.customerId ?? null, lists);
  if (customerList !== null) {
    if (customerList.currency !== cur)
      throw new TillError(
        "ERR_MONEY_CURRENCY_MISMATCH",
        "the customer's price list differs from the till currency",
      );
    // The customer's list is chosen by name, so its own trade level and branch are the ones it is read at.
    const hit = selectPrice([customerList], lines, {
      ...query,
      customerKind: customerList.customerKind,
      branchId: customerList.branchId,
    });
    if (hit !== null)
      chosen = { listId: hit.list.id, unitPrice: Money.of(hit.line.unitPrice, cur) };
  }
  if (chosen === null) {
    const hit = selectPrice(lists, lines, query);
    if (hit !== null)
      chosen = { listId: hit.list.id, unitPrice: Money.of(hit.line.unitPrice, cur) };
  }

  if (chosen === null) {
    return {
      itemId: req.itemId,
      unitId,
      unitPrice: Money.zero(cur),
      priceListId: null,
      promotionId: null,
      promotionDiscount: Money.zero(cur),
      source: "no_price",
    };
  }

  const promotion = resolvePromotion(db, {
    itemId: req.itemId,
    unitPrice: chosen.unitPrice,
    quantity: req.quantity,
    at,
  });
  return {
    itemId: req.itemId,
    unitId,
    unitPrice: chosen.unitPrice,
    priceListId: chosen.listId,
    promotionId: promotion.promotionId,
    promotionDiscount: promotion.discount,
    source: "price_list",
  };
}

interface PromotionDbRow {
  id: string;
  kind: string;
  definition: string;
  starts_at: string | null;
  ends_at: string | null;
  branch_id: string | null;
}

/**
 * The largest discount among the promotions that match, and `null` when none does.
 *
 * **Largest, not first, and not stacked.** Stacking is a business decision nobody has made (it is not in
 * §3.7.6's Pricing row, and §2.12 has no item for it), and "first" would make the answer depend on the order
 * rows happened to arrive in a catalogue page — a till and a second till would then price the same basket
 * differently with no rule anyone could state. Largest is defensible at the counter, is stable under any
 * arrival order, and is the customer's benefit.
 *
 * The window is checked **here, at the till, against the till's clock**, because 6A's `readCatalogue` carries
 * no `ends_at > now()` filter on purpose: an edit that shortens a window bumps the revision and travels as an
 * upsert, and filtering server-side would turn that edit into a silent absence and leave the till on the OLD
 * window for ever (6A's own comment; acceptance test 20). It compares **instants** through the domain's
 * `promotionActiveAt`, never the mirrored text: that text is PostgreSQL's `to_jsonb(timestamptz)` in whatever
 * offset the server session used, and the till's clock is `toISOString()` (PR 12 review).
 *
 * The SELECT still prefilters, coarsely, so a sale does not read every promotion the shop has ever run: 3A has
 * no `archived_at` on `app.promotion`, a retired promotion is one whose `ends_at` has passed, and those rows stay
 * in the mirror for good. The prefilter is `retiredBefore`'s and can only drop a row `promotionActiveAt` would
 * also refuse; the instant comparison above still decides every row it keeps. Another branch's promotion is
 * dropped there too (Form B at the till: a NULL branch is every branch; any other is somebody else's).
 *
 * Each candidate's discount is the domain's `promotionDiscount` — the per-kind shapes this task defines as the
 * reader of 3A's `definition jsonb` (`percent_off`, `amount_off`, `bundle`) — which is also what the server
 * recomputes when it verifies the promotion evidence the ticket carries (ADR 0059's PR 12 review amendment).
 * `unitPrice` is the line's actual price, an override included, because that is the price on the wire.
 */
export function resolvePromotion(
  db: PosDatabase,
  o: { itemId: string; unitPrice: Money; quantity: Quantity; at: Date },
): { promotionId: string | null; discount: Money } {
  const none = { promotionId: null, discount: Money.zero(o.unitPrice.currency) };
  const cutoff = retiredBefore(o.at);
  if (cutoff === null) return none; // an instant nobody can read lies in no window (`promotionActiveAt`)
  const rows = db.raw
    .prepare<[string | null, string], PromotionDbRow>(
      `select id, kind, definition, starts_at, ends_at, branch_id from catalogue_promotion
        where (branch_id is null or branch_id = ?) and (ends_at is null or ends_at >= ?)
        order by code`,
    )
    .all(tillBranchId(db), cutoff);

  let best: { promotionId: string; discount: Money } | null = null;
  for (const row of rows) {
    if (!promotionActiveAt({ startsAt: row.starts_at, endsAt: row.ends_at }, o.at)) continue;
    const discount = promotionDiscount(
      { kind: row.kind, definition: JSON.parse(row.definition) as unknown },
      { itemId: o.itemId, unitPrice: o.unitPrice, quantity: o.quantity },
    );
    if (discount.isZero()) continue;
    if (best === null || discount.compare(best.discount) > 0)
      best = { promotionId: row.id, discount };
  }
  return best ?? none;
}

const DAY_MS = 86_400_000;

/**
 * The `YYYY-MM-DD` that `resolvePromotion`'s prefilter keeps `ends_at` at or after, as text, or `null` when the
 * till's instant does not parse. Sound for every rendering PostgreSQL's `to_jsonb(timestamptz)` gives:
 *  - a year 1–9999 renders as `YYYY-MM-DDTHH:MI:SS[.ffffff]±HH:MM`, the date in the server session's offset, and
 *    every offset is under a day. So a row whose leading date is two days or more before the till's UTC date
 *    ended before the till's instant; the cutoff, the till's UTC date less two days, keeps a day more than that;
 *  - everything else — a five-digit year, a ` BC` date, `infinity`, `-infinity` — is text `Date.parse` cannot
 *    read, which `promotionActiveAt` refuses whether or not the prefilter drops it.
 * When the cutoff itself is not a four-digit-year date, the empty string keeps every row.
 */
function retiredBefore(at: Date): string | null {
  if (!Number.isFinite(at.getTime())) return null;
  const cutoff = new Date(at.getTime() - 2 * DAY_MS);
  if (!Number.isFinite(cutoff.getTime())) return "";
  const iso = cutoff.toISOString();
  return /^\d{4}-/.test(iso) ? iso.slice(0, 10) : "";
}

/** Shared TaxEngine arithmetic; the item selection and effective window are catalogue facts. */
export function taxItemLine(
  db: PosDatabase,
  opts: { gross: Money; itemId: string; at?: Date; taxCodeId?: string | null },
): TaxedLine {
  const day = businessDay(opts.at ?? new Date());
  const cur = opts.gross.currency;
  const item = db.raw
    .prepare<[string], { row_json: string }>("select row_json from catalogue_item where id = ?")
    .get(opts.itemId);
  if (!item) throw new TillError("ERR_NOT_FOUND", "item is absent from the till catalogue");
  const data = JSON.parse(item.row_json) as { tax_code_id?: string | null };
  const taxCodeId = Object.hasOwn(opts, "taxCodeId")
    ? opts.taxCodeId
    : Object.hasOwn(data, "tax_code_id")
      ? data.tax_code_id
      : defaultOutputTaxCode(db, day);
  if (taxCodeId === null || taxCodeId === undefined)
    return { taxCodeId: null, base: opts.gross, tax: Money.zero(cur), total: opts.gross };
  const row = db.raw
    .prepare<[string, string, string], { row_json: string }>(
      `select row_json from catalogue_tax_code where id = ? and archived_at is null
      and (effective_from is null or effective_from <= ?) and (effective_to is null or effective_to >= ?)`,
    )
    .get(taxCodeId, day, day);
  if (!row)
    throw new TillError(
      "ERR_TILL_CATALOGUE_STALE",
      "the selected tax code is missing, archived or not effective",
    );
  const dataCode = JSON.parse(row.row_json) as Record<string, unknown>;
  if (dataCode["kind"] === "input")
    throw new TillError("ERR_VALIDATION_FAILED", "an input tax code cannot price a sale");
  const code: TaxCodeDef = {
    id: taxCodeId,
    regimeId: String(dataCode["regime_id"] ?? ""),
    code: String(dataCode["code"]),
    rate: String(dataCode["rate"]),
    kind: dataCode["kind"] as TaxCodeDef["kind"],
    roundingMode: dataCode["rounding_mode"] as RoundingMode,
    outputAccountId: dataCode["output_account_id"] as string | null,
    inputAccountId: dataCode["input_account_id"] as string | null,
    effectiveFrom: dataCode["effective_from"] as string,
    effectiveTo: dataCode["effective_to"] as string | null,
  };
  const result = computeTaxLine({ lineNo: 1, amount: opts.gross, taxCode: code, inclusive: true });
  return { taxCodeId, base: result.base, tax: result.tax, total: opts.gross };
}

/** Compatibility only: an absent item field may select the sole active output code. Explicit null never does. */
function defaultOutputTaxCode(db: PosDatabase, day: string): string | null {
  const rows = db.raw
    .prepare<[string, string], { id: string }>(
      `select id from catalogue_tax_code
      where kind = 'output'
        and archived_at is null
        and (effective_from is null or effective_from <= ?)
        and (effective_to is null or effective_to >= ?)
      order by code`,
    )
    .all(day, day);
  return rows.length === 1 ? rows[0]!.id : null;
}

/**
 * spec:1355, §3.7.6's *Price check* row: *"a read-only lookup mode (the old system shipped this as a separate
 * `PriceChecker.exe`; here it is a mode of the same app)"*.
 *
 * Two properties make it a mode and not a screen. It is gated on **`PERMISSION["pos.price.check"]`** — the
 * literal is written this way and not as a bare string so §3.6.3's `permission-catalogue` lint sees a
 * reference from `apps/pos`, which is the *only* place this code is referenced in the product. And it opens no
 * transaction and calls no writer: `pricing.test.ts` counts `ticket + outbox + till_event` before and after
 * and asserts the number did not move, because "read-only" is a claim a test has to make.
 *
 * The quote is at **quantity one**. A price check answers *"what does one of these cost?"*; quoting a
 * quantity break would answer a question the customer did not ask and would show a price they cannot have.
 */
export function priceCheck(
  db: PosDatabase,
  cashier: TillCashier,
  query: { barcode?: string; code?: string; text?: string },
): PriceCheckResult[] {
  requireCode(cashier, PERMISSION["pos.price.check"]);
  assertCatalogueFresh(db);
  const items: TillItem[] = [];
  if (query.barcode !== undefined) {
    const hit = findItemByBarcode(db, query.barcode);
    if (hit !== null) items.push(hit);
  }
  if (query.code !== undefined) {
    const hit = findItemByCode(db, query.code);
    if (hit !== null) items.push(hit);
  }
  if (query.text !== undefined) items.push(...searchItems(db, query.text));

  const one = Quantity.of("1.000000");
  const seen = new Set<string>();
  const out: PriceCheckResult[] = [];
  for (const item of items) {
    if (seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    const quote = resolvePrice(db, { itemId: item.itemId, quantity: one });
    const gross = quote.unitPrice.subtract(quote.promotionDiscount);
    out.push({ item, quote, taxed: taxItemLine(db, { gross, itemId: item.itemId }) });
  }
  return out;
}
