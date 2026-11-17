import type { Sql } from "postgres";
import { Money, Quantity, currency, rational } from "@dulja/domain";
import { micro } from "../ar-ap/invoice";
import type { TenantContext } from "../with-tenant";
import {
  linkFulfilment,
  openQuantity,
  type DocumentLinkRow,
  type OpenQuantityRow,
} from "../documents/link";
// 3A ships `pickLotsFefo` and `FefoPick` from `lots.ts`, NOT from a `fefo.ts` — there is no such file
// (3a:114, 3a:6534, 3a:6795). Task 0's gate greps this exact export path.
import { pickLotsFefo } from "./lots";

export interface ConvertToDeliveryInput {
  /** The SALES_ORDER being converted. Must be `issued` (3C's rule for a link source). */
  sourceDocumentId: string;
  /** The DELIVERY_ORDER type to draft. Resolved by the caller so this function never reads a code register. */
  targetDocumentTypeId: string;
  targetSeries: string;
  effectiveDate: string;
  /** The warehouse every drafted line ships from. NOT optional and never defaulted from the header:
   *  `applyMovements` needs a warehouse per line, and a null one is an `ERR_POLICY_REQUIRES_MISSING` at post. */
  warehouseId: string;
  /** Which order lines to fulfil, and how much of each. A line omitted here stays fully open (a back-order,
   *  spec:1050). `quantity` is a 6-dp magnitude string; a quantity above the line's open quantity is refused
   *  by 3C's guard with `ERR_DOC_LINK_OVER_FULFILLED`. */
  lines: readonly { sourceLineId: string; quantity: string }[];
  /** Resolve each drafted line's lot through `app.pick_lots_fefo`, splitting one order line into one drafted
   *  line per lot. Default true — the Phase 3 definition-of-done clause "FEFO picking returns the
   *  earliest-expiring lot" is proven through this path (spec:1051). False leaves `lot_id` null and lets
   *  `applyMovements` resolve the item's `NONE` sentinel, which is what a non-lot-tracked item wants.
   *
   *  **FEFO never reduces the requested quantity.** `app.pick_lots_fefo` caps each pick at the lot's
   *  available quantity and stops when the warehouse is exhausted — 3A's own test is titled "returns fewer
   *  rows than asked rather than raising — the refusal is the trigger's job" — so the picked total may be
   *  less than `quantity`. The shortfall becomes **one final pair with a null lot**, so the drafted lines
   *  always sum to exactly what was asked and `app.assert_stock_available` sees the true over-issue. Capping
   *  the draft to on-hand instead would make test 18's re-run and test 7's "gone negative" leg vacuous. */
  fefo?: boolean;
}

export interface ConvertResultLine {
  targetLineId: string;
  sourceLineId: string;
  lineNo: number;
  itemId: string;
  warehouseId: string;
  lotId: string | null;
  quantity: string;
}

export interface ConvertResult {
  /** The drafted DELIVERY_ORDER. */
  documentId: string;
  lines: ConvertResultLine[];
  /** 3C's rows, `linkKind: "converts_to"`. */
  links: DocumentLinkRow[];
  /** The source order's open quantity AFTER the links were written — read back from 3C's view, never
   *  computed here (LEGACY-017/LEGACY-018: the remaining quantity is a projection, never a stored column). */
  remaining: OpenQuantityRow[];
}

interface SourceLine {
  id: string;
  line_no: number;
  item_id: string | null;
  unit_id: string | null;
  quantity: string | null;
  unit_price: string | null;
  discount: string;
  description: string | null;
  dimensions: Record<string, string>;
  tax_code_id: string | null;
}

/** Whether `carried` lies between zero and `full` inclusive, in `full`'s sign — what the deliveries of an order
 *  line whose discount is `full` can carry between them without one of them carrying a surcharge or more than
 *  the order gave. A zero `full` admits only zero. */
function withinDiscount(carried: Money, full: Money): boolean {
  return full.isNegative()
    ? !carried.isPositive() && carried.compare(full) >= 0
    : !carried.isNegative() && carried.compare(full) <= 0;
}

