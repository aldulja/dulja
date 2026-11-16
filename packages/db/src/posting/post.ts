import {
  balanceInBase,
  Money,
  evaluatePolicy,
  lineMeetsARule,
  lineMeetsAVarianceRule,
  PolicyEvaluationError,
  quantitySignChosen,
  validateRequires,
  type DocumentSnapshot,
  type PlannedLedgerLine,
  type PostingPlan,
  type PostingPolicy,
} from "@dulja/domain";
import type { Sql } from "postgres";
// The file paths, never the `@dulja/db` barrel: `packages/db/src/index.ts` re-exports `./posting`, so the
// barrel would close an import cycle through this module.
import { settlementControlViolation } from "../ar-ap/policy-shape";
import { transferLegOf, transferWarehouseKind } from "../inventory/transfer-shape";
import { applyMovements } from "../costing/apply-movements";
import { invalidateFrom } from "../costing/invalidate";
import { allocatedByCostLine } from "../costing/landed-cost";
import { mergeStockOnHand } from "../costing/stock-on-hand";
import type { JobClient } from "../jobs/enqueue";
import type { TenantContext } from "../with-tenant";
import { recordPending } from "../einvoice/transmission";
import { insertTaxTransactions } from "./tax";
import { PostingError } from "./errors";
import { issueDocument } from "./issue";
import { loadSnapshot, resolvePolicy } from "./load";
import { mergeEmployeeYtd } from "./ytd";

export interface PostResult {
  documentId: string;
  number: bigint;
  series: string;
  fiscalPeriodId: string;
  postingPolicyId: string;
  postingSeq: bigint;
  ledgerEntryIds: string[];
  movementIds: string[];
  taxTransactionIds: string[];
  enqueuedJobIds: string[];
  warnings: string[];
}

const POSTABLE_FROM = new Set(["draft", "submitted", "approved", "issued"]);

/** contracts §4.3.2, at the Phase 1 subset. Takes the caller's `tx` and opens none of its own, so the
 *  handler's work and this posting commit or roll back together. */
