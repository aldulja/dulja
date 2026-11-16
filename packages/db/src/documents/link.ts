import { Money, Quantity, currency, rational, type Rational } from "@dulja/domain";
import type { Sql } from "postgres";
import { computeDocumentTax } from "../tax/compute";
import type { TenantContext } from "../with-tenant";

export type LinkKind = "fulfils" | "converts_to" | "receives_against" | "returns" | "settles";

export interface FulfilmentLineInput {
  sourceLineId: string;
  targetLineId: string;
  /** `null` records the relationship with no fulfilled quantity. `app.document_link` admits it (`quantity is
   *  null or quantity > 0`) and the 0037 trigger has no open quantity to bound, so a null link CONSUMES
   *  nothing. Never "0.000000", which that CHECK refuses. A total-loss transfer receipt does NOT link null:
   *  it consumes the dispatch line's open quantity like any receipt (full review 2026-11-15, INV-01;
   *  `draftTransferReceipt`). */
  quantity: string | null;
}

export interface LinkFulfilmentInput {
  sourceDocumentId: string;
  targetDocumentId: string;
  linkKind: LinkKind;
  lines: readonly FulfilmentLineInput[];
  /** Copy the source line's unit_price and recompute the target line's amount when the target carries no
   *  price. This is what "a GOODS_RECEIPT … prices its GRNI accrual from [the PO]" means (spec:1050).
   *  Default true. 5A: refused between documents of different `tax_inclusive`, and for `fulfils` and
   *  `receives_against` the source line's tax code rides the copy onto a target line naming none. */
  priceFromSource?: boolean;
}

export interface DocumentLinkRow {
  id: string;
  companyId: string;
  sourceDocumentId: string;
  sourceLineId: string | null;
  targetDocumentId: string;
  targetLineId: string | null;
  linkKind: LinkKind;
  quantity: string | null;
  amount: string | null;
  createdAt: string;
}

export interface OpenQuantityRow {
  documentId: string;
  documentLineId: string;
  lineNo: number;
  itemId: string | null;
  orderedQuantity: string;
  linkedQuantity: string;
  openQuantity: string;
}

interface LinkDbRow {
  id: string;
  company_id: string;
  source_document_id: string;
  source_line_id: string | null;
  target_document_id: string;
  target_line_id: string | null;
  link_kind: LinkKind;
  quantity: string | null;
  amount: string | null;
  /** `timestamptz` is left UNCAST in both selects below, so postgres.js hands back a `Date`. A `::text` cast
   *  would give `2026-01-15 10:00:00+00` — a space, not a `T` — which `TimestampSchema`
   *  (`z.string().datetime({ offset: true })`, §4.2.8) rejects. `toISOString()` is the RFC 3339 it wants. */
  created_at: Date;
}

const toRow = (r: LinkDbRow): DocumentLinkRow => ({
  id: r.id,
  companyId: r.company_id,
  sourceDocumentId: r.source_document_id,
  sourceLineId: r.source_line_id,
  targetDocumentId: r.target_document_id,
  targetLineId: r.target_line_id,
  linkKind: r.link_kind,
  quantity: r.quantity,
  amount: r.amount,
  createdAt: r.created_at.toISOString(),
});

/** How a document's `tax_inclusive` makes its prices read, for the price-copy refusal below. */
const inclusivity = (inclusive: boolean): string => (inclusive ? "tax-inclusive" : "tax-exclusive");

/**
 * A line's unit facts, as `enteredQuantity` reads them: its BASE `quantity`, the quantity as entered
 * (`unit_quantity`, null when none was entered) and the exact factor of its `unit_id` — base units per
 * entered unit, `numerator / denominator` of the item's `app.unit_conversion` row, `1/1` for the base unit or
 * a line with no unit, and null when the line names a unit the item has no conversion for.
 */
export interface LineUnitFacts {
  lineNo: number;
  quantity: string;
  unitQuantity: string | null;
  unitNumerator: string | null;
  unitDenominator: string | null;
}

