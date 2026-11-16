import { Money, Quantity, currency, parsePolicy, rational, type Rational } from "@dulja/domain";
import type { Sql } from "postgres";
import { costLegMovement } from "../costing/apply-movements";
import { enteredQuantity, linkFulfilment } from "../documents/link";
import { resolvePolicy } from "../posting/load";
import { computeDocumentTax, resolveInclusive } from "../tax/compute";
import type { TenantContext } from "../with-tenant";
import { resolvePartyTerm } from "./payment-term";
import { sharedCorridor } from "./policy-shape";

/**
 * A 6-dp quantity string as an exact count of micro-units. `Quantity.toString()` is fixed at QUANTITY_SCALE
 * (§4.2.1), so removing the point is exact and no float or `Decimal` is involved — which is what lets this
 * file honour the rule 3B fixed for `packages/db/src/costing`: `decimal.js` is `packages/domain`'s
 * dependency (§4.2.1, D11) and no file under `packages/db/src` imports it. Every money operation below goes
 * through `Money` and an exact `Rational`.
 *
 * Exported because `credit-note.ts` (4A Task 8) needs the same conversion and two copies of one function is
 * hazard 9 — and, since the PR 11 review's third round, so does 3D's `inventory/fulfilment.ts`, which shares an
 * order line's discount across the delivery lines it drafts by the same exact micro-unit ratio. Deliberately
 * NOT re-exported from `ar-ap/index.ts`: both readers import it from this module, inside `packages/db/src`.
 */
export function micro(quantity: string): bigint {
  const fixed = Quantity.of(quantity).toString();
  const negative = fixed.startsWith("-");
  const digits = (negative ? fixed.slice(1) : fixed).replace(".", "");
  return negative ? -BigInt(digits) : BigInt(digits);
}

/** One source line to convert, and how much of it. `quantity` is a 6-dp string, never a number. */
export interface ConvertLine {
  sourceLineId: string;
  quantity: string;
  /** 5A — this line's tax code; absent, the input's `taxCodeId`, then the source line's own. `null` is an
   *  explicit "no code" for this line, never a fall-through. */
  taxCodeId?: string | null | undefined;
}

export interface ConvertToInvoiceInput {
  /** The company the caller's permission gate cleared. RLS bounds the tenant and nothing else, so the source
   *  document AND the target type are both matched on it (AGENTS.md: an entity id alone reaches a sibling
   *  company's rows inside the same tenant). */
  companyId: string;
  /** A posted DELIVERY_ORDER, or a posted GOODS_RECEIPT (4A Task 7). */
  sourceDocumentId: string;
  /** SALES_INVOICE, or PURCHASE_INVOICE — a type of `companyId`. */
  targetDocumentTypeId: string;
  targetSeries: string;
  effectiveDate: string;
  /** 5A — the tax code of every converted line that names none of its own (so the empty-`lines` call can be
   *  taxed). A code of `companyId`. Absent: each source line's own code; `null`: no code for those lines,
   *  the source lines' codes NOT inherited (the explicit untaxed conversion). */
  taxCodeId?: string | null | undefined;
  /** Empty = every open line at its full open quantity. */
  lines: readonly ConvertLine[];
}

export interface ConvertToInvoiceResult {
  documentId: string;
  lineIds: string[];
  linkIds: string[];
}

/** `packages/db` may not import `AppError` (§3.1). A thrown error carrying an existing ErrCode as `code` is
 *  what the API's `fromDomainError` lifts — the shape `payment-term.ts` and `ItemAccountUnresolvedError` use.
 *  Exported for `credit-note.ts` (4A Task 8) and `allocation.ts` (Task 9) on `micro`'s terms: shared inside
 *  `ar-ap/`, not re-exported. `ERR_MONEY_CURRENCY_MISMATCH` is 0D's row, raised by allocation.ts naming the
 *  document rather than leaving `Money` to name only the two codes. */
export function codedError(
  code:
    | "ERR_NOT_FOUND"
    | "ERR_VALIDATION_FAILED"
    | "ERR_DOC_STATUS_ILLEGAL"
    | "ERR_MONEY_CURRENCY_MISMATCH",
  detail: string,
): Error {
  return Object.assign(new Error(`${code}: ${detail}`), { code });
}