export async function postDocument(
  tx: Sql,
  ctx: TenantContext,
  input: { documentId: string; jobs?: JobClient },
): Promise<PostResult> {
  // 1. one poster per document.
  const [locked] = await tx<
    { id: string; status: string; document_type_id: string; effective_date: string }[]
  >`
    select id, status::text as status, document_type_id, to_char(effective_date, 'YYYY-MM-DD') as effective_date
      from app.document where id = ${input.documentId} for update`;
  if (!locked) {
    throw new PostingError("ERR_NOT_FOUND", `no document ${input.documentId} in this tenant`);
  }

  // 2. status.
  if (!POSTABLE_FROM.has(locked.status)) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} is ${locked.status} and cannot be posted`,
    );
  }

  // 3. snapshot.
  let snapshot = await loadSnapshot(tx, input.documentId);
  if (snapshot.lines.length === 0) {
    throw new PostingError("ERR_DOC_NO_LINES", `document ${input.documentId} has no lines`);
  }

  // 4. policy and its required inputs.
  const { policyId, definition } = await resolvePolicy(
    tx,
    locked.document_type_id,
    locked.effective_date,
  );
  const { missing } = validateRequires(definition, snapshot);
  if (missing.length > 0) {
    throw new PostingError(
      "ERR_POLICY_REQUIRES_MISSING",
      `document ${input.documentId} is missing ${missing.join(", ")}, required by policy ${policyId}`,
    );
  }

  // 5. fiscal period — the pre-check; app.assert_period_open on ledger_entry remains the control (spec:1862).
  //    `for share` closes the window between this read and commit: a concurrent
  //    POST …/fiscal-periods/{id}/close takes a row lock on the period and so waits for this posting to
  //    finish, rather than committing 'closed' underneath rows the trigger already admitted (test 9 under
  //    concurrency). Two posters share the lock freely; only a status change queues.
  const [period] = await tx<{ id: string; status: string }[]>`
    select id, status::text as status from app.fiscal_period
     where company_id = ${snapshot.header.companyId}
       and ${locked.effective_date}::date between starts_on and ends_on
     for share`;
  if (!period) {
    throw new PostingError(
      "ERR_PERIOD_NOT_FOUND",
      `no fiscal period of company ${snapshot.header.companyId} contains ${locked.effective_date}`,
    );
  }
  if (period.status !== "open") {
    throw new PostingError("ERR_PERIOD_NOT_OPEN", `fiscal period ${period.id} is ${period.status}`);
  }

  // 6. evaluate, convert to base, absorb the rounding residue. `let`, not `const`: step 9's applyMovements
  //    returns the plan with `value` filled on every movement (contracts §4.7.2) and step 12 reads it back.
  let plan = planFor(definition, snapshot, input.documentId);

  // 6b. Every account the plan will post to must be a live, postable account of THIS company — now, at post
  //     time, not only when the line was written. The API refuses a group, an archived or a sibling company's
  //     account when a LINE is created, but an account may be archived between draft and post, and a line
  //     written by any other path (the schema's FKs are tenant-composite only) reaches here unchecked.
  //     `refs.accountsByCode` is exactly the company's active leaves, loaded a moment ago.
  const postable = new Set(Object.values(snapshot.refs.accountsByCode));
  for (const line of plan.ledgerLines) {
    if (!postable.has(line.accountId)) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `planned line ${line.lineNo} of document ${input.documentId} names account ${line.accountId}, which is not a live, postable account of company ${snapshot.header.companyId}`,
      );
    }
  }

  // 6c. A settlement must relieve the account its party's open items live on (code review 2, M5-X / F7). The
  //     refund refusal lived only in `draftSettlement`, so the generic POST …/documents → transitions path
  //     posted a RECEIPT from a vendor onto 1200 and a PAYMENT to a customer onto 2100 — accounts that party's
  //     ageing, allocation and tie-out never read, which broke the Phase 4 tie-out (spec:2290). Asked here,
  //     through the one helper `draftSettlement` also asks, because every ledger write goes through here
  //     (spec:2173). Before step 7, so a refused post consumes no number. A reversal mirror is not asked: its
  //     original passed this check to post, and 0045's `party_control_account_pinned` has frozen the party's
  //     accounts since, so the only mirror this could refuse is one of a document posted before the check.
  if (snapshot.header.reversesDocumentId === null) {
    const violation = await settlementControlViolation(tx, definition, snapshot.header.partyId);
    if (violation !== null) {
      throw new PostingError("ERR_VALIDATION_FAILED", `document ${input.documentId}: ${violation}`);
    }
  }

  // 6d. A negative-quantity line on a stock-moving policy is a RETURN, and a return is `reverseDocument` of
  //     the original — the one registered path (contracts §4.7.2; 3d's "a cancelled delivery is a
  //     reversal"), which sets `reverses_document_id`, negates every signed magnitude and copies the cost, so
  //     ADR 0045's signed cost flips each rule's side with the movement. Hand-drafted, the line has no cost
  //     at step 6 and a non-negative `amount` (DocumentLineInput's `Amount`), so A5's stand-in and §4.7.2's
  //     fill keep the policy's FORWARD side while `orientLeg` flips the movement: a DELIVERY_ORDER at -2
  //     posted 1250 Dr / 1300 Cr beside a +2 receipt valued at the sale price, at amount 0 it posted no ledger
  //     at all, and a GOODS_RECEIPT at -2 posted 1300 Dr / 2150 Cr beside a -2 issue (code review 2, M1-X).
  //     A policy that selects on `line.quantity_sign` for every rule the line meets — STOCK_COUNT — chose its
  //     direction from the sign and is admitted. A line that meets NO rule is refused too: `planMovements`
  //     moves a line by its `item_id`, not its kind, so a negative `account` line carrying an item still
  //     flipped its movement with no ledger behind it (the verification of M1-X). Before step 7, so a refused
  //     post consumes no number.
  //
  //     `transfer` is asked too (code review 3, R3). TRANSFER's rules (Dr 1310 / Cr item.inventory_account at
  //     line.cost, on `line.kind: item`) do not select on the sign, and `orientLeg` flips BOTH legs of a
  //     negative line, so a dispatch drafted at -2 through PUT …/lines put 2 back into the source and took 2
  //     out of transit while the ledger still debited 1310 and credited 1300. The one transfer line whose
  //     quantity is legitimately negative is a COUNTED one — a TRANSFER_RECEIPT short arrival, whose
  //     `quantity` is the variance `counted − expected` and whose two legs `transferQuantities` takes from
  //     the two count columns, never from `quantity` — so 6d admits a line carrying both count columns. That
  //     admission treats the line's `quantity` as its variance, and it is sound only because 6d first
  //     REFUSES, on every effect, a line carrying both count columns whose `quantity` is not exactly
  //     `counted_quantity − expected_quantity` (code review 4, item 1). Nothing else ties the three: no
  //     constraint does (0040 states the meaning in a comment), 6e and 6f ask the legs and the warehouses, not
  //     the sign, and only the two service writers — `draftTransferReceipt` and `recordCounts` — set all
  //     three in one statement. The legs move the count columns while TRANSFER_RECEIPT's variance rules
  //     select on `line.quantity_sign`, so a line whose sign lied — -2 counted 12 of 10, or +2 counted 8 of 10
  //     — met a variance rule of the wrong sign, passed 6e and 6f, and posted the variance to the wrong side
  //     of 1310 (20.0000 each). Beyond that equality: 6e refuses a counted line whose legs differ unless the
  //     policy posts the difference; 6f refuses a leg at the wrong kind of warehouse, which is what a counted
  //     line under TRANSFER's dispatch rules — out of transit and into the branch — always has, whatever its
  //     variance; and `draftTransferReceipt` drafts only under a receipt-shaped policy (the early refusal).
  //     Such a "receipt" had posted Dr 1310 / Cr 1300 beside a movement out of transit into the branch.
  refuseMisstatedVariance(snapshot, input.documentId);
  refuseUnchosenReturn(definition, snapshot, input.documentId);

  // 6e. Stock moves only on a line the policy accounts for (code review 3, R4). `planMovements` moves a line
  //     by its `item_id` — whatever its kind and whatever rule it meets — while every stock rule in the tree
  //     selects the line by kind, and DocumentLineInput accepts `itemId`, `warehouseId` and `quantity` on any
  //     kind. So a POSITIVE `account` line carrying an item on a DELIVERY_ORDER moved its stock out at cost
  //     with no 1300 leg, and 6d, which asks negative lines only, never saw it. Two refusals, asked of every
  //     line step 6 planned a movement for: the line must be an `item` line — a landed-cost or charge line
  //     names an account, never an item, and GOODS_RECEIPT's `line.kind: account` rule is the landed-cost
  //     pair, not a stock rule, so "meets a rule" alone would have let a freight line receive units — and it
  //     must meet at least one `each_line` rule, or its movement posts with no ledger leg at all (a zero-code
  //     stock policy whose rules never meet its item lines). Only lines that MOVE are asked: a stock-count
  //     line whose sheet matched meets no rule and plans nothing, and stays admitted. A reversal mirror is not
  //     asked: its original passed this check to post, and one posted before the check moved stock that its
  //     mirror must still be able to move back. Before step 7, as 6d.
  //
  //     A third refusal, for a COUNTED `transfer` line whose two legs differ — a short or over arrival
  //     (the verification of R3). Its legs move two values, expected out and counted in, and §4.7.2's fill
  //     posts the difference only through a `line.variance_value` rule; under rules naming `line.cost` alone
  //     it posts one value against both legs. A receipt-shaped policy with no variance pair therefore put a
  //     10-out / 8-in arrival on 1300 at the ten's value, and a TRANSFER-typed "receipt" posted it the wrong
  //     way round as well. An exact arrival — both legs one value — is not asked.
  refuseUnaccountedMovement(definition, snapshot, plan, input.documentId);

  // 6f. A transfer's stock stands where its policy's ledger says it does (the verification of R3, second
  //     half). `transferLegOf` reads the leg off the policy's shape — a DISPATCH credits item.inventory_account,
  //     a RECEIPT debits it — and item.inventory_account is the STOCK warehouse's account while the corridor
  //     is the policy's other side (1310). So a dispatch issues from a `stock` warehouse into an `in_transit`
  //     one and a receipt the other way round, or each account moves against its own stock. The services draft
  //     only that shape (draftTransfer resolves the corridor and now asks the source's kind; draftTransferReceipt
  //     reads the dispatch), but PUT …/lines writes a line's warehouse bound to the company and nothing else: a
  //     TRANSFER_RECEIPT whose line was moved to WH-HQ posted WH-HQ → WH-BR2 beside Dr 1300 / Cr 1310, and a
  //     dispatch out of a corridor posted Dr 1310 / Cr 1300 with no stock warehouse's value moving. A policy of
  //     neither shape is not asked (a zero-code transfer this rule cannot place), nor is a reversal mirror (its
  //     legs are its original's, flipped), nor a negative line 6d admitted because the policy chose its sign.
  //     Before step 7, as 6d.
  await refuseMisdirectedTransfer(tx, definition, snapshot, plan, input.documentId);

  // 6g. Under approval, a line whose rules chose its direction from the sign of its variance — every rule it
  //     meets selects on `line.quantity_sign`, as STOCK_COUNT's do — is a COUNT line, and it must carry both
  //     count columns (code review 3, R2). Only a line carrying both is valued by applyMovements at the layer
  //     average (§4.7.2 branch 2b, 3D amendment A8) whatever `cost` or `amount` stands on it. At draft the
  //     maker owns every column, the count columns included: one UPDATE that cleared either of them and wrote
  //     `cost` (or `amount`) made the line an uncounted receipt, priced by branch 1 (or 3) from the maker's
  //     figure and dropped from readCountSheet, the sheet the checker approves — 1300 Dr 5000.0000 / 5110 Cr
  //     5000.0000 for a 2-unit surplus whose layer average is 6.0000. Asked only of a document that is
  //     `approved` or `issued`, the two states a checker's post of an approval-required document starts from:
  //     a draft or submitted one — reverseDocument's mirror of such a type among them — is refused by step 7's
  //     §4.5.1 transition (draft → issued needs approval.required = false) with ERR_DOC_STATUS_ILLEGAL, as it
  //     always was. Only a line that moves stock is asked: one the sheet matched or never counted plans no
  //     movement. Before step 7, so a refused post consumes no number.
  refuseUncountedVariance(definition, snapshot, plan, locked.status, input.documentId);

  // 6h. A landed-cost line the policy capitalises into inventory must be wholly allocated onto the goods it
  //     landed (INV-03; ADR 0041's 2026-11-15 amendment). GOODS_RECEIPT and SHIPMENT debit 1300 by every
  //     `account` line's amount, while `applyMovements` puts into the layers only `line.amount + Σ allocated`
  //     (§4.7.2 branch 3). A freight line nobody allocated — or whose allocation `PUT …/lines` cascaded away
  //     with the old lines, or whose amount was edited after it was allocated — posted 1300 at goods + freight
  //     beside layers at goods alone, so the valuation tie-out (test 7's TIE-OUT A) broke for good. Asked of a
  //     receipt that creates layers, and only of an account line whose planned debit lands on an inventory
  //     account (an item's own, or the 1300/1310 pair the tie-out sums); a policy that expenses the line is not
  //     asked. A reversal mirror is not asked: its movements carry the original's cost. Before step 7, so a
  //     refused post consumes no number.
  await refuseUnallocatedLandedCost(tx, definition, snapshot, plan, input.documentId);

  // 7. issue if not issued.
  let series = snapshot.header.series;
  let number = snapshot.header.number;
  if (locked.status !== "issued") {
    const issued = await issueDocument(tx, ctx, { documentId: input.documentId });
    series = issued.series;
    number = issued.number;
    snapshot = await loadSnapshot(tx, input.documentId);
  }
  if (number === null) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} is issued with no number`,
    );
  }

  // 8. posting_seq, BEFORE any row that carries it is written (contracts §4.3.5).
  const [seqRow] = await tx<{ posting_seq: string }[]>`
    update app.document set posting_seq = coalesce(posting_seq, nextval('app.posting_seq'))
     where id = ${input.documentId}
     returning posting_seq::text as posting_seq`;
  const postingSeq = BigInt(seqRow!.posting_seq);

  // 9. the movement hook (contracts §4.3.2 step 9, §4.7.2). It inserts inventory_movement, then the cost
  //    layers and consumptions, fills `value` on the plan's movements and writes document_line.cost. It is
  //    called for EVERY plan, as step 9 states it (4A): its first act is §4.7.2's unfilled-cost refusal,
  //    which is pure, and it returns before any read when the plan carries no movement — so JOURNAL and
  //    every policy whose inventory.effect is "none" stay on a read-free path.
  //
  //    3D (§4.7.2): `applyMovements` hands the plan back with `value` filled on every movement AND with
  //    every ledger line the evaluator tagged `fill` (amendment A5, ADR 0042) filled from those values, the
  //    legitimately zero ones dropped as step 6 would have dropped them. Re-reading `document_line.cost`
  //    and re-evaluating — which is what this step did before 3D — cannot serve: `line.cost` and
  //    `line.variance_value` resolve from that ONE column (evaluate.ts's `lineAmount`), so a two-quantity
  //    variance line would take the matched value on all four of its legs, and a TRANSFER_RECEIPT where
  //    nothing arrived would resolve every leg to zero and post no entry at all while its issue leg emptied
  //    the corridor. The step-6 plan is otherwise identical to a re-evaluation: nothing between them
  //    changes a line's `amount`, its account or its dimensions, and `balanceInBase` already ran over it —
  //    §4.3.4's cost-leg pairing is what makes that safe, because a cost leg is never alone on a document
  //    and filling a debit and its credit with one magnitude cannot move the residue.
  const planMoves = plan.movements.length > 0;
  plan = await applyMovements(tx, ctx, plan, snapshot);
  if (planMoves) {
    // 9a. Re-balance the FILLED plan. The comment above argues the fill cannot move the residue, and for a
    //     policy that observes §4.3.4's cost-leg pairing that is true — a debit and its credit filled with
    //     one magnitude net to zero in base. But the pairing rule is a CONVENTION the schema does not
    //     enforce: nothing refuses a policy that tags two paired legs with different `fill` sources, and
    //     before 3D the re-evaluation at this point ran balanceInBase again and would have caught it. With
    //     the re-evaluation gone (it cannot serve — see above), this is what replaces that check.
    //     Σdebit = Σcredit is Phase 1's definition of done; it is not left resting on a convention.
    //     For a well-formed policy the residue is unchanged and this re-derives the same fx_rounding line
    //     (balanceInBase takes step 6's off first — code review, C2); for an ill-formed one it raises
    //     ERR_LEDGER_UNBALANCED here instead of writing an unbalanced ledger, translated exactly as step 6's
    //     is, so the caller sees a PostingError naming the document either way.
    const filled = plan;
    plan = asPostingError(input.documentId, () =>
      balanceInBase(filled, snapshot.company.fxRoundingAccountId, snapshot.company.baseCurrency),
    );
  }
  // 9b. 2A's fail-closed guard, MOVED rather than deleted. Contracts §4.3.2 says "3B replaces this guard
  //     with the applyMovements call", and step 9 above is that call — but deleting the guard outright
  //     opens two paths that used to be refused: a policy addressing `line.cost` on a line that plans NO
  //     movement (inventory.effect "none", or a service line) would post a zero-amount COGS pair, and a
  //     movement whose cost the engine somehow left unfilled would do the same. Both are "a zero-value COGS
  //     or inventory row that makes the trial balance quietly wrong", which is the sentence this guard was
  //     written for. Since 4A the first path is refused earlier, inside applyMovements, naming the document
  //     line (§4.7.2's unfilled-cost refusal); this guard stays as the backstop for the second.
  //
  //     Running it AFTER step 9 is safe and does not refuse a free-of-charge line, whose cost is a
  //     legitimate zero (spec:1055, costing "zero"): the re-evaluation above resolves that cost to
  //     Money.zero with `unresolvedCost: false`, and evaluatePolicy's zero-drop
  //     (packages/domain/src/posting/evaluate.ts:540) removes the line before it reaches ledgerLines.
  //     A zero-amount ledger line that SURVIVES re-evaluation therefore means the cost is still null.
  const unfilled = plan.ledgerLines.find((line) => line.amount.isZero());
  if (unfilled) {
    throw new PostingError(
      "ERR_POLICY_REQUIRES_MISSING",
      `planned line ${unfilled.lineNo} of document ${input.documentId} has a zero amount after step 9: its policy addresses line.cost or line.variance_value and the costing engine filled no cost for it`,
    );
  }
  // `PlannedMovement` has no `id` member (§4.4.2 is frozen) and `PostResult.movementIds` needs them in
  // movement_no order, so they are read back rather than threaded through the plan.
  const movementIds =
    plan.movements.length === 0
      ? []
      : (
          await tx<{ id: string }[]>`
            select id from app.inventory_movement
             where document_id = ${input.documentId} order by movement_no`
        ).map((r) => r.id);

  // 10. the ledger and its dimensions.
  const ledgerEntryIds = await insertLedger(tx, ctx, snapshot, plan, {
    policyId,
    periodId: period.id,
    effectiveDate: locked.effective_date,
  });

  // 11. Persist signed tax facts alongside the ledger.
  const taxTransactionIds = await insertTaxTransactions(tx, {
    plan,
    snapshot,
    postingSeq,
    fiscalPeriodId: period.id,
  });

  // 12. the projection. 3A adds stock_on_hand here and 8C adds employee_ytd for PAYROLL documents (D14 —
  //     same transaction, never a job).
  //
  //     FIRST, serialise on the balance keys this document touches. `MERGE … WHEN NOT MATCHED THEN INSERT`
  //     is NOT `INSERT … ON CONFLICT`: it does not re-check the target on a concurrent insert, so two
  //     transactions that both find no account_balance row for the same
  //     (company_id, account_id, fiscal_period_id, currency) both take the NOT MATCHED branch and the second
  //     raises SQLSTATE 23505 when the first commits. The production withTenant retries 40001 and 40P01 only
  //     (§4.2.2), so that surfaces to the caller as ERR_CONFLICT_UNIQUE on a legitimate post. The path is
  //     reachable in this slice: a caller may issue in one request and post in another, and postDocument then
  //     skips issueDocument at step 7 — so the series advisory lock that serialises the draft→post path is
  //     not held here. The locks are taken in SORTED key order: two posts whose account sets overlap then
  //     queue in the same order instead of deadlocking. They are transaction-scoped and released at commit.
  //     (Contract amendment A4 registers this beside the §4.3.3 MERGE, so 3A's stock_on_hand and 8C's
  //     employee_ytd copy it rather than re-discover it.)
  const balanceKeys = [
    ...new Set(
      plan.ledgerLines.map((line) => `${line.accountId}/${period.id}/${line.amount.currency}`),
    ),
  ].toSorted();
  for (const key of balanceKeys) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`balance:${snapshot.header.companyId}/${key}`}, 0))`;
  }

  await tx`
    merge into app.account_balance b
    using (select ${ctx.tenantId}::uuid as tenant_id, ${snapshot.header.companyId}::uuid as company_id,
                  l.account_id, l.fiscal_period_id, l.currency,
                  sum(l.debit) as debit, sum(l.credit) as credit,
                  sum(l.base_debit) as base_debit, sum(l.base_credit) as base_credit
             from app.ledger_entry l where l.document_id = ${input.documentId}::uuid
            group by l.account_id, l.fiscal_period_id, l.currency) s
       on b.company_id = s.company_id and b.account_id = s.account_id
      and b.fiscal_period_id = s.fiscal_period_id and b.currency = s.currency
     when matched then update set debit = b.debit + s.debit, credit = b.credit + s.credit,
                                  base_debit = b.base_debit + s.base_debit, base_credit = b.base_credit + s.base_credit,
                                  updated_at = now()
     when not matched then insert (tenant_id, company_id, account_id, fiscal_period_id, currency, debit, credit, base_debit, base_credit)
                           values (s.tenant_id, s.company_id, s.account_id, s.fiscal_period_id, s.currency,
                                   s.debit, s.credit, s.base_debit, s.base_credit)`;

  //     …and the stock half (contracts §4.7.3), same transaction (D14). 3A's addition; the advisory-lock
  //     reasoning of amendment A4 lives in `lockStockKeys`, which mergeStockOnHand calls and which step 9's
  //     applyMovements already called for the same keys — re-locking a held key is a no-op.
  //
  //     Every movement step 9 returned carries a resolved lot: the branch that could not resolve one threw
  //     rather than passing a null through. The filter is the type-level echo of that, not a second policy —
  //     a movement with no lot could not have been inserted, because inventory_movement.lot_id is NOT NULL.
  const stockKeys = plan.movements.flatMap((mv) =>
    mv.lotId === null ? [] : [{ itemId: mv.itemId, warehouseId: mv.warehouseId, lotId: mv.lotId }],
  );
  if (stockKeys.length > 0) {
    await mergeStockOnHand(tx, {
      tenantId: ctx.tenantId,
      companyId: snapshot.header.companyId,
      documentId: input.documentId,
      keys: stockKeys,
    });
  }

  //     …and the third MERGE (8C, contracts §4.12.8, round 18 B6): `app.employee_ytd` for a PAYROLL document only.
  //     The delta function decides that — it returns zero rows for a document with no payroll_run — so there is
  //     no type branch here and no HR import into the posting service. Same transaction (D14).
  await mergeEmployeeYtd(tx, input.documentId);

  // 13. the header. posted_by is written explicitly — the column has no default and app.stamp_actor
  //     overwrites a supplied value on the NULL → non-null transition but never invents one (LEGACY-044).
  //     2B's AFTER UPDATE OF status trigger writes the document_event; at Phase 1 there is none.
  await tx`update app.document
              set status = 'posted', posting_policy_id = ${policyId}, posted_at = now(), posted_by = app.current_actor()
            where id = ${input.documentId}`;

  // 14. (contracts §4.3.2): a BACK-DATED inventory document invalidates the affected items' tail and enqueues
  //     the replay on THIS `tx`, so a rollback un-enqueues it (spec:1127, 1223, 2321). Back-dated means: some
  //     already-posted movement of an affected item carries a strictly LATER effective_date. This document's
  //     own rows carry its date, so they never match, and its posting_seq is the maximum, so a same-date
  //     document never counts as back-dating it. 4B's accounting.projection.rebuild follows 3B's branch
  //     below; 5B's accounting.tax.submit joins this step later.
  const enqueuedJobIds: string[] = [];
  const movementItemIds = [...new Set(plan.movements.map((mv) => mv.itemId))];
  if (movementItemIds.length > 0) {
    const [later] = await tx<{ back_dated: boolean }[]>`
      select exists (
        select 1 from app.inventory_movement m
         where m.company_id = ${snapshot.header.companyId}
           and m.item_id = any(${movementItemIds}::uuid[])
           and m.effective_date > ${snapshot.header.effectiveDate}::date) as back_dated`;
    if (later?.back_dated) {
      if (!input.jobs) {
        // Never silently skip a recost. LEGACY-005 is exactly this: the flag that should have said "recost me"
        // was never set on insert, so a back-dated goods receipt mis-costed a whole month and nothing noticed.
        throw new PostingError(
          "ERR_INTERNAL",
          `document ${input.documentId} is back-dated and needs a cost replay, but was posted through a caller that supplied no JobClient`,
        );
      }
      await invalidateFrom(tx, ctx, {
        companyId: snapshot.header.companyId,
        itemIds: movementItemIds,
        effectiveDate: snapshot.header.effectiveDate,
        postingSeq,
        jobs: input.jobs,
      });
      // `singletonKey` on the replay's stately queue collapses a burst of back-dated posts into ONE queued
      // job (contracts §4.2.6), so the id is the key and not a pg-boss uuid — two postings in the same second
      // must not report two different replays. A post while a replay RUNS queues a fresh one; it never
      // collapses into a job that may already have read the tail this post invalidated (LEGACY-005).
      enqueuedJobIds.push(`inventory.cost.replay:${snapshot.header.companyId}`);
    }
  }

  //     Step 14's accounting.projection.rebuild half (contracts §4.3.2, 4B amendment 2), AFTER 3B's branch. A
  //     document with a party changes an ageing bucket; a document with movements changes item_profitability.
  //     `singletonKey` on the stately queue collapses a burst of posts into the one QUEUED job per company, and
  //     `startAfterSeconds` lets a batch settle first; a post while that job runs queues the next one, so no
  //     post waits for the nightly rebuild (§4.2.6). As 3B's branch does, the reported id is the key.
  const warnings = [...plan.warnings];
  if (snapshot.header.partyId !== null || plan.movements.length > 0) {
    if (input.jobs) {
      // Every enqueue failure fails the post. A collapse is not one — the client resolves with the queued
      // job's id — so nothing is caught here; `JobNotInsertedError` now means the client could neither insert
      // nor collapse, which loses the rebuild as surely as an unreachable queue does.
      //
      // NO `asOf` (code review B2): the handler defaults it to its own run date. The collapse keeps the FIRST
      // queued payload, so an `asOf` of this document's effective date meant the collapsed job rebuilt a past
      // snapshot for whichever post came first — one nothing reads — while today's stayed stale until 03:00.
      // Without it every collapsed request asks for the same thing: the snapshot as of the day the job runs.
      await input.jobs.enqueue(
        tx,
        "accounting.projection.rebuild",
        {
          tenantId: ctx.tenantId,
          requestId: ctx.requestId,
          payload: { companyId: snapshot.header.companyId },
        },
        { singletonKey: snapshot.header.companyId, startAfterSeconds: 60 },
      );
      enqueuedJobIds.push(`accounting.projection.rebuild:${snapshot.header.companyId}`);
    } else {
      // Deliberately a WARNING and not a throw — the opposite of 3B's back-dated branch above, and the
      // difference is the severity of the omission. A missed cost replay leaves a WRONG number in the ledger
      // for ever (LEGACY-005). A missed projection enqueue leaves a STALE snapshot that the nightly
      // accounting.projection.rebuild recomputes and the nightly compare would flag. Throwing here would break
      // every 4A call site that supplies no JobClient, postArDocument included (amendment 2).
      warnings.push(
        `accounting.projection.rebuild was not enqueued for company ${snapshot.header.companyId}: document ${input.documentId} was posted through a caller that supplied no JobClient; the nightly job will rebuild`,
      );
    }
  }

  // 15. The deferred constraint trigger ledger_entry_balanced fires at COMMIT (spec:1865); if the step-6
  //     pre-check were ever wrong, the caller's withTenant surfaces ERR_LEDGER_UNBALANCED from there.
  // ── 14c. e-invoicing (5B; §4.3.2 step 14, contracts amendment 3) ───────────────────────────
  //
  // THREE gates in series, every one defaulting off:
  //   (1) definition.tax.applies      — the type is taxable at all;
  //   (2) definition.tax.einvoice     — the AUTHORITY mandates this document class (an ADR-0051 fact,
  //                                 so it lives on the versioned policy — amendment 4);
  //   (3) company.einvoice_transmitter is not null — this company is enrolled.
  // Merging slice 5B therefore transmits nothing anywhere until a policy version and a company
  // column both say so.
  //
  // The pending row is written INSIDE this transaction and the enqueue after it, so a rolled-back
  // post leaves no transmission (test: "a rolled-back post leaves NO transmission row"). With no
  // JobClient the row is still written and a warning is pushed — the DURABLE ROW is the state of
  // record (ADR 0053), and the manual submit route and the poll phase both drive it, so a missed
  // enqueue delays a transmission and loses nothing. This is deliberately NOT 3B's fail-closed
  // branch: a missed cost replay leaves a wrong number in the ledger for ever (LEGACY-005), while a
  // missed enqueue leaves a pending row anyone can see.
  if (definition.tax?.applies === true && definition.tax.einvoice === true) {
    const [companyEinvoice] = await tx<{ transmitter: string | null }[]>`
      select einvoice_transmitter as transmitter
        from app.company
       where id = ${snapshot.company.id}`;
    const transmitter = companyEinvoice?.transmitter ?? null;
    if (transmitter !== null) {
      const transmissionId = await recordPending(tx, {
        documentId: input.documentId,
        companyId: snapshot.company.id,
        transmitter,
      });
      if (input.jobs) {
        enqueuedJobIds.push(
          await input.jobs.enqueue(
            tx,
            "accounting.tax.submit",
            {
              tenantId: ctx.tenantId,
              requestId: ctx.requestId,
              payload: { transmissionId, phase: "submit" },
            },
            { singletonKey: transmissionId, retryLimit: 8, retryDelaySeconds: 60 },
          ),
        );
      } else {
        warnings.push(
          `einvoice_enqueue_skipped: no job client (transmission ${transmissionId} stays pending until submitted)`,
        );
      }
    }
  }

  return {
    documentId: input.documentId,
    number,
    series,
    fiscalPeriodId: period.id,
    postingPolicyId: policyId,
    postingSeq,
    ledgerEntryIds,
    movementIds,
    taxTransactionIds,
    enqueuedJobIds,
    warnings,
  };
}

/** Step 6d, first half. Pure, and on the snapshot alone. A line carrying both count columns is a COUNTED line —
 *  a stock-count line `recordCounts` counted, or a TRANSFER_RECEIPT line `draftTransferReceipt` drafted — and
 *  its `quantity` is its variance `counted_quantity − expected_quantity`, which both of those writers compute
 *  in the same statement that writes the count columns. Every later step reads it that way: step 6d's
 *  admission of a negative counted transfer line, the variance rules' `line.quantity_sign`, and the legs
 *  `transferQuantities` takes from the count columns. So a line where the three disagree is refused, on every
 *  effect and before step 7, whoever wrote it. A reversal mirror carries no count columns (reverseDocument
 *  copies neither), so it is never asked. */
function refuseMisstatedVariance(snapshot: DocumentSnapshot, documentId: string): void {
  for (const line of snapshot.lines) {
    if (line.countedQuantity === null || line.expectedQuantity === null) continue;
    const variance = line.countedQuantity.subtract(line.expectedQuantity);
    if (line.quantity !== null && line.quantity.compare(variance) === 0) continue;
    throw new PostingError(
      "ERR_VALIDATION_FAILED",
      `document ${documentId} line ${line.lineNo}: a counted line's quantity is its variance counted_quantity − expected_quantity (${line.countedQuantity.toString()} − ${line.expectedQuantity.toString()} = ${variance.toString()}), and this line's is ${line.quantity === null ? "null" : line.quantity.toString()}`,
    );
  }
}

/** Step 6d. Pure, and on the snapshot and policy alone. A `transfer` line is asked as a receipt or an issue
 *  line is, EXCEPT a counted one: `transferQuantities` (packages/domain/src/posting/evaluate.ts) takes its two
 *  legs from `expected_quantity` and `counted_quantity`, so its signed `quantity` is the variance and moves
 *  nothing itself — the TRANSFER_RECEIPT short arrival. That it IS the variance is `refuseMisstatedVariance`'s
 *  refusal, asked just before this one; without it the admission would trust whatever sign a writer chose.
 *  Whether the policy accounts for that variance is step 6e's question, not this one's. It was not true that
 *  "its two legs are oriented together and TRANSFER_RECEIPT selects on the sign already": TRANSFER (dispatch)
 *  selects on nothing but the kind, and both of its legs flip with a negative quantity (code review 3, R3). */
function refuseUnchosenReturn(
  definition: PostingPolicy,
  snapshot: DocumentSnapshot,
  documentId: string,
): void {
  const effect = definition.inventory.effect;
  if (effect === "none") return;
  if (snapshot.header.reversesDocumentId !== null) return;
  for (const line of snapshot.lines) {
    if (line.quantity === null || !line.quantity.isNegative()) continue;
    if (quantitySignChosen(definition, line, snapshot)) continue;
    if (effect === "transfer") {
      if (line.countedQuantity !== null && line.expectedQuantity !== null) continue;
      throw new PostingError(
        "ERR_VALIDATION_FAILED",
        `document ${documentId} line ${line.lineNo}: a negative-quantity ${definition.documentType} line runs the transfer backwards while its ledger keeps the forward sides; undoing a transfer is POST …/reverse of the original, which carries its cost and signed amounts`,
      );
    }
    throw new PostingError(
      "ERR_VALIDATION_FAILED",
      `document ${documentId} line ${line.lineNo}: a negative-quantity ${definition.documentType} line is a return; a return is POST …/reverse of the original, which carries its cost and signed amounts`,
    );
  }
}

/** Step 6e. Pure, and on the step-6 plan, the policy and the snapshot alone. `plan.movements` names each line
 *  `planMovements` will move by its `lineNo`; nothing between step 6 and step 9 changes which lines those are. */
function refuseUnaccountedMovement(
  definition: PostingPolicy,
  snapshot: DocumentSnapshot,
  plan: PostingPlan,
  documentId: string,
): void {
  if (snapshot.header.reversesDocumentId !== null) return;
  const moving = new Set(plan.movements.map((mv) => mv.lineNo));
  for (const line of snapshot.lines) {
    if (!moving.has(line.lineNo)) continue;
    if (line.kind !== "item") {
      throw new PostingError(
        "ERR_VALIDATION_FAILED",
        `document ${documentId} line ${line.lineNo}: a line of kind '${line.kind}' carrying item ${line.itemId} would move stock; only an item line moves stock, and a landed-cost or charge line names an account and no item`,
      );
    }
    if (!lineMeetsARule(definition, line, snapshot)) {
      throw new PostingError(
        "ERR_VALIDATION_FAILED",
        `document ${documentId} line ${line.lineNo}: no each_line rule of the ${definition.documentType} policy meets this item line, so its movement would post with no ledger leg`,
      );
    }
    if (
      definition.inventory.effect === "transfer" &&
      line.countedQuantity !== null &&
      line.expectedQuantity !== null &&
      line.countedQuantity.compare(line.expectedQuantity) !== 0 &&
      !lineMeetsAVarianceRule(definition, line, snapshot)
    ) {
      throw new PostingError(
        "ERR_VALIDATION_FAILED",
        `document ${documentId} line ${line.lineNo}: ${line.countedQuantity.toString()} arrived of ${line.expectedQuantity.toString()} dispatched, and no each_line rule of the ${definition.documentType} policy that meets this line posts line.variance_value, so the difference between the two legs would post to no account`,
      );
    }
  }
}

/** Step 6f. One read of the kinds of the warehouses the step-6 plan moves stock at, bound to the document's
 *  company (RLS bounds only the tenant); a warehouse that is not the company's reads as unknown and is
 *  refused. */
async function refuseMisdirectedTransfer(
  tx: Sql,
  definition: PostingPolicy,
  snapshot: DocumentSnapshot,
  plan: PostingPlan,
  documentId: string,
): Promise<void> {
  if (snapshot.header.reversesDocumentId !== null) return;
  const leg = transferLegOf(definition);
  if (leg === null || plan.movements.length === 0) return;
  const flipped = new Set(
    snapshot.lines
      .filter(
        (line) =>
          line.quantity !== null &&
          line.quantity.isNegative() &&
          (line.countedQuantity === null || line.expectedQuantity === null),
      )
      .map((line) => line.lineNo),
  );
  const ids = [...new Set(plan.movements.map((mv) => mv.warehouseId))];
  const rows = await tx<{ id: string; kind: string; code: string }[]>`
    select id, kind, code from app.warehouse
     where company_id = ${snapshot.header.companyId} and id = any(${ids}::uuid[])`;
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const mv of plan.movements) {
    if (flipped.has(mv.lineNo)) continue;
    const want = transferWarehouseKind(leg, mv.effect);
    const at = byId.get(mv.warehouseId);
    if (at?.kind === want) continue;
    throw new PostingError(
      "ERR_VALIDATION_FAILED",
      `document ${documentId} line ${mv.lineNo}: the ${definition.documentType} policy posts a transfer ${leg}, whose ${mv.effect} leg must be at ${want === "stock" ? "a stock" : "an in_transit"} warehouse; this line's is at ${at === undefined ? `warehouse ${mv.warehouseId}, which is not this company's` : `${at.kind} warehouse ${at.code}`}`,
    );
  }
}