function microOf(quantity: string): bigint {
  const fixed = Quantity.of(quantity).toString();
  const negative = fixed.startsWith("-");
  const digits = (negative ? fixed.slice(1) : fixed).replace(".", "");
  return negative ? -BigInt(digits) : BigInt(digits);
}

/**
 * The line's quantity IN ITS OWN ENTERED UNIT, as an exact `Rational` — what its `unit_price` is per
 * (ADR 0044's 2026-11-16 amendment, MON-02). `unit_price` is a price per ENTERED unit: a price list line
 * names its unit, the till extends `price × entered quantity` (`sync/apply.ts`), and an order's `amount` is
 * `unit_price × unit_quantity`. `quantity` is always BASE (0032's trigger derives it from the entered pair),
 * so a value read as `unit_price × quantity` overstates a carton of twelve twelve-fold. The entered
 * quantity is `unit_quantity` where one was entered, else the base quantity divided back through the unit's
 * exact factor (a delivery 3D drafts from an order carries the order's unit and a base quantity only). A
 * base-unit line, or one with no unit, is its `quantity` unchanged. A unit with no conversion is refused:
 * extending its price by the base quantity is exactly the defect.
 */
export function enteredQuantity(line: LineUnitFacts): Rational {
  if (line.unitQuantity !== null) return rational(microOf(line.unitQuantity), 1_000_000n);
  if (line.unitNumerator === null || line.unitDenominator === null) {
    throw new Error(
      `ERR_VALIDATION_FAILED: line ${line.lineNo} names a unit its item has no conversion for, so its ` +
        "price per that unit cannot be extended over its base quantity",
    );
  }
  return rational(
    microOf(line.quantity) * BigInt(line.unitDenominator),
    1_000_000n * BigInt(line.unitNumerator),
  );
}

/**
 * Records one fulfilment link per input line and, when `priceFromSource` is not false and the target line
 * carries no `unit_price`, copies the source line's price onto it and recomputes `amount` as
 * `unit_price × entered quantity − discount`, rounded once at 4 dp HALF_AWAY_FROM_ZERO through `Money` and
 * an exact `Rational` — never a `number` (spec:2041). The entered quantity is the target's quantity in the
 * source line's unit (`enteredQuantity`; MON-02), and a target in another unit gets the price re-expressed
 * per its own unit. The draft's tax is then recomputed (`computeDocumentTax`; MON-14).
 *
 * **The copy carries the order's tax facts (5A; PR 11 review, round 2).** It is the client's way to price a
 * GOODS_RECEIPT from its PURCHASE_ORDER — the purchase side has no drafting service — or a client-drafted
 * DELIVERY_ORDER from its SALES_ORDER, so it must agree with 3D's `convertOrderToDelivery`, which carries the
 * order's `tax_inclusive` and line codes onto the delivery it drafts. Two rules, both only where a price is
 * actually copied:
 *  - a copy between documents whose `tax_inclusive` differs is refused with `ERR_VALIDATION_FAILED`, before
 *    anything is written: the price is gross on an inclusive order, and under the target's other header it
 *    would be read as net (or the reverse) — `convertToInvoice` then taxed an inclusive PO's gross as net,
 *    since the receipt it converted read exclusive. The target is drafted with its order's `taxInclusive`.
 *    Every service caller passes `priceFromSource: false`, and before Phase 5 every header was false, so
 *    nothing existing changes;
 *  - for `fulfils` and `receives_against` — the order → stock-document kinds 3D's carry mirrors — the source
 *    line's `tax_code_id` is copied onto a target line that names none, so 4A's conversion inherits it. A
 *    target line's own code is kept. `converts_to` belongs to the conversion services, which carry codes
 *    themselves, and a `returns` target (a credit or a return) has its own.
 *
 * Every rule about *whether* the link is legal lives in `app.assert_document_link_within_open_quantity()`
 * (migration 0037): the target must be a draft (`ERR_DOC_NOT_DRAFT`), the source must be issued or posted
 * (`ERR_DOC_STATUS_ILLEGAL`), and the sum of links must not exceed the ordered quantity
 * (`ERR_DOC_LINK_OVER_FULFILLED`). This function raises none of them itself — the caller's
 * `fromDatabaseError` translates the token (§4.2.4), which is what makes the guard hold for a direct
 * `app_rw` statement too (spec:2173). The `tax_inclusive` refusal above is raised here and not by the trigger
 * because it is about the price this function copies, not about the link: a direct `app_rw` link copies none.
 */