interface SourceLine {
  id: string;
  lineNo: number;
  itemId: string | null;
  unitId: string | null;
  warehouseId: string | null;
  lotId: string | null;
  description: string | null;
  dimensions: Record<string, string>;
  taxCodeId: string | null;
  quantity: string;
  /** The quantity as entered and the exact factor of `unitId` — `enteredQuantity`'s facts (MON-02). */
  unitQuantity: string | null;
  unitNumerator: string | null;
  unitDenominator: string | null;
  openQuantity: string;
  unitPrice: string | null;
  discount: string;
  amount: string;
  cost: string | null;
  convertedQuantity: string;
  convertedDiscount: string;
  convertedAmount: string;
  convertedCost: string;
}

/**
 * §4.15's `1250` and `2150` rows, and spec:1051's "4 (invoice link)". Drafts an invoice from a POSTED stock
 * document of `companyId` and links it `converts_to` through 3C's `linkFulfilment`. One function serves both
 * directions: the columns are the same and the TARGET's policy decides the accounts (ADR 0044).
 *
 * Per line it copies `item_id`, `unit_id`, `warehouse_id`, `lot_id`, `description`, `dimensions`,
 * `unit_price`, the CONVERTED `quantity`, and three money figures pro-rated by `quantity ÷ source.quantity`
 * — `discount`, `amount` and, load-bearing, **`cost`** (contracts §4.7.2 amendment 5: `applyMovements` and
 * the two 4A conversion services are the only writers of `document_line.cost`), so the invoice relieves the
 * corridor by THE figure that filled it (SAH-009). That figure is what the source's movement BOOKED —
 * |inventory_movement.value| of the movement the line's cost leg was filled from, immutable —
 * `costLegMovement`, the one definition `applyMovements` fills a delivery's `1250` leg by: the line's issue
 * movement, or its only one. Not the sum over the line's movements: a `transfer` line carries two, its leg
 * took one, and the sum relieved twice what the leg debited (code review 3, R7). A receipt's `2150` leg is its
 * `amount`, which is copied as it stands, and a PURCHASE_INVOICE posts no cost. Never the source line's
 * current `document_line.cost`, which a cost replay rewrites (ADR 0038 note 2) while its difference posts
 * through 3B's COST_ADJUSTMENT (contracts 4A amendment 5, round 8): copying the rewritten figure took a recost
 * out of `1250` a second time (code review 2, C5). A line with no movement keeps its own `cost`, which no
 * replay touches. The cost stays BASE currency (3B
 * amendment A4) and is never converted at the invoice's rate: the evaluator writes a cost leg at rate 1.
 *
 * **Tax (5A, policy version 2; proposed in ADR 0050's 2026-10-06 amendment).** Each line's `tax_code_id` is
 * the line's own `taxCodeId`, else the input's, else the SOURCE line's, else null — chained on `undefined`,
 * so an explicit `null` at either level is "no code" and stops the chain (the caller's way to clear an
 * inherited code). 3D's `convertOrderToDelivery` carries the order line's code and the order's
 * `tax_inclusive` onto the delivery, so an order's code reaches the invoice by default. Every code so
 * resolved must be a code of the source's company (one check for the set, before any insert —
 * `document_line_tax_code_fk` is tenant-composite only). Once the lines and links are written,
 * `computeDocumentTax` fills `tax_amount` and `total_incl_tax` — the one persist-time computation
 * `PUT …/lines` uses (spec:2228, ADR 0050), whose ERR_TAX_REGIME_MISMATCH is the refusal of an archived code
 * or one not effective on the invoice's date. A line that resolves no code is computed untaxed, as on every
 * other entry point. The residue below sums earlier conversions' `amount`, which must stay the NET figure,
 * so the draft must be computed tax-EXCLUSIVE, where `amount` is never rewritten. Three rules hold that:
 *  - the header is written `tax_inclusive` false, which is exclusive under a policy whose `tax.inclusive`
 *    is `"header.tax_inclusive"` (both seeded packs);
 *  - a coded line into a target whose policy DECLARES `inclusive: true` — where `resolveInclusive` takes
 *    the policy over the header — is refused, inherited codes included (the target type is the caller's
 *    choice, and `taxCodeId: null` clears an inherited code, so there are exits);
 *  - a coded line — named OR inherited — from a tax-INCLUSIVE source is refused when the target applies
 *    tax: its price is gross, and a residue over gross figures is not defined (an owner question). An
 *    inherited code is refused rather than dropped, because dropping it would draft an untaxed invoice under
 *    a taxing policy with no signal; the caller converts such a source untaxed only by saying so, with
 *    `taxCodeId: null`.
 * A converted draft's lines cannot be replaced afterwards: `PUT …/lines` refuses a draft whose lines are
 * `converts_to` targets (as it refuses a `creditNoteFrom` draft, whose lines are `returns` targets), because
 * the replacement would cascade the links away and reopen the source. The draft is deleted and converted
 * again.
 *
 * **The conversion that completes a source line takes the RESIDUE** — `whole − Σ already converted` rather
 * than the pro-rata — for each of the three figures, so `1250` (cost) and `2150` (amount) reach exactly zero
 * rather than within 0.0001 of it. "Completes" is `Σ converted quantity + this quantity = source quantity`,
 * over the `converts_to` links whose claim stands (0116's `app.document_claim_stands`, the view's own rule);
 * it is deliberately NOT "the open quantity reaches zero", because a
 * `returns` link (3C's PURCHASE_RETURN against a receipt) also consumes open quantity, and the residue of a
 * line part of which went back to the vendor is not the vendor's to invoice.
 *
 * **A source line with no amount but a price is priced.** 3D's `convertOrderToDelivery` writes `amount = 0`
 * on every delivery line — a delivery recognises no revenue (F-19) — and copies the order's `unit_price` so
 * this service can read it (3d:2664). Its extended value is therefore `round(unit_price × entered
 * quantity, 4) − discount` — the price is per ENTERED unit (`enteredQuantity`; ADR 0044's 2026-11-16
 * amendment, MON-02), so a carton line is extended over its cartons, never its base pieces; any other line's is its stored `amount`, which on a receipt IS the `2150` accrual and so must be
 * copied rather than recomputed.
 *
 * It carries only QUANTITY-BEARING lines and every target line is `kind: 'item'`: the source read inner-joins
 * `app.document_open_quantity`, whose definition carries `where l.quantity is not null`, so 3C's freight,
 * duty and clearance `account` lines never reach the invoice — they are cleared by the forwarder's own
 * invoice, a different party (4A Task 7).
 *
 * It writes `document`, `document_line` and (through 3C) `document_link` rows and UPDATEs no line:
 * `priceFromSource` is false because every figure is written at insert onto the draft it creates, which is
 * all 0113's `document_line_frozen_after_draft` admits once a document leaves draft. Over-fulfilment is
 * refused by 3C's own trigger (`ERR_DOC_LINK_OVER_FULFILLED`), never re-implemented here.
 *
 * Raises ERR_NOT_FOUND (a source, target type or tax code not of `companyId`), ERR_DOC_STATUS_ILLEGAL (a
 * source that is not posted — nothing in the corridor to relieve), ERR_VALIDATION_FAILED (a source that is
 * not a stock movement in the target's direction, or one whose policy filled no corridor the target relieves
 * — `sharedCorridor`; a line not on the source or asked for twice, a non-positive quantity, a source with
 * nothing open, a coded line — named or inherited — from a tax-inclusive source under a target that applies
 * tax, a coded line into a target whose policy declares tax inclusive) and, from `computeDocumentTax`,
 * ERR_TAX_REGIME_MISMATCH.
 */