/** Step 6g. Pure, and on the policy, the snapshot, step 6's plan and the status the post started from. A policy
 *  that does not require approval is not asked: no checker approved its lines, so there is no approval for a
 *  draft write to defeat, and a custom adjustment type may choose its direction from the sign of a line nobody
 *  counted. */
function refuseUncountedVariance(
  definition: PostingPolicy,
  snapshot: DocumentSnapshot,
  plan: PostingPlan,
  status: string,
  documentId: string,
): void {
  if (!definition.approval.required) return;
  if (status !== "approved" && status !== "issued") return;
  const moved = new Set(plan.movements.map((m) => m.lineNo));
  for (const line of snapshot.lines) {
    if (!moved.has(line.lineNo)) continue;
    if (line.expectedQuantity !== null && line.countedQuantity !== null) continue;
    if (!quantitySignChosen(definition, line, snapshot)) continue;
    throw new PostingError(
      "ERR_VALIDATION_FAILED",
      `document ${documentId} line ${line.lineNo}: an approval-required ${definition.documentType} line whose rules choose its direction by the sign of its variance is a count line and must carry both count columns (expected_quantity and counted_quantity); without them it would be valued at a figure the approved count sheet does not show`,
    );
  }
}

/** Every step that evaluates (6 and 9a) in one place, so the PolicyEvaluationError codes translate once. */
function asPostingError<T>(documentId: string, step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof PolicyEvaluationError) {
      throw new PostingError(error.code, `document ${documentId}: ${error.detail}`);
    }
    throw error;
  }
}

