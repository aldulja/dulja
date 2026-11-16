import { Money, Quantity, currency, rational, type Rational } from "@dulja/domain";
import type { Sql } from "postgres";
import { linkFulfilment } from "../documents/link";
import { setEventContext } from "../posting/lifecycle";
import type { TenantContext } from "../with-tenant";
import { codedError, micro } from "./invoice";

/** One settled line to credit, and how many of it come back. `quantity` is a POSITIVE 6-dp string: the
 *  service negates (§4.4.2 A9), so a caller never spells a minus. */
export interface CreditNoteLine {
  settledLineId: string;
  quantity: string;
}

export interface CreditNoteInput {
  /** The company the caller's permission gate cleared. RLS bounds the tenant and nothing else, so the settled
   *  document AND the target type are both matched on it (AGENTS.md). */
  companyId: string;
  /** A posted SALES_INVOICE or PURCHASE_INVOICE of `companyId`. */
  settledDocumentId: string;
  /** The type the settled document's PINNED policy reverses into — SALES_CREDIT_NOTE or PURCHASE_CREDIT_NOTE. */
  targetDocumentTypeId: string;
  targetSeries: string;
  effectiveDate: string;
  /** Required — it reaches `document_event.reason` when the note is issued in the SAME transaction. */
  reason: string;
  /** Empty = every quantity-bearing line at its open quantity. */
  lines: readonly CreditNoteLine[];
}

export interface CreditNoteResult {
  documentId: string;
  lineIds: string[];
  linkIds: string[];
}

interface SettledLine {
  id: string;
  lineNo: number;
  kind: string;
  itemId: string | null;
  accountId: string | null;
  unitId: string | null;
  warehouseId: string | null;
  lotId: string | null;
  description: string | null;
  dimensions: Record<string, string>;
  taxCodeId: string | null;
  quantity: string | null;
  openQuantity: string | null;
  unitPrice: string | null;
  discount: string;
  amount: string;
  totalInclTax: string;
  cost: string | null;
  creditedQuantity: string;
  creditedDiscount: string;
  creditedAmount: string;
  creditedTotal: string;
  creditedCost: string;
  /** The `returns` targets already counted against this line whose claim is not one a credit note of the
   *  settled invoice wrote as a share of this line alone, sorted; null when every claim is (`creditNoteFrom`). */
  untrustedCredits: string[] | null;
}

/** A charge or tax line: money with no quantity for a `returns` link to bound. Text lines carry nothing. */
const unbounded = (l: SettledLine): boolean => l.quantity === null && l.kind !== "text";

function refuseUnbounded(l: SettledLine): never {
  throw codedError(
    "ERR_VALIDATION_FAILED",
    `line ${l.lineNo} carries no quantity for a partial credit to bound; a charge line is credited whole by reversing the invoice`,
  );
}

