import { parsePolicy, PolicyEvaluationError, type PostingPolicy } from "@dulja/domain";
import type { Sql } from "postgres";
import type { JobClient } from "../jobs/enqueue";
import type { TenantContext } from "../with-tenant";
import { PostingError } from "./errors";
import { setEventContext } from "./lifecycle";
import { loadSnapshot } from "./load";
import { postDocument } from "./post";

/**
 * D13. Creates the reversing document of `policy.reversal.producesType` with the sides swapped, posts it
 * through the same postDocument, and marks the original `reversed`. The reversal ADDS ledger rows — it never
 * subtracts — which is what keeps account_balance a pure sum (contracts §4.3.3).
 */
export async function reverseDocument(
  tx: Sql,
  ctx: TenantContext,
  // `jobs` (amendment A15) is threaded into the reversal's own posting: a reversal dated before later
  // movements of the same items IS back-dated, so without it step 14's fail-closed guard fires on an
  // ordinary reversal. Optional for the same reason postDocument's is — every 1A/1B/2A/2B/2C/3A call site
  // reverses a document that plans no movement.
  input: { documentId: string; effectiveDate: string; reason: string; jobs?: JobClient },
): Promise<{ reversalDocumentId: string; number: bigint }> {
  const [source] = await tx<
    { id: string; status: string; document_type_id: string; effective_date: string }[]
  >`
    select id, status::text as status, document_type_id, to_char(effective_date, 'YYYY-MM-DD') as effective_date
      from app.document where id = ${input.documentId} for update`;
  if (!source) {
    throw new PostingError("ERR_NOT_FOUND", `no document ${input.documentId} in this tenant`);
  }
  if (source.status !== "posted") {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} is ${source.status}; only a posted document can be reversed (spec:2224)`,
    );
  }
  // Phase 4 review B3: a reversal dated BEFORE its original would cancel, in every as-of read between the two
  // dates, a document the ledger does not yet hold — 4B's ageing nets the pair from the reversal's date, so
  // its tie-out broke across that window. ISO dates compare as strings.
  if (input.effectiveDate < source.effective_date) {
    throw new PostingError(
      "ERR_VALIDATION_FAILED",
      `document ${input.documentId} cannot be reversed on ${input.effectiveDate}, before its own effective date ${source.effective_date}`,
    );
  }
  // Code review 2026-09-29 (B1's follow-up): the ageing counts a withdrawn allocation as live until its
  // `unallocated_on`, which moves to the first open day when the allocation's period had closed. A reversal
  // dated before that day nets this document while the allocation still pays it, so every as-of read in
  // between broke the tie-out. It is refused the same way as a date before the original.
  const [withdrawn] = await tx<{ on: string | null }[]>`
    select to_char(max(a.unallocated_on), 'YYYY-MM-DD') as on from app.allocation a
     where a.settled_document_id = ${input.documentId} or a.settlement_document_id = ${input.documentId}`;
  if (withdrawn?.on && input.effectiveDate < withdrawn.on) {
    throw new PostingError(
      "ERR_VALIDATION_FAILED",
      `document ${input.documentId} cannot be reversed on ${input.effectiveDate}: an allocation of it was withdrawn on ${withdrawn.on} and counts until then — reverse it on or after that date`,
    );
  }
  // Phase 4 review B2 and B5 — an FX_REVALUATION is reversed only as 4B's reverseRevaluation allows, and the
  // rule lives HERE, where every reversal path (the generic …/reverse route included) converges:
  //  - a REALISED difference is the ledger's correction of an allocation; it is undone by un-allocating
  //    (or reversing) its settlement, never on its own — reversed alone it restated the control account
  //    away from the ageing and the tie-out broke;
  //  - an UNREALISED one is not reversed while a LATER unrealised revaluation stands: that one was computed
  //    on this one's restatement still being outstanding, so taking this one away under it leaves the
  //    exposure restated by the later increment only. Reverse the later one first.
  const [fx] = await tx<{ is_fx: boolean; realised: boolean; later: number }[]>`
    select t.code = 'FX_REVALUATION' as is_fx,
           exists (select 1 from app.document_line l
                    where l.document_id = d.id and l.custom_fields->>'fxKind' = 'realised') as realised,
           (select count(*)::int from app.document o
              join app.document_type ot on ot.id = o.document_type_id
             where o.company_id = d.company_id and ot.code = 'FX_REVALUATION' and o.id <> d.id
               and o.reverses_document_id is null
               and o.status = 'posted' and o.effective_date > d.effective_date
               and exists (select 1 from app.document_line ol
                            where ol.document_id = o.id and ol.custom_fields->>'fxKind' = 'unrealised')) as later
      from app.document d
      join app.document_type t on t.id = d.document_type_id
     where d.id = ${input.documentId}`;
  if (fx?.is_fx === true && fx.realised) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} is a realised FX difference; it is undone by un-allocating or reversing its settlement, never on its own`,
    );
  }
  if (fx?.is_fx === true && fx.later > 0) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} cannot be reversed while a later unrealised revaluation (${fx.later}) that counted it as outstanding still stands; reverse the later one first`,
    );
  }
  // A full reversal mirrors EVERY line of the original, so it is refused once part of the original has
  // already been taken back — by a partial credit note (4A's creditNoteFrom, which points
  // reverses_document_id at it) or by a return drafted against it through a `returns` link (3C's
  // PURCHASE_RETURN). Mirroring the whole document on top of that would credit the party, or move the stock,
  // twice for the same units. A void partial document has released its claim; a REVERSED one has released it
  // only while its reversal chain NETS (code review C4, and code review 2 F1): its full reversal (depth 1)
  // cancels it, but the reversal of that reversal (depth 2) reinstates it while the partial document itself
  // still reads 'reversed'. So each partial document's chain is walked down by 0048's hop rule — through
  // 'reversed' members only, never through a `returns`-linked partial credit of a member — and the claim
  // stands while any member is live (not void, not reversed) at EVEN depth, which is 0048's "an ordinary live
  // document of its kind" (app.document_reversal_depth). A partial document at depth 0 that is draft, issued
  // or posted blocks, as before. The remedy is to credit or return the open remainder, or to void or reverse
  // the partial document (or the live end of its chain) first.
  const [partial] = await tx<{ n: number; allocated: number; pending: number; received: number }[]>`
    select (with recursive chain (id, status, depth) as (
              select d.id, d.status, 0 from app.document d
               where d.status <> 'void'
                 and (d.reverses_document_id = ${input.documentId}
                      or exists (select 1 from app.document_link l
                                  where l.source_document_id = ${input.documentId}
                                    and l.target_document_id = d.id and l.link_kind = 'returns'))
              union all
              select r.id, r.status, c.depth + 1
                from chain c
                join app.document r on r.reverses_document_id = c.id
               where c.status = 'reversed'
                 and not exists (select 1 from app.document_link l
                                  where l.source_document_id = c.id and l.target_document_id = r.id
                                    and l.link_kind = 'returns')
            )
            select count(*)::int from chain
             where chain.status not in ('void', 'reversed') and chain.depth % 2 = 0) as n,
           (select count(*)::int from app.allocation a
             where (a.settled_document_id = ${input.documentId} or a.settlement_document_id = ${input.documentId})
               and a.unallocated_at is null) as allocated,
           (select count(distinct l.target_document_id)::int from app.document_link l
              join app.document t on t.id = l.target_document_id
             where l.source_document_id = ${input.documentId} and l.link_kind = 'converts_to'
               and t.status not in ('posted', 'void', 'reversed')) as pending,
           (select count(distinct l.target_document_id)::int from app.document_link l
              join app.document t on t.id = l.target_document_id
             where l.source_document_id = ${input.documentId} and l.link_kind = 'receives_against'
               and t.status not in ('void', 'reversed')) as received`;
  if (partial!.n > 0) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} has already been partly credited or returned against; a full reversal would take those units back twice — credit or return the open remainder instead, or void or reverse the partial document first`,
    );
  }
  // 4A's conversions (A5): an invoice drafted from this document through `converts_to` and not yet posted will
  // relieve the corridor (`1250` / `2150`) by the cost it copied WHEN it posts — and the reversal below has
  // already emptied that corridor, so the invoice would post the same cost out a second time. A POSTED
  // conversion does not block: the corridor was relieved once, and reversing the delivery then crediting the
  // invoice is the designed full return. Only a void or reversed conversion has released its claim. No new
  // conversion can begin once the reversal commits: 0110's link trigger admits only an issued or posted
  // source, and `convertToInvoice` reads its source `for share`, which waits on this `for update`.
  if (partial!.pending > 0) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} has been converted into ${partial!.pending} document(s) not yet posted; post them, or void or discard them, before reversing it`,
    );
  }
  // 3D's transfers (review MON-03): a TRANSFER_RECEIPT drafted through `receives_against` has taken, or will
  // take when it posts, this dispatch's units out of the destination's in-transit warehouse. Every dispatch to
  // a branch shares that one corridor, so a mirror posted after the receipt would issue ANOTHER dispatch's
  // goods out of transit back to the sender — the sender's books gain stock it never got back, and the other
  // shipment's receipt is then short. A POSTED receipt blocks for good: its policy forbids reversal, so the
  // goods have arrived and a correction is a TRANSFER back or a STOCK_COUNT. A DRAFT or ISSUED receipt blocks
  // too, as an unposted `converts_to` target does above: posting it after the reversal would drain the
  // corridor the mirror already emptied. Only a void receipt (or a discarded draft, whose link goes with it)
  // has released its claim. No receipt can be
  // drafted once the reversal commits: `draftTransferReceipt` receives only a posted transfer and 0110's
  // link trigger admits only an issued or posted source.
  if (partial!.received > 0) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} has ${partial!.received} transfer receipt(s) drafted or posted against it; a received dispatch cannot be reversed — void or discard a receipt not yet posted, or send the goods back with a new transfer`,
    );
  }
  // 4A's allocations: a reversed invoice keeps nothing open, so a receipt still allocated to it would be
  // consumed against a document the ledger no longer holds. The allocations are unallocated first (with
  // their reason), which frees the settlement to be allocated elsewhere or refunded.
  if (partial!.allocated > 0) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} has ${partial!.allocated} live allocation(s); unallocate them before reversing it`,
    );
  }

  // LEGACY-013 is exactly "reversal reads CURRENT document-type flags instead of what was originally applied",
  // and `app.document.posting_policy_id` is the column spec:1753 pins so that it cannot happen ("PINNED at
  // post time; never re-read"). A posted document always has one — contracts §4.3.2 step 13 writes it — so
  // the reversal block is read from THAT row. Resolving by the original's effective_date was safe while a
  // version could arrive only through a seed PR; 2A's POST …/policies makes a back-dated `effective_from`
  // an ordinary API call, and a version effective on or before an already-posted document's effective_date
  // would otherwise change what that document's reversal produces, months later, with no write to the
  // document. The date-resolved policy is still what the REVERSAL's own posting uses — postDocument resolves
  // it for the reversal's own effective_date — which is why the two documents legitimately pin different
  // policies (contracts §4.3.1, amendment A8).
  const [pinned] = await tx<{ id: string; version: number; definition: unknown }[]>`
    select p.id, p.version, p.definition
      from app.posting_policy p
      join app.document d on d.posting_policy_id = p.id
     where d.id = ${input.documentId}`;
  if (!pinned) {
    throw new PostingError(
      "ERR_POLICY_NOT_FOUND",
      `document ${input.documentId} is posted but pins no posting policy, so what was originally applied is unknown; it cannot be reversed`,
    );
  }
  let definition: PostingPolicy;
  try {
    definition = parsePolicy(pinned.definition);
  } catch (error) {
    if (error instanceof PolicyEvaluationError) {
      throw new PostingError(
        "ERR_POLICY_INVALID",
        `pinned posting policy ${pinned.id} (version ${pinned.version}) is invalid: ${error.detail}`,
      );
    }
    throw error;
  }
  if (!definition.reversal.allowed || definition.reversal.producesType === null) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `policy for ${definition.documentType} does not allow reversal`,
    );
  }

  const [reversalType] = await tx<{ id: string }[]>`
    select t.id from app.document_type t
      join app.document d on d.company_id = t.company_id
     where d.id = ${input.documentId} and t.code = ${definition.reversal.producesType}`;
  if (!reversalType) {
    throw new PostingError(
      "ERR_POLICY_REQUIRES_MISSING",
      `document type ${definition.reversal.producesType} does not exist in this company, but the ${definition.documentType} policy reverses into it`,
    );
  }

  // 0116 §4: the flip below re-checks, under each source line's `document_link:<line>` advisory lock, every
  // fulfilment claim it reinstates (the reversal of a reversal). Those keys are taken HERE, before this
  // function's first audited write, so the order is the one every link writer keeps — the line's key, then
  // the audit chain's per-tenant key (0010): the link guard fires BEFORE the INSERT its audit row follows,
  // and linkFulfilment's callers (convertOrderToDelivery, draftTransferReceipt, convertToInvoice,
  // creditNoteFrom) lock their source lines before their first INSERT. Taken only in the flip trigger, they
  // were requested while the mirror's audit rows already held the tenant's key, and a link racing this
  // reversal deadlocked with it.
  //
  // Only the lines linked to a STRICT ancestor (code review 4, item 3). A flip to 'reversed' brings back an
  // ANCESTOR's claim — the flipped document's children join its ancestors' chains — and not this document's
  // own: a posted document's one reversal-chain child a service writes is the mirror just posted, at odd
  // depth, so its claim is released (a partial credit or return is `returns`-linked and off the chain). So an
  // ordinary (depth-0) reversal takes no key, as before code review 3. Taking this document's own lines made
  // reversing a delivery deadlock with a second delivery of the same order line being drafted, whose target
  // INSERT took the tenant's key before its link took the line's. A chain app_rw builds by hand under this
  // document is still checked by the flip trigger, only without this early lock. The lines are every quantity
  // link's source whose target is an ancestor the chain passes through (app.document_chain_ancestors, the
  // trigger's own walk, minus this document), sorted as linkFulfilment and the conversions sort them; the
  // trigger's later lock on the same key is re-entrant.
  const claimed = await tx<{ id: string }[]>`
    select distinct x.source_line_id::text as id
      from app.document_chain_ancestors(${input.documentId}) up (id)
      join app.document_link x on x.target_document_id = up.id and x.quantity is not null
     where up.id <> ${input.documentId}`;
  for (const id of claimed.map((l) => l.id).toSorted()) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`document_link:${id}`}, 0))`;
  }

  const snapshot = await loadSnapshot(tx, input.documentId);
  // 4A's `payment_term_id` is COPIED too (Phase 4 review B4): the term is pinned on the document (LEGACY-013)
  // and a reversal that is itself an open item — the re-deposit of a reversed receipt — ages from it.
  // 3A's header `warehouse_id` / `to_warehouse_id` are references and are COPIED, like `branch_id` and
  // `party_id`: a policy that `requires: ["warehouse"]` (GOODS_RECEIPT, SHIPMENT, DELIVERY_ORDER, …) validates
  // the header, so a reversal drafted without them failed ERR_POLICY_REQUIRES_MISSING and was unpostable.
  // A POS ticket reversed into a POS ticket keeps its till identity: a fresh client_ref, the source's terminal
  // and its shift.
  const posMirror = definition.reversal.producesType === "POS_TICKET";
  const [created] = await tx<{ id: string }[]>`
    insert into app.document (tenant_id, company_id, document_type_id, series, effective_date, currency,
                              exchange_rate, rate_source, branch_id, party_id, attributed_to, reverses_document_id,
                              warehouse_id, to_warehouse_id, payment_term_id, tax_inclusive, client_ref, terminal_id, shift_id)
    select ${ctx.tenantId}, d.company_id, ${reversalType.id}, d.series, ${input.effectiveDate}::date, d.currency,
           d.exchange_rate, d.rate_source, d.branch_id, d.party_id, d.attributed_to, d.id,
           d.warehouse_id, d.to_warehouse_id, d.payment_term_id, d.tax_inclusive,
           case when dt.code = 'POS_TICKET' and ${posMirror}::boolean then uuidv7() else null end,
           case when dt.code = 'POS_TICKET' and ${posMirror}::boolean then d.terminal_id else null end,
           case when dt.code = 'POS_TICKET' and ${posMirror}::boolean then d.shift_id else null end
      from app.document d join app.document_type dt on dt.id=d.document_type_id where d.id = ${input.documentId}
    returning id`;
  const reversalId = created!.id;

  // The mirror. `debit` and `credit` SWAP; the signed magnitudes NEGATE, so the same policy rules produce the
  // mirrored ledger lines with no second rule set (D13) — through evaluatePolicy's sign normalisation
  // (amendment A9), which turns a negative resolved amount into the opposite side at its absolute value.
  // `kind`, `item_id`, `unit_price`, `tax_code_id`, `dimensions` and `custom_fields`
  // carry over unchanged — a reversal that dropped them would stop mirroring what was originally applied,
  // which is LEGACY-013 by another route. `-l.quantity` on a NULL quantity is NULL, which an account line needs.
  // 3A / 0032: `warehouse_id`, `lot_id` and `unit_id` are references and are COPIED; `unit_quantity` is a
  // signed magnitude and is NEGATED, exactly like `quantity`, `discount` and `amount` (§4.4.2's
  // sign-normalisation section). The 0032 trigger then re-derives `quantity` from the negated pair and,
  // because Postgres numeric `round()` is symmetric across sign, it equals `-l.quantity` and the trigger's
  // agreement branch passes. A reversal that copied `unit_quantity` unnegated would be REFUSED, which is
  // the guard doing its job rather than a bug in it.
  // 3C / §4.7.2 branch 1: `cost` is COPIED UNNEGATED. It is a magnitude, exactly as `PlannedMovement.value`
  // is (§4.4.2's sign-normalisation section) — direction is carried by the movement's `effect`, which the
  // negated quantity has already flipped. Without this column a reversal of a stock ISSUE (which emits a
  // RECEIPT of the returned goods) would fall through to branch 3 and value that receipt at the negated SALE
  // price instead of its carrying cost. `applyMovements` section 6 then writes the same number back over
  // it, which makes the copy idempotent (3D renumbered that section when the fill rules landed beside it).
  await tx`
    insert into app.document_line (tenant_id, company_id, document_id, line_no, description, account_id,
                                   debit, credit, dimensions, custom_fields,
                                   kind, item_id, quantity, unit_price, discount, amount, cost,
                                   warehouse_id, lot_id, unit_id, unit_quantity,
                                   tax_code_id, tax_amount, total_incl_tax)
    select ${ctx.tenantId}, l.company_id, ${reversalId}, l.line_no,
           ${`Reversal of ${snapshot.header.series} ${snapshot.header.number ?? ""}: ${input.reason}`}, l.account_id,
           l.credit, l.debit, l.dimensions, l.custom_fields,
           l.kind, l.item_id, -l.quantity, l.unit_price, -l.discount, -l.amount, l.cost,
           l.warehouse_id, l.lot_id, l.unit_id, -l.unit_quantity,
           l.tax_code_id, -l.tax_amount, -l.total_incl_tax
      from app.document_line l where l.document_id = ${input.documentId}`;

  const posted = await postDocument(tx, ctx, {
    documentId: reversalId,
    ...(input.jobs === undefined ? {} : { jobs: input.jobs }),
  });

  // The AFTER UPDATE OF status trigger writes the `reversed` event; the reason it carries is the operator's,
  // routed through the transaction setting of contracts §4.5.2 rather than a null (2B).
  await setEventContext(tx, {
    reason: `Reversed by ${definition.reversal.producesType} ${posted.number}: ${input.reason}`,
  });
  await tx`update app.document set status = 'reversed' where id = ${input.documentId}`;

  return { reversalDocumentId: reversalId, number: posted.number };
}