/** Step 6. */
function planFor(
  definition: PostingPolicy,
  snapshot: DocumentSnapshot,
  documentId: string,
): PostingPlan {
  const plan = asPostingError(documentId, () =>
    balanceInBase(
      evaluatePolicy(definition, snapshot),
      snapshot.company.fxRoundingAccountId,
      snapshot.company.baseCurrency,
    ),
  );
  if (plan.ledgerLines.length === 0) {
    // Nothing in the database would stop this: assert_document_balanced is satisfied by 0 = 0 and
    // assert_period_open never fires with no rows, so the document would reach 'posted' with no ledger.
    throw new PostingError(
      "ERR_DOC_NO_LINES",
      `document ${documentId} has ${snapshot.lines.length} line(s) but the policy plans no ledger entry — every line is zero on both sides`,
    );
  }
  return plan;
}

/** Step 10. The column list is 0001 §7 exactly; posted_by and posted_at come from the row defaults. */
async function insertLedger(
  tx: Sql,
  ctx: TenantContext,
  snapshot: DocumentSnapshot,
  plan: PostingPlan,
  at: { policyId: string; periodId: string; effectiveDate: string },
): Promise<string[]> {
  const ids: string[] = [];
  for (const line of plan.ledgerLines) {
    // An fx_rounding line (1A) and a cost line (3B) are both BASE-currency lines at rate 1: the first
    // because it absorbs a base rounding residue (spec:1868), the second because a cost layer's unit_cost is
    // base by construction (contracts §4.7.3, amendment A4). A policy line carries the document's currency
    // and the header rate. Both satisfy base_* = round(value * rate, 4) by construction, which is the
    // ledger_entry CHECK.
    const isBase = line.role !== "policy";
    const lineCurrency = isBase ? snapshot.company.baseCurrency : snapshot.header.currency;
    const rate = isBase ? "1.00000000" : snapshot.header.exchangeRate.rate;
    const debit = line.side === "debit" ? line.amount.toString() : "0.0000";
    const credit = line.side === "credit" ? line.amount.toString() : "0.0000";
    const baseDebit = line.side === "debit" ? line.base.toString() : "0.0000";
    const baseCredit = line.side === "credit" ? line.base.toString() : "0.0000";

    const [entry] = await tx<{ id: string }[]>`
      insert into app.ledger_entry
        (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate,
         base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id)
      values (${ctx.tenantId}, ${snapshot.header.companyId}, ${snapshot.header.id}, ${line.lineNo},
              ${line.accountId}, ${debit}, ${credit}, ${lineCurrency}, ${rate},
              ${baseDebit}, ${baseCredit}, ${at.effectiveDate}, ${at.periodId}, ${at.policyId})
      returning id`;
    ids.push(entry!.id);
    await insertDimensions(tx, ctx, snapshot, entry!.id, line);
  }
  return ids;
}