export async function convertToInvoice(
  tx: Sql,
  ctx: TenantContext,
  input: ConvertToInvoiceInput,
): Promise<ConvertToInvoiceResult> {
  const [head] = await tx<
    {
      companyId: string;
      status: string;
      partyId: string | null;
      currency: string;
      exchangeRate: string;
      rateSource: string | null;
      branchId: string;
      warehouseId: string | null;
      baseCurrency: string;
      taxInclusive: boolean;
      direction: string | null;
      effect: string | null;
      policy: unknown;
    }[]
  >`
    select d.company_id as "companyId", d.status::text as status, d.party_id as "partyId",
           d.currency::text as currency, d.exchange_rate::text as "exchangeRate",
           d.rate_source as "rateSource", d.branch_id as "branchId", d.warehouse_id as "warehouseId",
           c.base_currency::text as "baseCurrency", d.tax_inclusive as "taxInclusive",
           p.definition->>'direction' as direction, p.definition->'inventory'->>'effect' as effect,
           p.definition as policy
      from app.document d
      join app.company c on c.id = d.company_id
      left join app.posting_policy p on p.id = d.posting_policy_id
     where d.id = ${input.sourceDocumentId} and d.company_id = ${input.companyId}
       for share of d`;
  // `for share` (A5): `reverseDocument` locks the source `for update` and refuses while a conversion of it is
  // unposted, so a conversion that starts during an uncommitted reversal waits here and then reads `reversed`,
  // and a reversal that starts during a conversion waits and then sees its link.
  if (head === undefined) {
    throw codedError(
      "ERR_NOT_FOUND",
      `source document ${input.sourceDocumentId} is not a document of company ${input.companyId}`,
    );
  }
  if (head.status !== "posted") {
    throw codedError(
      "ERR_DOC_STATUS_ILLEGAL",
      `source document ${input.sourceDocumentId} is not posted (it is ${head.status}) — it has filled no corridor to relieve`,
    );
  }

  // The target type is bound to the SAME company as the source. `document.document_type_id`'s FK is
  // tenant-composite, so without this a sibling company's type — and its policy — would draft onto this
  // company's delivery.
  const [targetType] = await tx<{ id: string }[]>`
    select id from app.document_type
     where id = ${input.targetDocumentTypeId} and company_id = ${head.companyId}
       and archived_at is null`;
  if (targetType === undefined) {
    throw codedError(
      "ERR_NOT_FOUND",
      `document type ${input.targetDocumentTypeId} is not a live type of company ${head.companyId}`,
    );
  }
  // The policy the invoice will post under, resolved exactly as §4.3.2 step 4 will resolve it.
  const { definition: target } = await resolvePolicy(tx, targetType.id, input.effectiveDate);
  // The source's PINNED policy (§4.3.2 step 13). Only a stock movement fills a corridor, and only in its own
  // direction: a posted invoice moved no stock (converting it would relieve 1250 twice for one delivery),
  // and a receipt's line cost is a receipt value, not goods that left. Refused by policy SHAPE, never by
  // document-type code (3C's rule for its landed-cost sub-path).
  if (head.effect === null || head.effect === "none" || head.direction !== target.direction) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `source document ${input.sourceDocumentId} is not a stock movement in the ${target.direction} direction ${target.documentType} invoices`,
    );
  }
  // …and only one that FILLED the corridor this invoice relieves (code review 2026-09-29). Direction and
  // effect are not enough: a PURCHASE_RETURN is an outbound issue too, but it debits the party's payable
  // account and never touched 1250, so a SALES_INVOICE copying its cost would credit 1250 below zero and charge
  // COGS for goods already relieved against 2100. `sharedCorridor` asks the two POLICIES (shape, not code).
  if (sharedCorridor(parsePolicy(head.policy), target).length === 0) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `source document ${input.sourceDocumentId} filled no corridor ${target.documentType} relieves: its policy puts nothing on the account the invoice takes it off (1250 for a sale, 2150 for a purchase)`,
    );
  }

  // SAH-017's concurrency face, taken BEFORE the read. The closing branch below decides on the converted
  // quantity it reads, and at READ COMMITTED two conversions of one line that each read "one third done"
  // would both take the pro-rata and leave the residue in 1250 forever. The key and the order are 3C's own
  // (0037's trigger locks `document_link:<source line>`, and `linkFulfilment` sorts by source line id), so
  // the trigger's later lock on the same key is re-entrant and no two converters can deadlock.
  const lockable = await tx<{ id: string }[]>`
    select id from app.document_line
     where document_id = ${input.sourceDocumentId} and quantity is not null`;
  for (const id of lockable.map((l) => l.id).toSorted()) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`document_link:${id}`}, 0))`;
  }

  // Open quantity and everything already converted come from ONE statement, so they are one instant. An
  // invoice is excluded exactly as `app.document_open_quantity` excludes it (0116): a void one, and a reversed
  // one whose reversal chain nets, has released its quantity, so its figures are released too, or the residue
  // would be taken against a relief that was undone; a reversed one whose chain is reinstated
  // (app.document_claim_stands) holds its quantity again, so its figures count, or the conversion that
  // completes the line would take the pro-rata and leave the residue in the corridor.
  // `cost` is the line's own column here; the BOOKED figure replaces it below for a line that moved stock.
  const read = await tx<SourceLine[]>`
    select dl.id, dl.line_no as "lineNo", dl.item_id as "itemId", dl.unit_id as "unitId",
           dl.warehouse_id as "warehouseId", dl.lot_id as "lotId", dl.description, dl.dimensions,
           dl.tax_code_id as "taxCodeId",
           dl.quantity::text as quantity, oq.open_quantity::text as "openQuantity",
           dl.unit_quantity::text as "unitQuantity",
           (case when dl.item_id is null or dl.unit_id is null or dl.unit_id = it.base_unit_id then 1
                 else uc.numerator end)::text as "unitNumerator",
           (case when dl.item_id is null or dl.unit_id is null or dl.unit_id = it.base_unit_id then 1
                 else uc.denominator end)::text as "unitDenominator",
           dl.unit_price::text as "unitPrice", dl.discount::text as discount,
           dl.amount::text as amount, dl.cost::numeric(19,4)::text as cost,
           coalesce(done.quantity, 0)::numeric(19,6)::text as "convertedQuantity",
           coalesce(done.discount, 0)::numeric(19,4)::text as "convertedDiscount",
           coalesce(done.amount, 0)::numeric(19,4)::text as "convertedAmount",
           coalesce(done.cost, 0)::numeric(19,4)::text as "convertedCost"
      from app.document_line dl
      join app.document_open_quantity oq on oq.document_line_id = dl.id
      left join app.item it on it.id = dl.item_id
      left join app.unit_conversion uc on uc.item_id = dl.item_id and uc.unit_id = dl.unit_id
      left join lateral (
             select sum(k.quantity) as quantity, sum(tl.discount) as discount,
                    sum(tl.amount) as amount, sum(tl.cost) as cost
               from app.document_link k
               join app.document_line tl on tl.id = k.target_line_id
               join app.document t on t.id = k.target_document_id
              where k.source_line_id = dl.id and k.link_kind = 'converts_to'
                and (t.status not in ('void', 'reversed')
                     or (t.status = 'reversed' and app.document_claim_stands(t.id)))
           ) done on true
     where dl.document_id = ${input.sourceDocumentId}
     order by dl.line_no`;
  // The BOOKED figure — a magnitude, not the replay's rewrite — from the movement `costLegMovement` names,
  // read in the order `applyMovements` handed it the plan's movements (`movement_no`). An issue is stored negative
  // (applyMovements' step 2), so the sign is the effect. A line with no movement keeps its own `cost`.
  const moved = await tx<{ lineNo: number; effect: "issue" | "receipt"; value: string }[]>`
    select m.line_no as "lineNo", case when m.quantity < 0 then 'issue' else 'receipt' end as effect,
           abs(m.value)::numeric(19,4)::text as value
      from app.inventory_movement m
     where m.document_id = ${input.sourceDocumentId}
     order by m.line_no, m.movement_no`;
  const movedByLine = new Map<number, (typeof moved)[number][]>();
  for (const m of moved) movedByLine.set(m.lineNo, [...(movedByLine.get(m.lineNo) ?? []), m]);
  const sources: SourceLine[] = read.map((l) => ({
    ...l,
    cost: costLegMovement(movedByLine.get(l.lineNo) ?? [])?.value ?? l.cost,
  }));

  const asked: readonly ConvertLine[] =
    input.lines.length === 0
      ? sources
          .filter((l) => micro(l.openQuantity) > 0n)
          .map((l) => ({ sourceLineId: l.id, quantity: l.openQuantity }))
      : input.lines;
  if (asked.length === 0) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `source document ${input.sourceDocumentId} has no open line`,
    );
  }

  const cur = currency(head.currency);
  const base = currency(head.baseCurrency);
  const seen = new Set<string>();
  const planned = asked.map((ask) => {
    // One ask per source line: two in one call would each read the same converted quantity, and neither
    // would know the other completes the line.
    if (seen.has(ask.sourceLineId)) {
      throw codedError("ERR_VALIDATION_FAILED", `line ${ask.sourceLineId} is asked for twice`);
    }
    seen.add(ask.sourceLineId);
    const src = sources.find((l) => l.id === ask.sourceLineId);
    if (src === undefined) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `line ${ask.sourceLineId} is not a quantity-bearing line of the source document`,
      );
    }
    const q = micro(ask.quantity);
    if (q <= 0n) {
      throw codedError("ERR_VALIDATION_FAILED", `line ${src.lineNo} quantity must be positive`);
    }
    const signed = micro(src.quantity);
    const whole = signed < 0n ? -signed : signed;

    // The pro-rata factor is an EXACT `Rational` in micro-units, and `Money.multiply` is the one place a
    // rounding mode is named — HALF_AWAY_FROM_ZERO at scale 4, the mode §4.2.1 admits for a base amount. No
    // intermediate decimal exists to round twice.
    const ratio: Rational = whole === 0n ? rational(0n, 1n) : rational(q, whole);
    const completes = micro(src.convertedQuantity) + q === whole;
    const share = (full: Money, already: Money): Money =>
      completes ? full.subtract(already) : full.multiply(ratio, "HALF_AWAY_FROM_ZERO");

    const discount = Money.of(src.discount, cur);
    const stored = Money.of(src.amount, cur);
    // MON-02: the price is per ENTERED unit, so it is extended over the line's entered quantity — never its
    // base `quantity`, which for a carton of twelve billed twelve cartons a carton (`enteredQuantity`).
    let value = stored;
    if (stored.isZero() && src.unitPrice !== null) {
      let entered: Rational;
      try {
        entered = enteredQuantity(src);
      } catch {
        throw codedError(
          "ERR_VALIDATION_FAILED",
          `line ${src.lineNo} names a unit its item has no conversion for, so its price cannot be extended`,
        );
      }
      const magnitude =
        entered.numerator < 0n ? rational(-entered.numerator, entered.denominator) : entered;
      value = Money.of(src.unitPrice, cur)
        .multiply(magnitude, "HALF_AWAY_FROM_ZERO")
        .subtract(discount);
    }
    const amount = share(value, Money.of(src.convertedAmount, cur));
    return {
      src,
      // The line's own, else the input's, else the SOURCE line's code — chained on `undefined`, never `??`:
      // an explicit `null` is "no code" and must stop the chain, or the caller could not clear an inherited
      // code (a line's null beats the input's code; the input's null beats the source line's).
      taxCodeId:
        ask.taxCodeId !== undefined
          ? ask.taxCodeId
          : input.taxCodeId !== undefined
            ? input.taxCodeId
            : src.taxCodeId,
      quantity: Quantity.of(ask.quantity).toString(),
      discount: share(discount, Money.of(src.convertedDiscount, cur)).toString(),
      amount: amount.toString(),
      cost:
        src.cost === null
          ? null
          : share(Money.of(src.cost, base), Money.of(src.convertedCost, base)).toString(),
    };
  });

  // 5A. Every code the invoice will carry — named on a line, on the input, or inherited from the source — is
  // bound to THIS company, once for the set, before anything is written: `document_line_tax_code_fk` (0055)
  // is tenant-composite, so a sibling company's code would satisfy it and its accounts would take this
  // company's tax. Company only, as `PUT …/lines`' `assertLinesBelong` checks it: an archived code, or one not
  // effective on the invoice date, is `computeDocumentTax`'s refusal below, not a 404.
  const taxCodeIds = [
    ...new Set(planned.flatMap((p) => (p.taxCodeId === null ? [] : [p.taxCodeId]))),
  ];
  if (taxCodeIds.length > 0) {
    const found = await tx<{ id: string }[]>`
      select id from app.tax_code
       where company_id = ${head.companyId} and id = any(${taxCodeIds}::uuid[])`;
    const known = new Set(found.map((r) => r.id));
    const stranger = taxCodeIds.find((id) => !known.has(id));
    if (stranger !== undefined) {
      throw codedError(
        "ERR_NOT_FOUND",
        `tax code ${stranger} is not a tax code of company ${head.companyId}`,
      );
    }
    // The residue below is defined over NET figures and the draft must be computed exclusive. An inclusive
    // source's price is gross, and taxing it as net would overstate both the base and the tax; extracting
    // the net per conversion would make the residue sum extracted bases. Refused, not guessed — and only
    // when the target computes tax at all: under a policy that applies none the code computes nothing. A
    // code INHERITED from the source is refused too, never dropped silently: dropping it would draft an
    // untaxed invoice under a policy that applies tax with no signal. The caller who means "untaxed" says so
    // with `taxCodeId: null` — the exit, so such a source is never a dead end.
    if (head.taxInclusive && target.tax.applies) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `source document ${input.sourceDocumentId} is tax-inclusive: a conversion residue is defined over net figures, so a tax code, whether named or inherited, cannot be carried onto its lines (an owner question); to convert it untaxed, pass taxCodeId null explicitly`,
      );
    }
    // The header written below (`tax_inclusive` false) makes the draft exclusive only when the target's
    // policy defers to the header. A policy that DECLARES `inclusive: true` — which §4.4.1 admits and a tenant
    // admin can append — wins over the header in `resolveInclusive`, and `computeDocumentTax` would rewrite
    // each converted NET `amount` to an extracted base that the residue would then sum. The target type is
    // the caller's choice and `taxCodeId: null` clears an inherited code, so this refusal has two exits.
    if (resolveInclusive(target, false)) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `target type ${target.documentType} computes tax inclusive (its policy's tax.inclusive is true on ${input.effectiveDate}): a conversion residue is defined over net figures, so a converted line cannot carry a tax code into it — convert into a type whose policy computes tax exclusive or follows the header, or pass taxCodeId null to convert untaxed`,
      );
    }
  }

  // The pinned term, through the ONE reader of `app.party.payment_term_id` (4A Task 1) — pinned here, at
  // draft, and never re-read (SAH-013).
  const paymentTermId =
    head.partyId === null ? null : await resolvePartyTerm(tx, { partyId: head.partyId });
  // The rate travels with the goods, and so does its provenance (SAH-012). A base-currency source whose rate
  // is the identity pair carries none when the API drafted it; that pair's label is `unit` everywhere else
  // (§4.2.10), and a posted base figure with no provenance is the absence SAH-012 is about.
  const identity = head.currency === head.baseCurrency && head.exchangeRate === "1.00000000";
  const rateSource = head.rateSource ?? (identity ? "unit" : null);

  // `tax_inclusive` is written false, not left to the column default: the residue rule depends on it.
  const [invoice] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, status, series, effective_date, party_id, currency,
       exchange_rate, rate_source, branch_id, warehouse_id, payment_term_id, tax_inclusive)
    values (app.current_tenant(), ${head.companyId}, ${targetType.id}, 'draft', ${input.targetSeries},
            ${input.effectiveDate}::date, ${head.partyId}, ${head.currency}, ${head.exchangeRate},
            ${rateSource}, ${head.branchId}, ${head.warehouseId}, ${paymentTermId}, false)
    returning id`;
  const documentId = invoice!.id;

  const lineIds: string[] = [];
  const fulfilment: { sourceLineId: string; targetLineId: string; quantity: string }[] = [];
  for (const [i, line] of planned.entries()) {
    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, description, item_id, unit_id, warehouse_id,
         lot_id, tax_code_id, quantity, unit_price, discount, amount, tax_amount, total_incl_tax, cost,
         dimensions)
      values (app.current_tenant(), ${head.companyId}, ${documentId}, ${i + 1}, 'item',
              ${line.src.description}, ${line.src.itemId}, ${line.src.unitId}, ${line.src.warehouseId},
              ${line.src.lotId}, ${line.taxCodeId}, ${line.quantity}, ${line.src.unitPrice},
              ${line.discount}, ${line.amount}, ${"0.0000"}, ${line.amount}, ${line.cost},
              ${JSON.stringify(line.src.dimensions)}::text::jsonb)
      returning id`;
    lineIds.push(row!.id);
    fulfilment.push({ sourceLineId: line.src.id, targetLineId: row!.id, quantity: line.quantity });
  }

  // 3C's writer and 3C's guard: the 0037/0109/0110 trigger binds each line to its document and both
  // documents to this company, and refuses more than the open quantity with ERR_DOC_LINK_OVER_FULFILLED.
  const links = await linkFulfilment(tx, ctx, {
    sourceDocumentId: input.sourceDocumentId,
    targetDocumentId: documentId,
    linkKind: "converts_to",
    lines: fulfilment,
    priceFromSource: false,
  });
  // Tax at persist time (spec:2228, ADR 0050), the computation the generic draft and `PUT …/lines` call. The
  // lines were inserted with tax 0 and total = amount; this rewrites both for a coded line, and — the draft
  // being exclusive — never `amount`. An uncoded line, or a target policy that applies no tax, stays at zero.
  await computeDocumentTax(tx, ctx, documentId);
  return { documentId, lineIds, linkIds: links.map((l) => l.id) };
}