/**
 * SALES_ORDER → DELIVERY_ORDER. Runs inside the caller's transaction so the draft, its lines and 3C's links
 * are one atomic unit: a half-linked delivery would show a wrong open quantity for as long as it existed.
 *
 * FEFO splitting is why one source line can become several target lines. `app.pick_lots_fefo` returns
 * (lot_id, quantity) rows oldest-expiry-first over the SYNCHRONOUS stock_on_hand projection (3A, ADR 0036);
 * picking here, at drafting time, is correct precisely because nothing is posted yet — inside a posting
 * transaction the projection has not been MERGEd and `assert_stock_available` is the control instead.
 *
 * The function writes `document` and `document_line` only. It sets no `cost` (that is `applyMovements`,
 * §4.7.2), issues nothing and posts nothing: the caller transitions the draft when the picker is done.
 *
 * 5A (ADR 0050's 2026-10-06 amendment, proposed): the delivery carries the order's `tax_inclusive` and each
 * order line's `tax_code_id`, alongside the price it already copies. DELIVERY_ORDER applies no tax, so neither
 * computes anything here; they travel for 4A's `convertToInvoice`, which inherits a source line's code by
 * default and refuses a coded conversion of a tax-inclusive source. Without them a delivery's copied price
 * would always read as net and uncoded — an inclusive order's GROSS price taxed again on the invoice, and an
 * order's code lost on the way.
 *
 * **The order line's discount is shared, not copied** (PR 11 review, round 3 and its adversarial passes;
 * proposed as ADR 0050 decisions 10–12, beside the 2026-10-06/07 amendment). It is a line total, and every
 * drafted line — each FEFO split, the shortfall pair, each partial delivery — carries the share of it pro rata
 * to its quantity, the line that completes the order line taking the residue over what earlier deliveries of
 * that line (those whose claim the open-quantity view counts) already carry. The deliveries of a line
 * therefore carry its discount exactly once between them, and so does 4A's invoice. Two bounds keep every
 * share this function writes between zero and the order line's discount, in its sign (the adversarial pass):
 *  - **a history it cannot carry on from is refused.** Earlier deliveries are counted whoever drafted them, and
 *    a client-drafted one (3C's `fulfils`, or a `converts_to` through `POST …/links`) carries the discount its
 *    client keyed. When what they carry between them already lies outside zero to the order line's discount —
 *    more than the order gave, or the opposite sign — the residue would be a surcharge (or more than the order
 *    gave) on a delivery this service drafted, which 4A's conversion invoices and taxes. So the conversion is
 *    refused with `ERR_VALIDATION_FAILED` naming those deliveries, on every asked line of that order line,
 *    completing or not, before anything is written — ADR 0050 decision 9's answer to an untrusted history.
 *    An undiscounted order line therefore admits no delivery discount at all: an allowance keyed on a client
 *    delivery of it holds this service's deliveries of the rest until that delivery is corrected, voided or
 *    reversed. Whether to clamp what this service writes instead is the owner's (proposed as ADR 0050 open
 *    question 7);
 *  - **a share never takes more than is left.** A pro-rata share rounded HALF_AWAY_FROM_ZERO can round up,
 *    and enough of them in a row carried more than the order line's discount (5 units less 0.0003 delivered
 *    one by one: four shares of 0.0001), leaving the completing delivery an opposite-sign residue on a
 *    history this service wrote alone. A non-completing share is therefore capped at what the order line has
 *    left to carry, so the residue is always between zero and the discount. Where nothing rounds over, the
 *    cap changes nothing.
 *
 * Raises `ERR_VALIDATION_FAILED` when the source is neither issued nor posted or an asked order line's
 * deliveries already carry a discount outside zero to its own, `ERR_NOT_FOUND` when a named
 * source line is not on the source document, and lets 3C's over-fulfilment guard raise
 * `ERR_DOC_LINK_OVER_FULFILLED` untouched. `packages/db` may not import `AppError` (§3.1), so each is a
 * plain `Error` whose message carries the token — the shape `documents/link.ts` already uses and the route
 * layer's `asAppError` translates.
 */