async function insertDimensions(
  tx: Sql,
  ctx: TenantContext,
  snapshot: DocumentSnapshot,
  entryId: string,
  line: PlannedLedgerLine,
): Promise<void> {
  for (const [code, valueId] of Object.entries(line.dimensions)) {
    const typeId = snapshot.refs.dimensionTypesByCode[code];
    if (!typeId) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `company ${snapshot.company.id} has no dimension type ${code}, named by planned line ${line.lineNo}`,
      );
    }
    await tx`insert into app.ledger_entry_dimension (tenant_id, entry_id, dimension_type_id, dimension_value_id)
             values (${ctx.tenantId}, ${entryId}, ${typeId}, ${valueId})`;
  }
}

/** Step 6h. One read of the document's allocations, bound to the goods lines step 6 planned a receipt for. */
async function refuseUnallocatedLandedCost(
  tx: Sql,
  definition: PostingPolicy,
  snapshot: DocumentSnapshot,
  plan: PostingPlan,
  documentId: string,
): Promise<void> {
  if (snapshot.header.reversesDocumentId !== null) return;
  if (definition.inventory.effect !== "receipt") return;
  if ((definition.inventory.costing ?? "create_layer") !== "create_layer") return;
  const receiving = new Set(
    plan.movements.filter((mv) => mv.effect === "receipt").map((mv) => mv.lineNo),
  );
  const goods = snapshot.lines.filter((line) => line.kind === "item" && receiving.has(line.lineNo));
  const inventoryAccounts = new Set<string>();
  for (const code of ["1300", "1310"]) {
    const id = snapshot.refs.accountsByCode[code];
    if (id !== undefined) inventoryAccounts.add(id);
  }
  for (const line of goods) {
    const account =
      line.itemId === null ? null : snapshot.refs.items[line.itemId]?.inventoryAccountId;
    if (account) inventoryAccounts.add(account);
  }
  const costLines = snapshot.lines.flatMap((line) => {
    if (line.kind !== "account") return [];
    const debits = plan.ledgerLines.filter(
      (l) =>
        l.sourceLineNo === line.lineNo && l.side === "debit" && inventoryAccounts.has(l.accountId),
    );
    if (debits.length === 0) return [];
    const capitalised = debits.reduce(
      (sum, l) => sum.add(l.amount),
      Money.zero(line.amount.currency),
    );
    return capitalised.isZero() ? [] : [{ line, capitalised, accountId: debits[0]!.accountId }];
  });
  if (costLines.length === 0) return;
  const allocated = await allocatedByCostLine(
    tx,
    documentId,
    goods.map((line) => line.id),
  );
  for (const { line, capitalised, accountId } of costLines) {
    const share = allocated.get(line.id);
    const onGoods =
      share === undefined
        ? Money.zero(capitalised.currency)
        : Money.of(share, capitalised.currency);
    if (onGoods.compare(capitalised) !== 0) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `document ${documentId} line ${line.lineNo} capitalises ${capitalised.toString()} into inventory account ${accountId} but ${onGoods.toString()} of it is allocated onto the goods lines; allocate it (POST …/landed-cost) before posting, or no cost layer holds what the ledger carries`,
      );
    }
  }
}