/**
 * spec:1745 — "Voiding an issued document sets status = 'void' AND inserts document_number_void in the same
 * transaction". The number is never re-issued; the row is what turns a gap in the series into an explained
 * gap (LEGACY-051). `voided_by` is stamped from the session by app.stamp_actor.
 */
export async function voidDocument(
  tx: Sql,
  ctx: TenantContext,
  input: { documentId: string; reason: string },
): Promise<void> {
  const [doc] = await tx<
    {
      id: string;
      status: string;
      company_id: string;
      series: string;
      fiscal_period_id: string | null;
      number: string | null;
    }[]
  >`select id, status::text as status, company_id, series, fiscal_period_id, number::text as number
      from app.document where id = ${input.documentId} for update`;
  if (!doc) {
    throw new PostingError("ERR_NOT_FOUND", `no document ${input.documentId} in this tenant`);
  }
  if (doc.status !== "issued" || doc.number === null || doc.fiscal_period_id === null) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} is ${doc.status}; only an issued document holds a number that can be voided (contracts §4.5.1)`,
    );
  }

  // spec:1745 — the void event carries the void reason (2B; the AFTER trigger reads the setting).
  await setEventContext(tx, { reason: input.reason });
  await tx`update app.document set status = 'void' where id = ${input.documentId}`;
  await tx`insert into app.document_number_void (tenant_id, company_id, series, fiscal_period_id, number, reason)
           values (${ctx.tenantId}, ${doc.company_id}, ${doc.series}, ${doc.fiscal_period_id}, ${doc.number}::bigint, ${input.reason})`;
}
