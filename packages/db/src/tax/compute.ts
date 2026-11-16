// packages/db/src/tax/compute.ts
import type { Sql } from "postgres";
import {
  currency,
  Money,
  contradictsSide,
  Quantity,
  rational,
  taxEngine,
  taxSideOf,
  TaxError,
  type CurrencyCode,
  type PostingPolicy,
  type TaxLineInput,
} from "@dulja/domain";
import { PostingError } from "../posting/errors";
import { CASH_ROUNDING_FIELD } from "../sync/cash-rounding";
import { PROMOTION_FIELD } from "../sync/promotion";
import { resolvePolicy } from "../posting/load";
import type { TenantContext } from "../with-tenant";
import { loadTaxCodeRefs, resolveRegimeFor, resolvePosReturnTaxSource } from "./codes";

/**
 * The ONE resolution of §4.4.1's `tax.inclusive`, which is `boolean | "header.tax_inclusive"`.
 *
 * 2A's `evaluatePolicy` resolves it with the identical expression. It is exported from here so a reviewer
 * can see there is one rule and not two: a draft computed inclusive against a plan evaluated exclusive
 * would put a different tax on the invoice than in the ledger, and nothing would notice until the return.
 */
export function resolveInclusive(policy: PostingPolicy, headerTaxInclusive: boolean): boolean {
  if (policy.tax.applies !== true) return false;
  const declared = policy.tax.inclusive;
  return declared === "header.tax_inclusive" ? headerTaxInclusive : declared === true;
}

export interface ComputedTaxLine {
  lineId: string;
  lineNo: number;
  /** The tax-EXCLUSIVE base, rewritten on the row when the document is inclusive (§4.3.4). */
  amount: string;
  taxAmount: string;
  totalInclTax: string;
}

/**
 * Recomputes `document_line.tax_amount` and `total_incl_tax` for every line of a DRAFT document, and
 * rewrites `amount` to the extracted base when the document is tax-inclusive.
 *
 * spec:2228 requires rounding "applied server-side at persist time", and ADR 0050 fixes this as the one
 * call site: the evaluator, the ledger and the return then all read one number. `tax_amount` and
 * `total_incl_tax` are never accepted from the wire (§4.2.8's `DocumentLineInput`), so a client cannot
 * state a tax the server did not compute — SAH-020's commented-out per-transaction tax, inverted.
 *
 * Idempotent: it derives everything from `amount` and `total_incl_tax`, taking the ENTERED figure for an
 * inclusive line from `total_incl_tax` once one has been written, so a second call cannot tax a tax.
 */