/**
 * spec:2024, §4.14. Drafts a PARTIAL credit note against a posted invoice of `companyId` and links it `returns`
 * through 3C's `linkFulfilment`. A FULL credit is `reverseDocument(invoice)` and does not come here.
 *
 * Every money and quantity column is written NEGATED — `quantity`, `discount`, `amount`, `tax_amount`,
 * `total_incl_tax` — which is §4.4.2's A9 mechanism and the same shape `reverseDocument` produces, so the
 * credit note's policy carries the invoice's own `side`s and one policy serves both creation paths.
 * `unit_price` is a price, not a magnitude, and is copied unnegated. `cost` is written as a POSITIVE
 * magnitude, because §4.7.2 A6 keeps that column non-negative and ADR 0045 takes its sign from the quantity;
 * it stays BASE currency (3B amendment A4). This is the second of the two services contracts §4.7.2
 * amendment 5 admits as a writer of `document_line.cost`.
 *
 * Per line the NET (`amount`), the GROSS (`total_incl_tax`), the discount and the cost are pro-rated by
 * `quantity ÷ settled quantity` as an exact `Rational` — and **the credit that COMPLETES a settled line takes
 * the residue** (`whole − Σ already credited`), exactly as Task 6's conversion does, so a line credited in
 * thirds leaves AR, revenue, `1250` and cost of goods sold at exactly zero rather than 0.0001 off.
 * **`tax_amount` is never pro-rated: it is DERIVED as gross − net**, on every credited line, completing or
 * not. Rounded on its own it could miss `net + tax = gross` by 0.0001 (net 1.2344, tax 0.1358, gross 1.3702
 * over three units: a third is 0.4115 + 0.0453 ≠ 0.4567), and policy v2 posts the control leg from
 * `line.total_incl_tax` against `line.amount` plus the `each_tax` group of `line.tax_amount`, which the
 * evaluator's document-currency balance check refuses to the last 0.0001. Derived, every line is
 * self-consistent by construction, a full sequence of credits sums to the settled line's tax exactly
 * (Σ gross − Σ net = total − amount), and an untaxed line still derives 0 — its net and gross are one figure
 * and round alike. **A recorded limit, not refused:** the completing credit's tax is a residue like its net
 * and gross, and each earlier credit's derived tax can sit up to 0.0001 above its share, so on a line whose
 * tax is a few ten-thousandths credited in many pieces the completing note can carry tax of the OPPOSITE
 * sign (net 0.0017, tax 0.0002, gross 0.0019 over five units credited singly: four notes of tax 0.0001, then
 * −0.0002, stored +0.0002). It posts balanced and every sum above stays exact. Refusing it would strand the
 * line for good — while gross ≥ net, rounding is monotone and no credit's derived tax can go negative to
 * work the overshoot off — and the residue rule already lets an untaxed line's completing credit run the
 * other way on net and gross alike (0.0005 over ten units: nine of 0.0001, then −0.0004). Removing it means
 * cutting every share as round(full × cumulative quantity ÷ whole) − Σ already credited, which changes how
 * money splits across notes: an ADR (AGENTS.md), not this function's call. `credit-note-rounding.test.ts`
 * pins it. "Completes" is `Σ credited + this = settled quantity`, over the `returns` links whose
 * claim stands (a VOID credit note, or a reversed one whose chain nets, has released its quantity and its
 * figures, as `app.document_open_quantity` releases them; 0116's `app.document_claim_stands` is that rule).
 * The settled lines are locked under 0037's `document_link:<line>` key, sorted, before that read, so two
 * concurrent credits cannot both take the pro-rata and strand the residue.
 *
 * **The residues need a TRUSTED history, and any other is refused.** The completing credit takes
 * `whole − Σ already credited` of the net and the gross, and derives its tax from the two, so every claim
 * counted against the line must be a share OF THIS LINE that a credit note OF THIS INVOICE wrote — and, for the
 * tax, hold total = amount + tax, since (total − Σ gross) − (amount − Σ net) is the remaining tax only while
 * Σ gross = Σ net + Σ tax. A counted `returns` claim is trusted when all three hold: its document's
 * `reverses_document_id` is the settled invoice; its line is the target of that one link and no other; and
 * that line's total is its amount plus its tax. Every credit this service writes meets all three — it names
 * the invoice on every note (as it has since 4A), writes one link per line it creates, and derives the tax —
 * and so does every untaxed credit it wrote before Phase 5 (tax 0, and gross = net because a posted policy-v1
 * invoice line carries total = amount: v1 debits the control account at `line.total_incl_tax` against
 * `line.amount`). `reverseDocument` writes no link, so no mirror is ever counted; a reversed note whose chain
 * reinstates its claim is counted as the note itself. A CLIENT path meets none of them reliably, and each
 * posted a wrong note before this rule (PR 11 review, rounds 2 and 3): a credit note drafted through the
 * generic `POST …/documents` — which can never set `reverses_document_id`, so its policy's `requires` means
 * it never posts — and linked `returns` through `POST …/links` holds a claim at figures the client chose (an
 * unpriced line priced by 3C's copy is −100 / 0 / 0, and the completing credit derived a tax of 133 from net
 * 300 − 100 against gross 333 − 0; two such drafts at +1 and −1 cancel in every sum, and a one-unit credit
 * took all three units' value; one linked without the copy is 0 / 0 / 0, consistent, and the credit that
 * completed the line took its unit at no value); and a client link from ANOTHER invoice line onto a derived
 * note's line, already priced and so left consistent, counted that line's figures against both. So the claims
 * that fail any condition are collected beside the sums, and an asked line holding one is refused with
 * ERR_VALIDATION_FAILED naming their documents — on every asked line, completing or not, because the history
 * is wrong whichever credit meets it. The per-line identity test subsumes round 2's test of the sums: the three
 * columns are `not null` (0019), so lines that each hold it sum to totals that hold it. Trusted histories are
 * unaffected. The rule lives here, where the figures are trusted, rather than in 0037's trigger, which would
 * have to restrict the shape of a `returns` target (a migration).
 *
 * Only QUANTITY-BEARING lines can be credited here: a `returns` link bounds a quantity, and a charge line
 * carries none, so nothing would stop it being credited twice. A charge line — named, or implied by an empty
 * `lines` — is refused naming the line; it is credited whole by reversing the invoice.
 *
 * The settled document must be POSTED, its pinned policy (§4.3.2 step 13 — never re-read, SAH-013) must move
 * no stock, and the target must be the type that policy's `reversal.producesType` names. The first refuses a
 * credit against nothing posted; the second refuses a partial negated DELIVERY_ORDER, which would be a
 * fourth writer of `document_line.cost` (a stock return is `reverseDocument` on the delivery, 4A's registered
 * path); the third refuses, say, a PURCHASE_CREDIT_NOTE against a SALES_INVOICE, which would post the
 * customer's credit to `2150`. The target is resolved from the policy's own declaration, exactly as
 * `reverseDocument` resolves it.
 *
 * `input.reason` is DISCHARGED here: there is no `reason` column on `app.document` (§4.3.4) and the only
 * writer of `document_event.reason` is 2B's `document_status_after`, which reads `app.event_reason` — a
 * TRANSACTION setting (2b:1336). So the reason is set on the caller's transaction and lands when that
 * transaction moves the draft to `issued`; a caller that issues in a later transaction gets none, and 2B's
 * `TransitionBody.reason` covers that path. `reverse.ts` places its own reason the same way.
 *
 * It writes `document`, `document_line` and (through 3C) `document_link` rows and UPDATEs no line — every
 * figure is written at INSERT onto the draft it creates, and `priceFromSource` is false — which is also what
 * 0113's `document_line_frozen_after_draft` admits: a line is written only while its document is a draft.
 * Over-crediting is refused by 3C's own trigger (`ERR_DOC_LINK_OVER_FULFILLED`, SAH-018: a projection, not a
 * counter).
 *
 * Raises ERR_NOT_FOUND (a settled document or target type not of `companyId`), ERR_DOC_STATUS_ILLEGAL (a
 * settled document that is not posted) and ERR_VALIDATION_FAILED (an empty reason; a stock document; a
 * policy that reverses into no type or into another; a line not on the settled document, asked twice, with a
 * non-positive quantity or with no quantity; a line holding a `returns` claim the history above does not
 * trust; nothing left to credit).
 */