export async function convertOrderToDelivery(
  tx: Sql,
  ctx: TenantContext,
  input: ConvertToDeliveryInput,
): Promise<ConvertResult> {
  const [source] = await tx<
    {
      id: string;
      company_id: string;
      status: string;
      party_id: string | null;
      branch_id: string;
      currency: string;
      exchange_rate: string;
      tax_inclusive: boolean;
    }[]
  >`
    select id, company_id, status, party_id, branch_id, currency, exchange_rate::text as exchange_rate,
           tax_inclusive
      from app.document where id = ${input.sourceDocumentId}`;
  if (source === undefined) {
    throw new Error(`ERR_NOT_FOUND: document ${input.sourceDocumentId} is not visible`);
  }
  if (source.status !== "issued" && source.status !== "posted") {
    throw new Error(
      `ERR_VALIDATION_FAILED: source document ${input.sourceDocumentId} is ${source.status}, ` +
        `not issued or posted`,
    );
  }

  const ids = input.lines.map((l) => l.sourceLineId);
  const sourceLines = await tx<SourceLine[]>`
    select id, line_no, item_id, unit_id, quantity::text as quantity, unit_price::text as unit_price,
           discount::text as discount, description, dimensions, tax_code_id
      from app.document_line
     where document_id = ${input.sourceDocumentId} and id = any(${ids}::uuid[])`;
  const byId = new Map(sourceLines.map((l) => [l.id, l]));
  for (const id of ids) {
    if (!byId.has(id)) {
      throw new Error(
        `ERR_NOT_FOUND: document line ${id} is not a line of document ${input.sourceDocumentId}`,
      );
    }
  }

  // Lock order (code review 4, item 3): the source lines' `document_link:<line>` keys — the key 0037's link
  // guard takes — BEFORE the first audited write below, whose audit row takes the tenant's `tenant-serial:`
  // key (0010). Taken only by the guard, at linkFulfilment's INSERT, they were requested while this draft's
  // audit rows already held the tenant's key, the opposite order to a reversal that reinstates a claim on the
  // same line (reverseDocument takes the line's key first), and the two deadlocked. Sorted, as linkFulfilment,
  // convertToInvoice and creditNoteFrom sort them; the guard's later lock on the same key is re-entrant.
  for (const id of [...new Set(ids)].toSorted()) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`document_link:${id}`}, 0))`;
  }

  // PR 11 review, round 3: what earlier deliveries of each asked order line already carry — read AFTER the
  // locks above (LEGACY-017's order, as `convertToInvoice` and `creditNoteFrom` read their residues), so two
  // conversions of one line cannot both read "nothing delivered yet" and both take the pro-rata share. A
  // delivery counts exactly when `app.document_open_quantity` counts its claim (0116): not void, and reversed
  // only while its reversal chain reinstates it (`app.document_claim_stands`). Both order → delivery kinds
  // count — this function's `converts_to` and a client-drafted delivery's `fulfils` — so the line that
  // completes an order line is the one the open quantity says completes it, and the deliveries of a line carry
  // its discount exactly once between them. The counted deliveries are named beside the sums, for the refusal
  // below (the adversarial pass).
  const carriedRows = await tx<
    { id: string; quantity: string; discount: string; deliveries: string[] | null }[]
  >`
    select dl.id, coalesce(done.quantity, 0)::numeric(19,6)::text as quantity,
           coalesce(done.discount, 0)::numeric(19,4)::text as discount,
           done.deliveries
      from app.document_line dl
      left join lateral (
             select sum(k.quantity) as quantity, sum(tl.discount) as discount,
                    array_agg(distinct t.id::text order by t.id::text) as deliveries
               from app.document_link k
               join app.document_line tl on tl.id = k.target_line_id
               join app.document t on t.id = k.target_document_id
              where k.source_line_id = dl.id and k.link_kind in ('converts_to', 'fulfils')
                and (t.status not in ('void', 'reversed')
                     or (t.status = 'reversed' and app.document_claim_stands(t.id)))
           ) done on true
     where dl.document_id = ${input.sourceDocumentId} and dl.id = any(${ids}::uuid[])`;
  const ccy = currency(source.currency);
  // Per order line: the quantity (in micro-units) and discount delivered so far, advanced by every line this
  // call drafts, so a FEFO split's later pairs see its earlier ones.
  const carried = new Map(
    carriedRows.map((r) => [
      r.id,
      { quantity: micro(r.quantity), discount: Money.of(r.discount, ccy) },
    ]),
  );
  // PR 11 review, round 3, adversarial pass: the residue below is `discount − what the history carries`, and
  // the history may hold a client's figures. One that already carries more than the order line's discount, or
  // the opposite sign, would make that residue a surcharge (or more than the order gave) on a delivery THIS
  // service drafts, which 4A's conversion invoices and taxes as it stands. Refused here — before anything is
  // written, on every asked line of the order line, completing or not, because the history is wrong whichever
  // delivery meets it (ADR 0050 decision 9's rule for an untrusted credit history). A history inside the bound
  // is carried on from.
  for (const r of carriedRows) {
    const src = byId.get(r.id)!;
    const full = Money.of(src.discount, ccy);
    const history = Money.of(r.discount, ccy);
    if (!withinDiscount(history, full)) {
      const deliveries = r.deliveries ?? [];
      const one = deliveries.length === 1;
      throw new Error(
        `ERR_VALIDATION_FAILED: order line ${src.line_no} cannot be delivered: ` +
          `${one ? "delivery" : "deliveries"} ${deliveries.join(", ")} already ${one ? "carries" : "carry"} ` +
          `a discount of ${history.toString()} of the order line's ${full.toString()}, so what is left to ` +
          `carry (${full.subtract(history).toString()}) is outside zero to that discount and a delivery drafted ` +
          `here would carry it as a surcharge or as more than the order gave; remove or correct ` +
          `${one ? "that draft" : "those drafts"}, void ${one ? "it" : "them"} if issued, or reverse ` +
          `${one ? "it" : "them"} if posted, before delivering this line`,
      );
    }
  }

  // `tax_inclusive` is the order's: the lines below copy its price, and whether that price is gross is part
  // of it (5A — `convertToInvoice` refuses a coded conversion of an inclusive source).
  const [target] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       party_id, warehouse_id, branch_id, tax_inclusive)
    values (${ctx.tenantId}, ${source.company_id}, ${input.targetDocumentTypeId}, ${input.targetSeries},
            ${input.effectiveDate}, ${source.currency}, ${source.exchange_rate},
            ${source.party_id}, ${input.warehouseId}, ${source.branch_id}, ${source.tax_inclusive})
    returning id`;
  const documentId = target!.id;

  const drafted: ConvertResultLine[] = [];
  const linkLines: { sourceLineId: string; targetLineId: string; quantity: string }[] = [];
  let lineNo = 0;

  for (const wanted of input.lines) {
    const src = byId.get(wanted.sourceLineId)!;
    // One (lotId, quantity) pair per drafted line. FEFO off, or an item with no lot-tracked stock, gives
    // exactly one pair with a null lot — applyMovements resolves the item's 'NONE' sentinel (LEGACY-050).
    let pairs: { lotId: string | null; quantity: string }[] = [
      { lotId: null, quantity: wanted.quantity },
    ];
    if ((input.fefo ?? true) && src.item_id !== null) {
      const asked = Quantity.of(wanted.quantity);
      const picked = await pickLotsFefo(tx, {
        itemId: src.item_id,
        warehouseId: input.warehouseId,
        quantity: asked,
      });
      if (picked.length > 0) {
        pairs = picked.map((p) => ({ lotId: p.lotId, quantity: p.quantity.toString() }));
        // FEFO returns FEWER rows than asked when the warehouse cannot cover the quantity (3A: "the refusal
        // is the trigger's job"). The requested quantity is NEVER reduced here: the uncovered remainder
        // becomes one final pair with a null lot, which `applyMovements` resolves to the item's `NONE`
        // sentinel (LEGACY-050) so `app.assert_stock_available` sees the true over-issue and either raises
        // ERR_STOCK_INSUFFICIENT or admits it against an `inventory.negative_stock.override` event
        // (§4.5.3). Capping the draft to on-hand would make test 18's re-run and test 7's "gone negative"
        // leg vacuous, and would link only the capped quantity to the order line.
        const covered = picked.reduce((sum, p) => sum.add(p.quantity), Quantity.zero());
        const shortfall = asked.subtract(covered);
        if (shortfall.compare(Quantity.zero()) > 0) {
          pairs.push({ lotId: null, quantity: shortfall.toString() });
        }
      }
    }
    const signed = src.quantity === null ? 0n : micro(src.quantity);
    const whole = signed < 0n ? -signed : signed;
    const full = Money.of(src.discount, ccy);
    for (const pair of pairs) {
      lineNo += 1;
      // PR 11 review, round 3: the order line's `discount` is a LINE total, so each drafted line carries its
      // share, never the whole — 4A's `convertToInvoice` values a delivery line as unit_price × entered
      // quantity − discount (the order's unit rides with its price; MON-02), and the whole copied onto a
      // 6 + 4 split invoiced it twice (and, since 5A, taxed the under-billed net). The share is pro rata to the line's quantity by an exact `Rational`, rounded once
      // HALF_AWAY_FROM_ZERO by `Money.multiply`; the line that COMPLETES the order line (everything delivered,
      // plus this line, equals its quantity) takes the RESIDUE instead, so the deliveries sum to the order's
      // discount exactly — the rule `convertToInvoice` and `creditNoteFrom` apply to their own figures.
      // The adversarial pass: a pro-rata share is CAPPED at what is left, so shares rounded up in a row cannot
      // carry more than the discount and leave the completing line an opposite-sign residue. `left` stays
      // between zero and `full` in its sign — the refusal above admits only such a history, and every line
      // drafted here takes at most `left` — so the share, the cap and the residue all lie inside that bound.
      const done = carried.get(src.id) ?? { quantity: 0n, discount: Money.zero(ccy) };
      const q = micro(pair.quantity);
      const left = full.subtract(done.discount);
      const share = full.multiply(
        whole === 0n ? rational(0n, 1n) : rational(q, whole),
        "HALF_AWAY_FROM_ZERO",
      );
      const discount =
        done.quantity + q === whole ? left : share.abs().compare(left.abs()) > 0 ? left : share;
      carried.set(src.id, { quantity: done.quantity + q, discount: done.discount.add(discount) });
      // The order line's tax code travels with its price (5A): DELIVERY_ORDER computes no tax from it, and
      // 4A's conversion inherits it as the invoice line's default. Every FEFO split carries the same code.
      const [row] = await tx<{ id: string }[]>`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, description, item_id, warehouse_id, lot_id,
           unit_id, quantity, unit_price, discount, amount, tax_code_id, dimensions)
        values (${ctx.tenantId}, ${source.company_id}, ${documentId}, ${lineNo}, 'item', ${src.description},
                ${src.item_id}, ${input.warehouseId}, ${pair.lotId}, ${src.unit_id}, ${pair.quantity},
                ${src.unit_price}, ${discount.toString()}, 0, ${src.tax_code_id},
                ${JSON.stringify(src.dimensions)}::text::jsonb)
        returning id`;
      drafted.push({
        targetLineId: row!.id,
        sourceLineId: src.id,
        lineNo,
        itemId: src.item_id!,
        warehouseId: input.warehouseId,
        lotId: pair.lotId,
        quantity: pair.quantity,
      });
      linkLines.push({ sourceLineId: src.id, targetLineId: row!.id, quantity: pair.quantity });
    }
  }

  // 3C's writer, and 3C's over-fulfilment guard. `priceFromSource: false` — the price is already copied
  // above from the order line, and letting 3C copy it again would recompute `amount` on a line whose amount
  // is deliberately 0 (a delivery carries no revenue; 4A's SALES_INVOICE does).
  const links = await linkFulfilment(tx, ctx, {
    sourceDocumentId: input.sourceDocumentId,
    targetDocumentId: documentId,
    linkKind: "converts_to",
    lines: linkLines,
    priceFromSource: false,
  });

  return {
    documentId,
    lines: drafted,
    links,
    remaining: await openQuantity(tx, input.sourceDocumentId),
  };
}