export async function computeDocumentTax(
  tx: Sql,
  ctx: TenantContext,
  documentId: string,
  options: { historicalSourceId?: string } = {},
): Promise<ComputedTaxLine[]> {
  const [header] = await tx<
    {
      status: string;
      document_type_id: string;
      effective_date: string;
      currency: string;
      tax_inclusive: boolean;
      company_id: string;
    }[]
  >`
    select status, document_type_id, effective_date::text, currency, tax_inclusive, company_id
      from app.document where id = ${documentId} for update`;
  if (!header) throw new PostingError("ERR_NOT_FOUND", `document ${documentId} is not visible`);
  if (header.status !== "draft") {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${documentId} is ${header.status}, not draft — a posted document is corrected by reversal (SAH-041)`,
    );
  }

  const { definition } = await resolvePolicy(tx, header.document_type_id, header.effective_date);
  const inclusive = resolveInclusive(definition, header.tax_inclusive);
  const ccy = currency(header.currency);

  const lines = await tx<
    {
      id: string;
      line_no: number;
      amount: string;
      total_incl_tax: string;
      tax_code_id: string | null;
    }[]
  >`
    select id, line_no, amount::text, total_incl_tax::text, tax_code_id
      from app.document_line where document_id = ${documentId} order by line_no`;

  const regime = await resolveRegimeFor(tx, documentId);
  const sourceId = options.historicalSourceId ?? null;
  if (sourceId !== null && sourceId !== (await resolvePosReturnTaxSource(tx, documentId)))
    throw new PostingError(
      "ERR_VALIDATION_FAILED",
      "historical tax source is not the verified linked POS sale",
    );
  const refs = await loadTaxCodeRefs(tx, header.company_id, header.effective_date, sourceId);

  const inputs: TaxLineInput[] = [];
  const untaxed: { id: string; line_no: number; amount: string }[] = [];
  for (const l of lines) {
    if (!definition.tax.applies || l.tax_code_id === null) {
      untaxed.push(l);
      continue;
    }
    const code = refs[l.tax_code_id];
    if (!code) {
      // The FK guarantees the row exists (0055), so the only way to miss it is `archived_at` or an
      // effective range that does not cover this document's date. Both are refusals, not silent zeroes.
      const [why] = await tx<
        {
          code: string;
          archived_at: string | null;
          effective_from: string;
          effective_to: string | null;
        }[]
      >`
        select code, archived_at::text, effective_from::text, effective_to::text
          from app.tax_code where id = ${l.tax_code_id}`;
      throw new PostingError(
        "ERR_TAX_REGIME_MISMATCH",
        why?.archived_at
          ? `line ${l.line_no}: tax code ${why.code} is archived`
          : `line ${l.line_no}: tax code ${why?.code ?? l.tax_code_id} is not effective on ` +
              `${header.effective_date} (${why?.effective_from}..${why?.effective_to ?? "open"})`,
      );
    }
    // MON-04: a code whose kind declares the other side of this document's policy — an input code on a sale,
    // an output code on a purchase — is refused at persist time, before any tax is written. Zero-rated and
    // exempt codes declare no side and take the document's (`taxSideOf`), which is how the return boxes them.
    if (contradictsSide(code.kind, taxSideOf(definition))) {
      throw new PostingError(
        "ERR_VALIDATION_FAILED",
        `line ${l.line_no}: tax code ${code.code} is an ${code.kind} code and ${definition.documentType} ` +
          `carries ${taxSideOf(definition)} tax`,
      );
    }
    // An inclusive line's ENTERED figure is `total_incl_tax` once one has been written, and `amount`
    // before that. This is what makes a second call idempotent instead of taxing an already-net figure.
    const entered = inclusive && l.total_incl_tax !== "0.0000" ? l.total_incl_tax : l.amount;
    inputs.push({ lineNo: l.line_no, amount: Money.of(entered, ccy), taxCode: code, inclusive });
  }

  if (sourceId !== null) return computeHistoricalPosTax(tx, documentId, sourceId, ccy);

  let results: ReturnType<typeof taxEngine.compute> = [];
  if (inputs.length > 0) {
    if (!regime)
      throw new PostingError(
        "ERR_TAX_REGIME_MISMATCH",
        `document ${documentId} has coded lines but no regime`,
      );
    try {
      results = taxEngine.compute(regime, inputs);
    } catch (e) {
      // The engine cannot import AppError (§3.1) and neither can this module; the token is preserved.
      if (e instanceof TaxError) throw new PostingError(e.code, e.detail);
      throw e;
    }
  }

  const out: ComputedTaxLine[] = [];
  for (const r of results) {
    const line = lines.find((l) => l.line_no === r.lineNo)!;
    const total = r.base.add(r.tax);
    await tx`
      update app.document_line
         set amount = ${r.base.toString()}, tax_amount = ${r.tax.toString()},
             total_incl_tax = ${total.toString()}
       where id = ${line.id}`;
    out.push({
      lineId: line.id,
      lineNo: r.lineNo,
      amount: r.base.toString(),
      taxAmount: r.tax.toString(),
      totalInclTax: total.toString(),
    });
  }
  for (const l of untaxed) {
    // A code-less line is ZEROED, never left alone: SAH-011's whole finding is that one un-populated
    // monetary column nulls a whole period's box. `0.0000` is a figure; a stale one is not.
    await tx`
      update app.document_line set tax_amount = 0, total_incl_tax = ${l.amount} where id = ${l.id}`;
    out.push({
      lineId: l.id,
      lineNo: l.line_no,
      amount: l.amount,
      taxAmount: "0.0000",
      totalInclTax: l.amount,
    });
  }
  return out.toSorted((x, y) => x.lineNo - y.lineNo);
}

/** One POS sale line's standing refund history: the base quantity its `returns` links already claim, and the
 *  entered quantity, discount, net, gross and cost those refund lines took — every one a MAGNITUDE. */
export interface PosReturnHistory {
  quantity: string;
  enteredQuantity: string;
  discount: string;
  net: string;
  gross: string;
  cost: string;
  /** The cash-rounding shares those refund lines took, in the line-direction form `CASH_ROUNDING_FIELD`
   *  stores — a magnitude like `cost`, so it sums unnegated (ADR 0059, 2026-10-22). */
  cashRounding: string;
  /** The promotion shares those refund lines took, in `PROMOTION_FIELD`'s line-direction form, summed the same
   *  way (ADR 0059's PR 12 review amendment). */
  promotion: string;
  /** A counted claim that is not a share of this line written by a POS refund of this sale (ADR 0056). */
  untrusted: boolean;
}

/**
 * The refund history of one source line, read by BOTH `prepareReturns` (which validates the wire figures)
 * and `computeHistoricalPosTax` (which writes them), so the two derive one share from one history. A claim
 * counts while it stands (a void refund, or a reversed one whose chain nets, has released it —
 * `app.document_claim_stands`), and every counted claim must be a POS refund line of this sale that IS the
 * source line: same item, lot, unit and tax code, negative entered and base quantities, a base quantity
 * equal to its link's, total = amount + tax, and no second link. An unknown answer is untrusted.
 * `exceptDocumentId` leaves out the refund being computed. Callers hold 0037's `document_link:<line>` lock.
 */
export async function loadPosReturnHistory(
  tx: Sql,
  sourceLineId: string,
  sourceDocumentId: string,
  exceptDocumentId: string | null,
): Promise<PosReturnHistory> {
  const [row] = await tx<PosReturnHistory[]>`
    select coalesce(sum(k.quantity), 0)::text as quantity,
           (-coalesce(sum(coalesce(l.unit_quantity, l.quantity)), 0))::text as "enteredQuantity",
           (-coalesce(sum(l.discount), 0))::text as discount,
           (-coalesce(sum(l.amount), 0))::text as net,
           (-coalesce(sum(l.total_incl_tax), 0))::text as gross,
           coalesce(sum(l.cost), 0)::text as cost,
           -- Read only where the sync path wrote it (a terminal's POS ticket, four places), so a hand-drafted
           -- line's free-form value is counted as untrusted below rather than raising a cast error here.
           coalesce(sum(case when t.terminal_id is not null and dt.code = 'POS_TICKET'
                              and l.custom_fields ->> ${CASH_ROUNDING_FIELD}::text ~ '^-?[0-9]+[.][0-9]{4}$'
                             then (l.custom_fields ->> ${CASH_ROUNDING_FIELD}::text)::numeric end), 0)::text as "cashRounding",
           coalesce(sum(case when t.terminal_id is not null and dt.code = 'POS_TICKET'
                              and l.custom_fields ->> ${PROMOTION_FIELD}::text ~ '^[0-9]+[.][0-9]{4}$'
                             then (l.custom_fields ->> ${PROMOTION_FIELD}::text)::numeric end), 0)::text as promotion,
           coalesce(bool_or(coalesce(
             t.terminal_id is null or dt.code <> 'POS_TICKET'
             or l.custom_fields ->> 'posReturnSource' is distinct from ${sourceDocumentId}::text
             or l.total_incl_tax <> l.amount + l.tax_amount
             or l.item_id is distinct from s.item_id or l.lot_id is distinct from s.lot_id
             or l.unit_id is distinct from s.unit_id or l.tax_code_id is distinct from s.tax_code_id
             or l.quantity >= 0 or coalesce(l.unit_quantity, l.quantity) >= 0 or abs(l.quantity) <> k.quantity
             or exists (select 1 from app.document_link other
                         where other.target_line_id = l.id and other.id <> k.id), true)), false) as untrusted
      from app.document_link k
      join app.document_line s on s.id = k.source_line_id
      join app.document_line l on l.id = k.target_line_id
      join app.document t on t.id = k.target_document_id
      join app.document_type dt on dt.id = t.document_type_id
     where k.source_line_id = ${sourceLineId} and k.link_kind = 'returns'
       and (${exceptDocumentId}::uuid is null or k.target_document_id <> ${exceptDocumentId}::uuid)
       and (t.status not in ('void', 'reversed')
            or (t.status = 'reversed' and app.document_claim_stands(t.id)))`;
  return row!;
}

export interface PosReturnShare {
  /** The entered quantity returned once this refund stands. */
  cumulative: Quantity;
  /** This refund brings the entered quantity returned to the whole of the source line's. */
  completes: boolean;
  /** The base quantity this refund's `returns` link claims. */
  linked: Quantity;
  /** This refund's magnitude of one source figure, given what earlier refunds took of it. */
  share<C extends CurrencyCode>(full: Money<C>, previous: Money<C>): Money<C>;
}

/**
 * **The ONE share rule of a referenced POS refund** (ADR 0056, "Full reversal, quantity residues and
 * collisions"): every budget — gross, net, discount, cost and the base quantity — is
 * round(full × cumulative entered ÷ source entered) less what earlier refunds took, and the refund that
 * completes the source's ENTERED quantity takes the exact residue. The ratio is of ENTERED quantities, never
 * of base ones: a base quantity is already rounded to six places (seven thirds are 2.333333), so a base ratio
 * (0.333333 ÷ 2.333333) refunds one of seven thirds sold for 7000.0000 at 999.9991 where the till, and the
 * wire, say 1000.0000. It is the rule the till prices a refund with (`apps/pos` `returnTicket`),
 * `prepareReturns` validates the wire with, and `computeHistoricalPosTax` writes, with the same exact
 * `Rational` arithmetic, so the three cannot drift.
 *
 * The caller bounds the quantities first: `source.enteredQuantity` must be positive and `cumulative` not
 * above it.
 */
export function posReturnShare(
  source: { quantity: Quantity; enteredQuantity: Quantity },
  history: { quantity: Quantity; enteredQuantity: Quantity },
  entered: Quantity,
): PosReturnShare {
  const cumulative = history.enteredQuantity.add(entered);
  const completes = cumulative.compare(source.enteredQuantity) === 0;
  // `Quantity.toString()` is fixed at six places, so both digit strings are scaled alike.
  const ratio = rational(
    BigInt(cumulative.toString().replace(".", "")),
    BigInt(source.enteredQuantity.toString().replace(".", "")),
  );
  const budget = completes
    ? source.quantity
    : source.quantity.multiply(ratio, "HALF_AWAY_FROM_ZERO");
  return {
    cumulative,
    completes,
    linked: budget.subtract(history.quantity),
    share: (full, previous) =>
      (completes ? full : full.multiply(ratio, "HALF_AWAY_FROM_ZERO")).subtract(previous),
  };
}

/**
 * Historical POS refunds use the immutable sale's shares, with the completing refund taking the residue —
 * through `posReturnShare` and `loadPosReturnHistory`, the rule and the history `prepareReturns` validated
 * the wire with, so a refund it accepted is never rewritten here to a figure `verifyTax` then refuses.
 *
 * Each refund line must BE its linked sale line — same item, lot, unit and tax code, negative entered and
 * base quantities, and the base quantity its link claims — and that link must be the rule's share of the
 * sale's base quantity. Otherwise the sale's figures would be written onto a line that is not the one sold.
 */
async function computeHistoricalPosTax(
  tx: Sql,
  documentId: string,
  sourceId: string,
  ccy: CurrencyCode,
): Promise<ComputedTaxLine[]> {
  const lines = await tx<{ id: string; line_no: number; kind: string; amount: string }[]>`
    select id, line_no, kind, amount::text from app.document_line
     where document_id = ${documentId} order by line_no`;
  const out: ComputedTaxLine[] = [];
  for (const line of lines) {
    let net = Money.of(line.amount, ccy);
    let gross = net;
    if (line.kind === "item") {
      const links = await tx<
        {
          quantity: string;
          source_line_id: string;
          source_quantity: string;
          source_entered_quantity: string;
          entered_quantity: string;
          net: string;
          gross: string;
          invalid_identity: boolean;
        }[]
      >`
        select k.quantity::text as quantity, source.id as source_line_id,
               source.quantity::text as source_quantity,
               coalesce(source.unit_quantity, source.quantity)::text as source_entered_quantity,
               (-coalesce(current_line.unit_quantity, current_line.quantity))::text as entered_quantity,
               source.amount::text as net, source.total_incl_tax::text as gross,
               coalesce(
                 current_line.item_id is distinct from source.item_id
                 or current_line.lot_id is distinct from source.lot_id
                 or current_line.unit_id is distinct from source.unit_id
                 or current_line.tax_code_id is distinct from source.tax_code_id
                 or current_line.quantity >= 0
                 or coalesce(current_line.unit_quantity, current_line.quantity) >= 0
                 or abs(current_line.quantity) <> k.quantity, true) as invalid_identity
          from app.document_link k
          join app.document_line source on source.id = k.source_line_id
          join app.document_line current_line on current_line.id = k.target_line_id
         where k.target_document_id = ${documentId} and k.target_line_id = ${line.id}
           and k.source_document_id = ${sourceId} and k.link_kind = 'returns'`;
      if (links.length !== 1)
        throw new PostingError(
          "ERR_VALIDATION_FAILED",
          `line ${line.line_no}: historical refund source is ambiguous or untrusted`,
        );
      const link = links[0]!;
      if (link.invalid_identity)
        throw new PostingError(
          "ERR_VALIDATION_FAILED",
          `line ${line.line_no}: a refund line must carry its linked sale line's item, lot, unit and tax code, ` +
            "with a negative quantity equal to its link's",
        );
      const history = await loadPosReturnHistory(tx, link.source_line_id, sourceId, documentId);
      if (history.untrusted)
        throw new PostingError(
          "ERR_VALIDATION_FAILED",
          `line ${line.line_no}: historical refund source is ambiguous or untrusted`,
        );
      const sourceEntered = Quantity.of(link.source_entered_quantity);
      const previousEntered = Quantity.of(history.enteredQuantity);
      const entered = Quantity.of(link.entered_quantity);
      if (
        sourceEntered.isZero() ||
        sourceEntered.isNegative() ||
        previousEntered.add(entered).compare(sourceEntered) > 0
      )
        throw new PostingError(
          "ERR_VALIDATION_FAILED",
          `line ${line.line_no}: historical refund quantity is outside the sale`,
        );
      const rule = posReturnShare(
        { quantity: Quantity.of(link.source_quantity), enteredQuantity: sourceEntered },
        { quantity: Quantity.of(history.quantity), enteredQuantity: previousEntered },
        entered,
      );
      if (rule.linked.compare(Quantity.of(link.quantity)) !== 0)
        throw new PostingError(
          "ERR_VALIDATION_FAILED",
          `line ${line.line_no}: historical refund quantity ${link.quantity} is not the sale's proportional ` +
            `share ${rule.linked.toString()}`,
        );
      net = rule.share(Money.of(link.net, ccy), Money.of(history.net, ccy)).negate();
      gross = rule.share(Money.of(link.gross, ccy), Money.of(history.gross, ccy)).negate();
    }
    const tax = gross.subtract(net);
    await tx`
      update app.document_line
         set amount = ${net.toString()}, tax_amount = ${tax.toString()}, total_incl_tax = ${gross.toString()}
       where id = ${line.id}`;
    out.push({
      lineId: line.id,
      lineNo: line.line_no,
      amount: net.toString(),
      taxAmount: tax.toString(),
      totalInclTax: gross.toString(),
    });
  }
  return out;
}