export async function creditNoteFrom(
  tx: Sql,
  ctx: TenantContext,
  input: CreditNoteInput,
): Promise<CreditNoteResult> {
  if (input.reason.trim() === "") {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      "a credit note needs a reason: it is the only record of why the credit exists",
    );
  }

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
      paymentTermId: string | null;
      attributedTo: string | null;
      taxInclusive: boolean;
      baseCurrency: string;
      documentType: string | null;
      effect: string | null;
      reversalAllowed: boolean | null;
      producesType: string | null;
    }[]
  >`
    select d.company_id as "companyId", d.status::text as status, d.party_id as "partyId",
           d.currency::text as currency, d.exchange_rate::text as "exchangeRate",
           d.rate_source as "rateSource", d.branch_id as "branchId", d.warehouse_id as "warehouseId",
           d.payment_term_id as "paymentTermId", d.attributed_to as "attributedTo",
           d.tax_inclusive as "taxInclusive",
           c.base_currency::text as "baseCurrency",
           p.definition->>'documentType' as "documentType",
           p.definition->'inventory'->>'effect' as effect,
           (p.definition->'reversal'->>'allowed')::boolean as "reversalAllowed",
           p.definition->'reversal'->>'producesType' as "producesType"
      from app.document d
      join app.company c on c.id = d.company_id
      left join app.posting_policy p on p.id = d.posting_policy_id
     where d.id = ${input.settledDocumentId} and d.company_id = ${input.companyId}`;
  if (head === undefined) {
    throw codedError(
      "ERR_NOT_FOUND",
      `settled document ${input.settledDocumentId} is not a document of company ${input.companyId}`,
    );
  }
  if (head.status !== "posted") {
    throw codedError(
      "ERR_DOC_STATUS_ILLEGAL",
      `settled document ${input.settledDocumentId} is not posted (it is ${head.status}) — it has posted nothing to credit`,
    );
  }
  // Refused by policy SHAPE, from the PINNED policy. A posted document always pins one (§4.3.2 step 13).
  if (head.effect !== "none") {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `settled document ${input.settledDocumentId} is a stock document (${head.documentType}); its return is a reversal of the whole document, not a credit note`,
    );
  }
  if (head.reversalAllowed !== true || head.producesType === null) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `settled document ${input.settledDocumentId} is a ${head.documentType}, whose pinned policy reverses into no type — there is no credit note of it`,
    );
  }

  const [targetType] = await tx<{ id: string; code: string }[]>`
    select id, code from app.document_type
     where id = ${input.targetDocumentTypeId} and company_id = ${head.companyId}
       and archived_at is null`;
  if (targetType === undefined) {
    throw codedError(
      "ERR_NOT_FOUND",
      `document type ${input.targetDocumentTypeId} is not a live type of company ${head.companyId}`,
    );
  }
  if (targetType.code !== head.producesType) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `document type ${targetType.code} is not ${head.producesType}, the type the ${head.documentType}'s pinned policy reverses into`,
    );
  }

  // SAH-017's concurrency face, taken BEFORE the read — Task 6's rule and 3C's key and order, so the 0037
  // trigger's later lock on the same key is re-entrant and no two creditors can deadlock.
  const lockable = await tx<{ id: string }[]>`
    select id from app.document_line
     where document_id = ${input.settledDocumentId} and quantity is not null`;
  for (const id of lockable.map((l) => l.id).toSorted()) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`document_link:${id}`}, 0))`;
  }

  // The settled lines, their open quantity and everything already credited against each, in ONE statement.
  // A credit note's figures are stored negated and its cost positive, so the credited MAGNITUDES are the
  // negated sums and the cost sum as it stands. A credit note counts as done exactly when the view counts
  // its claim (0116): live, or reversed with its reversal chain reinstated (app.document_claim_stands) —
  // otherwise the note that completes the line took the pro-rata and left the residue behind. Beside the
  // sums, the documents of the claims the doc comment does not trust are collected — a target that does not
  // reverse this invoice, a target line some other link also reaches, a target line whose total is not its
  // amount plus its tax — so an untrusted history is refused and named below.
  const settled = await tx<SettledLine[]>`
    select dl.id, dl.line_no as "lineNo", dl.kind, dl.item_id as "itemId", dl.account_id as "accountId",
           dl.unit_id as "unitId", dl.warehouse_id as "warehouseId", dl.lot_id as "lotId",
           dl.description, dl.dimensions, dl.tax_code_id as "taxCodeId",
           dl.quantity::text as quantity, oq.open_quantity::text as "openQuantity",
           dl.unit_price::text as "unitPrice", dl.discount::text as discount,
           dl.amount::text as amount, dl.total_incl_tax::text as "totalInclTax", dl.cost::text as cost,
           coalesce(done.quantity, 0)::numeric(19,6)::text as "creditedQuantity",
           (-coalesce(done.discount, 0))::numeric(19,4)::text as "creditedDiscount",
           (-coalesce(done.amount, 0))::numeric(19,4)::text as "creditedAmount",
           (-coalesce(done.total, 0))::numeric(19,4)::text as "creditedTotal",
           coalesce(done.cost, 0)::numeric(19,4)::text as "creditedCost",
           done.untrusted as "untrustedCredits"
      from app.document_line dl
      left join app.document_open_quantity oq on oq.document_line_id = dl.id
      left join lateral (
             select sum(k.quantity) as quantity, sum(tl.discount) as discount, sum(tl.amount) as amount,
                    sum(tl.total_incl_tax) as total, sum(tl.cost) as cost,
                    array_agg(distinct t.id::text order by t.id::text)
                      filter (where t.reverses_document_id is distinct from dl.document_id
                                 or tl.total_incl_tax <> tl.amount + tl.tax_amount
                                 or exists (select 1 from app.document_link o
                                             where o.target_document_id = t.id
                                               and o.target_line_id = tl.id and o.id <> k.id)) as untrusted
               from app.document_link k
               join app.document_line tl on tl.id = k.target_line_id
               join app.document t on t.id = k.target_document_id
              where k.source_line_id = dl.id and k.link_kind = 'returns'
                and (t.status not in ('void', 'reversed')
                     or (t.status = 'reversed' and app.document_claim_stands(t.id)))
           ) done on true
     where dl.document_id = ${input.settledDocumentId}
     order by dl.line_no`;

  let asked: readonly CreditNoteLine[];
  if (input.lines.length === 0) {
    // "The whole invoice" — so a line this service cannot credit is refused, never silently left behind.
    const charge = settled.find(unbounded);
    if (charge !== undefined) refuseUnbounded(charge);
    asked = settled
      .filter((l) => l.openQuantity !== null && micro(l.openQuantity) > 0n)
      .map((l) => ({ settledLineId: l.id, quantity: l.openQuantity! }));
    if (asked.length === 0) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `settled document ${input.settledDocumentId} has nothing left to credit`,
      );
    }
  } else {
    asked = input.lines;
  }

  const cur = currency(head.currency);
  const base = currency(head.baseCurrency);
  const seen = new Set<string>();
  const planned = asked.map((ask) => {
    if (seen.has(ask.settledLineId)) {
      throw codedError("ERR_VALIDATION_FAILED", `line ${ask.settledLineId} is asked for twice`);
    }
    seen.add(ask.settledLineId);
    const src = settled.find((l) => l.id === ask.settledLineId);
    if (src === undefined) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `line ${ask.settledLineId} is not a line of the settled document ${input.settledDocumentId}`,
      );
    }
    if (src.quantity === null) return refuseUnbounded(src);
    const q = micro(ask.quantity);
    if (q <= 0n) {
      throw codedError("ERR_VALIDATION_FAILED", `line ${src.lineNo} quantity must be positive`);
    }
    const signed = micro(src.quantity);
    const whole = signed < 0n ? -signed : signed;
    if (whole === 0n) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `line ${src.lineNo} has a zero quantity and nothing to credit`,
      );
    }
    // The net and gross below take residues of what is already credited, and the tax is derived from them, so
    // every claim counted against the line must be one a credit note of this invoice wrote as a share of this
    // line alone, holding `total = amount + tax` (the doc comment). Every credit this service writes is; a
    // client's `returns` claim need not be. Refused, naming the claims' documents, rather than taken as a
    // residue — on every asked line, completing or not.
    if (src.untrustedCredits !== null) {
      const one = src.untrustedCredits.length === 1;
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `line ${src.lineNo} cannot be credited: returns ${one ? "target" : "targets"} ` +
          `${src.untrustedCredits.join(", ")} ${one ? "holds a claim" : "hold claims"} on it that no credit ` +
          "note of this invoice wrote as a share of this line alone with a total equal to its amount plus its " +
          "tax, so the line's remaining net, gross and tax cannot be derived as residues of what is already " +
          `credited; remove or correct ${one ? "that draft" : "those drafts"}, void ${one ? "it" : "them"} ` +
          `if issued, or reverse ${one ? "it" : "them"} if posted, before crediting this line`,
      );
    }

    // An exact `Rational` in micro-units and one named rounding mode, as in Task 6's conversion. Not a shared
    // function: the credit note negates and the conversion does not, and each owns its residue sums.
    const ratio: Rational = rational(q, whole);
    const completes = micro(src.creditedQuantity) + q === whole;
    const share = (full: Money, already: Money): Money =>
      completes ? full.subtract(already) : full.multiply(ratio, "HALF_AWAY_FROM_ZERO");
    const shareOf = (full: string, already: string): Money =>
      share(Money.of(full, cur), Money.of(already, cur));
    // Net and gross are pro-rated; the tax is DERIVED from them, never rounded on its own (the doc comment).
    const net = shareOf(src.amount, src.creditedAmount);
    const gross = shareOf(src.totalInclTax, src.creditedTotal);

    return {
      src,
      quantity: Quantity.of(ask.quantity).negate().toString(),
      linkQuantity: Quantity.of(ask.quantity).toString(),
      discount: shareOf(src.discount, src.creditedDiscount).negate().toString(),
      amount: net.negate().toString(),
      taxAmount: gross.subtract(net).negate().toString(),
      totalInclTax: gross.negate().toString(),
      // POSITIVE: §4.7.2 A6; ADR 0045 takes the sign from the negated quantity. Base currency (A4).
      cost:
        src.cost === null
          ? null
          : share(Money.of(src.cost, base), Money.of(src.creditedCost, base)).toString(),
    };
  });

  // Every refusal above is behind us, so the reason is set only for a note that will exist.
  await setEventContext(tx, { reason: input.reason });

  // The header mirrors the invoice — party, currency, the invoice's OWN rate and its provenance (SAH-012),
  // branch, warehouse, the pinned payment term and the attribution — and names it: `requires:
  // ["reverses_document"]` makes that reference mandatory at post (§4.3.2 step 4).
  const [note] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, status, series, effective_date, party_id, currency,
       exchange_rate, rate_source, branch_id, warehouse_id, payment_term_id, attributed_to,
       reverses_document_id, tax_inclusive)
    values (app.current_tenant(), ${head.companyId}, ${targetType.id}, 'draft', ${input.targetSeries},
            ${input.effectiveDate}::date, ${head.partyId}, ${head.currency}, ${head.exchangeRate},
            ${head.rateSource}, ${head.branchId}, ${head.warehouseId}, ${head.paymentTermId},
            ${head.attributedTo}, ${input.settledDocumentId}, ${head.taxInclusive})
    returning id`;
  const documentId = note!.id;

  const lineIds: string[] = [];
  const fulfilment: { sourceLineId: string; targetLineId: string; quantity: string }[] = [];
  for (const [i, line] of planned.entries()) {
    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, description, account_id, item_id, unit_id,
         warehouse_id, lot_id, quantity, unit_price, discount, amount, tax_code_id, tax_amount,
         total_incl_tax, cost, dimensions)
      values (app.current_tenant(), ${head.companyId}, ${documentId}, ${i + 1}, ${line.src.kind},
              ${line.src.description}, ${line.src.accountId}, ${line.src.itemId}, ${line.src.unitId},
              ${line.src.warehouseId}, ${line.src.lotId}, ${line.quantity}, ${line.src.unitPrice},
              ${line.discount}, ${line.amount}, ${line.src.taxCodeId}, ${line.taxAmount},
              ${line.totalInclTax}, ${line.cost}, ${JSON.stringify(line.src.dimensions)}::text::jsonb)
      returning id`;
    lineIds.push(row!.id);
    fulfilment.push({
      sourceLineId: line.src.id,
      targetLineId: row!.id,
      quantity: line.linkQuantity,
    });
  }

  // `returns` — 3C's registered kind. Its trigger binds each line to its document and both documents to this
  // company, and refuses a credit beyond the invoiced quantity with ERR_DOC_LINK_OVER_FULFILLED.
  const links = await linkFulfilment(tx, ctx, {
    sourceDocumentId: input.settledDocumentId,
    targetDocumentId: documentId,
    linkKind: "returns",
    lines: fulfilment,
    priceFromSource: false,
  });
  return { documentId, lineIds, linkIds: links.map((l) => l.id) };
}