export async function linkFulfilment(
  tx: Sql,
  ctx: TenantContext,
  input: LinkFulfilmentInput,
): Promise<DocumentLinkRow[]> {
  const [target] = await tx<{ company_id: string; tax_inclusive: boolean; currency: string }[]>`
    select company_id, tax_inclusive, currency::text as currency
      from app.document where id = ${input.targetDocumentId}`;
  if (target === undefined) {
    // The caller maps this to ERR_NOT_FOUND; packages/db may not import AppError (§3.1).
    throw new Error(`ERR_NOT_FOUND: document ${input.targetDocumentId} is not visible`);
  }

  const pricing = input.priceFromSource !== false;
  if (pricing) {
    // 5A. A copied `unit_price` means what its document's `tax_inclusive` says — GROSS on an inclusive order —
    // and the target reads it under its OWN header. Between two documents that disagree, the copy turns a
    // gross price into a net one (or the reverse): a receipt priced from an inclusive PO read exclusive, and
    // `convertToInvoice` then taxed the gross as net, its inclusive-source refusal never seeing the order. So a
    // copy across the two is refused, before anything is written — but only where a price is actually copied
    // (the UPDATE's own predicate below): a target line already priced, or a source line with none, copies
    // nothing and is linked as before. An invisible source is the 0037 trigger's refusal, not this one.
    const [source] = await tx<{ tax_inclusive: boolean }[]>`
      select tax_inclusive from app.document where id = ${input.sourceDocumentId}`;
    if (source !== undefined && source.tax_inclusive !== target.tax_inclusive) {
      const [copies] = await tx<{ target_line_id: string }[]>`
        select t.id as target_line_id
          from unnest(${input.lines.map((l) => l.targetLineId)}::uuid[],
                      ${input.lines.map((l) => l.sourceLineId)}::uuid[]) as p(target_line_id, source_line_id)
          join app.document_line t
            on t.id = p.target_line_id and t.document_id = ${input.targetDocumentId}
          join app.document_line s
            on s.id = p.source_line_id and s.document_id = ${input.sourceDocumentId}
         where t.unit_price is null and s.unit_price is not null and t.quantity is not null
         limit 1`;
      if (copies !== undefined) {
        throw new Error(
          `ERR_VALIDATION_FAILED: source document ${input.sourceDocumentId} is ${inclusivity(source.tax_inclusive)} ` +
            `and target document ${input.targetDocumentId} is ${inclusivity(target.tax_inclusive)}: the price ` +
            `copied onto target line ${copies.target_line_id} would be read as ` +
            `${target.tax_inclusive ? "gross" : "net"} when it is ${source.tax_inclusive ? "gross" : "net"} ` +
            "— draft the target with the same taxInclusive as its order",
        );
      }
    }
  }
  // 5A. The order line's tax code rides the price onto a stock document's line that names none, as 3D's
  // `convertOrderToDelivery` carries it, so 4A's `convertToInvoice` inherits it by default. Only for the two
  // order → stock-document kinds: `converts_to` is the conversions' kind and they carry the codes themselves
  // (with `priceFromSource: false`), and a `returns` target is a credit or a return, whose code is its own.
  const carriesCode = input.linkKind === "fulfils" || input.linkKind === "receives_against";

  const created: DocumentLinkRow[] = [];
  let priced = false;
  // SORTED BY SOURCE LINE, and it is a correctness requirement rather than tidiness. The 0037 trigger takes
  // `pg_advisory_xact_lock` on each source line before it sums, so two transactions linking the same pair of
  // order lines in opposite orders would deadlock (one 40P01, retried by `withTenant` — §4.2.2 — but a sorted
  // loop never gets there). Sorting the acquisition order is 3A's rule for `lockStockKeys` (3a:5719-5727),
  // applied to the same problem. `toSorted` leaves the caller's `readonly` array untouched.
  const lines = input.lines.toSorted((x, y) =>
    x.sourceLineId < y.sourceLineId ? -1 : x.sourceLineId > y.sourceLineId ? 1 : 0,
  );
  for (const l of lines) {
    const [row] = await tx<LinkDbRow[]>`
      insert into app.document_link
        (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${ctx.tenantId}, ${target.company_id}, ${input.sourceDocumentId}, ${l.sourceLineId},
              ${input.targetDocumentId}, ${l.targetLineId}, ${input.linkKind}, ${l.quantity})
      returning id, company_id, source_document_id, source_line_id, target_document_id, target_line_id,
                link_kind, quantity::text as quantity, amount::text as amount, created_at`;
    created.push(toRow(row!));

    if (pricing) {
      // Each line is bound to ITS OWN document, and that is a correctness requirement rather than
      // belt-and-braces. Keyed on `t.id`/`s.id` alone this UPDATE reached any line in the tenant: the
      // route binds the two DOCUMENTS to the path company, but the two LINE ids arrive as bare uuids,
      // app.document_link's FKs are composite on (tenant_id, x) only, and RLS is tenant-scoped. The
      // target could then be a line of another document of another company. Migration 0109 puts the same
      // rule in the 0037 trigger (spec:2173); this statement never reaches that trigger, so it carries the
      // predicates itself. Since migration 0113 app.document_line is also frozen once its document leaves
      // draft (`document_line_frozen_after_draft`), so a non-draft target is refused by the data layer as
      // well — the binding above is what keeps a DRAFT of another company out of reach.
      // MON-02: `unit_price` is per ENTERED unit (`enteredQuantity`), so the copy extends it over the target's
      // quantity expressed in the SOURCE line's unit — the target's own `unit_quantity` when the two lines
      // share a unit, else its base quantity divided through the source unit's exact factor — and, when the
      // target names a different unit, re-expresses the price per the target's unit (rounded once, at 4 dp).
      // The amount is extended from the source's own price, never from that rounded figure. Read and written
      // in two statements, both under the same binding predicates the old single UPDATE carried.
      const pair = await tx<
        {
          side: "s" | "t";
          lineNo: number;
          unitId: string | null;
          quantity: string | null;
          unitQuantity: string | null;
          unitPrice: string | null;
          discount: string;
          unitNumerator: string | null;
          unitDenominator: string | null;
        }[]
      >`
        select case when l.id = ${l.sourceLineId}::uuid then 's' else 't' end as side,
               l.line_no as "lineNo", l.unit_id as "unitId", l.quantity::text as quantity,
               l.unit_quantity::text as "unitQuantity", l.unit_price::text as "unitPrice",
               l.discount::text as discount,
               (case when l.item_id is null or l.unit_id is null or l.unit_id = i.base_unit_id then 1
                     else uc.numerator end)::text as "unitNumerator",
               (case when l.item_id is null or l.unit_id is null or l.unit_id = i.base_unit_id then 1
                     else uc.denominator end)::text as "unitDenominator"
          from app.document_line l
          left join app.item i on i.id = l.item_id
          left join app.unit_conversion uc on uc.item_id = l.item_id and uc.unit_id = l.unit_id
         where (l.id = ${l.sourceLineId} and l.document_id = ${input.sourceDocumentId})
            or (l.id = ${l.targetLineId} and l.document_id = ${input.targetDocumentId})`;
      const s = pair.find((r) => r.side === "s");
      const t = pair.find((r) => r.side === "t");
      if (
        s === undefined ||
        t === undefined ||
        s.unitPrice === null ||
        t.unitPrice !== null ||
        t.quantity === null ||
        s.quantity === null
      ) {
        continue;
      }
      const tFacts: LineUnitFacts = { ...t, quantity: t.quantity };
      const sFacts: LineUnitFacts = { ...s, quantity: s.quantity };
      const ccy = currency(target.currency);
      const sameUnit = t.unitId === s.unitId;
      // The target's quantity in the SOURCE's unit: its own entered figure when it is in that unit.
      const inSourceUnit = enteredQuantity(
        sameUnit
          ? tFacts
          : {
              lineNo: t.lineNo,
              quantity: t.quantity,
              unitQuantity: null,
              unitNumerator: s.unitNumerator,
              unitDenominator: s.unitDenominator,
            },
      );
      const sourcePrice = Money.of(s.unitPrice, ccy);
      const amount = sourcePrice
        .multiply(inSourceUnit, "HALF_AWAY_FROM_ZERO")
        .subtract(Money.of(t.discount, ccy));
      let unitPrice = sourcePrice;
      if (!sameUnit) {
        // base per target unit ÷ base per source unit — each factor read for its own line, refused if absent.
        const tf = enteredQuantity({ ...tFacts, quantity: "1", unitQuantity: null });
        const sf = enteredQuantity({ ...sFacts, quantity: "1", unitQuantity: null });
        unitPrice = sourcePrice.multiply(
          rational(sf.numerator * tf.denominator, sf.denominator * tf.numerator),
          "HALF_AWAY_FROM_ZERO",
        );
      }
      // The tax columns are reset to the untaxed state and recomputed below for the whole draft (MON-14):
      // a stale `tax_amount`/`total_incl_tax` beside a new `amount` left a taxed draft that could not post.
      const updated = await tx`
        update app.document_line t
           set unit_price     = ${unitPrice.toString()},
               amount         = ${amount.toString()},
               tax_amount     = 0,
               total_incl_tax = 0,
               tax_code_id    = ${carriesCode ? tx`coalesce(t.tax_code_id, s.tax_code_id)` : tx`t.tax_code_id`}
          from app.document_line s
         where t.id = ${l.targetLineId}
           and t.document_id = ${input.targetDocumentId}
           and s.id = ${l.sourceLineId}
           and s.document_id = ${input.sourceDocumentId}
           and t.unit_price is null
           and s.unit_price is not null
           and t.quantity is not null`;
      if (updated.count > 0) priced = true;
    }
  }
  // MON-14: a copied price changes `amount`, so the draft's tax is recomputed by the one persist-time
  // computation `PUT …/lines` and `convertToInvoice` use (spec:2228, ADR 0050). The target is a draft —
  // 0037's trigger refuses any other — and an untaxed line comes back `total_incl_tax = amount`.
  if (priced) await computeDocumentTax(tx, ctx, input.targetDocumentId);
  return created;
}

export async function listLinks(tx: Sql, documentId: string): Promise<DocumentLinkRow[]> {
  const rows = await tx<LinkDbRow[]>`
    select id, company_id, source_document_id, source_line_id, target_document_id, target_line_id,
           link_kind, quantity::text as quantity, amount::text as amount, created_at
      from app.document_link
     where source_document_id = ${documentId} or target_document_id = ${documentId}
     order by created_at, id`;
  return rows.map(toRow);
}

export async function openQuantity(tx: Sql, documentId: string): Promise<OpenQuantityRow[]> {
  const rows = await tx<
    {
      document_id: string;
      document_line_id: string;
      line_no: number;
      item_id: string | null;
      ordered_quantity: string;
      linked_quantity: string;
      open_quantity: string;
    }[]
  >`
    select document_id, document_line_id, line_no, item_id,
           ordered_quantity::text as ordered_quantity,
           linked_quantity::text  as linked_quantity,
           open_quantity::text    as open_quantity
      from app.document_open_quantity
     where document_id = ${documentId}
     order by line_no`;
  return rows.map((r) => ({
    documentId: r.document_id,
    documentLineId: r.document_line_id,
    lineNo: r.line_no,
    itemId: r.item_id,
    orderedQuantity: r.ordered_quantity,
    linkedQuantity: r.linked_quantity,
    openQuantity: r.open_quantity,
  }));
}
