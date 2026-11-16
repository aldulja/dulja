import { applyTillEvent, tillEventRef, type TillEventInput } from "./till-events";
import { applyCashEvent, cashEventRef, type TillCashInput } from "./till-cash";
import { classifyShifts, applyShiftOpen, applyShiftClose, assertShiftKnown } from "./shifts";
import { recordAttendance, type AttendanceKind } from "../staff/attendance";
// packages/db/src/sync/apply.ts
import type { Sql, TransactionSql } from "postgres";
import { costingEngine, currency, Money, Quantity, rational } from "@dulja/domain";
import type { TenantContext } from "../with-tenant";
import type { JobClient } from "../jobs/enqueue";
import { postDocument } from "../posting/post";
import { recordOverride, setEventContext } from "../posting";
import { PostingError } from "../posting/errors";
import { computeDocumentTax, loadPosReturnHistory, posReturnShare } from "../tax/compute";
import { currentCatalogueRevision } from "./catalogue";
import { POS_PERMISSION } from "./authority";
import { verifyTicket } from "./limits";
import { CASH_ROUNDING_FIELD, lineCashRounding, verifyCashRounding } from "./cash-rounding";
import { PROMOTION_FIELD, verifyPromotions } from "./promotion";
import { SyncError } from "./enrolment";
import { upsertNeedsAttention } from "./needs-attention";
import { openLayersFor, loadSentinelLots } from "../costing/apply-movements";
import { lockTenantAuditSerial } from "../costing/invalidate";
import { lockStockKeys } from "../costing/stock-on-hand";
import { linkFulfilment } from "../documents/link";

// ── The db-local structural twins of §4.10.1 (§3.1: packages/db may not import @dulja/sync) ────────────
export interface TicketLineInput {
  lineNo: number;
  itemId: string;
  lotId: string | null;
  quantity: string;
  unitId: string;
  unitPrice: { amount: string; currency: string };
  discount: { amount: string; currency: string };
  taxCodeId: string | null;
  taxAmount: { amount: string; currency: string };
  total: { amount: string; currency: string };
  /** `| undefined` for the same reason as `TicketInput.cashRounding`. Absent, undefined and null all mean "no
   *  promotion evidence" to `verifyPromotions`, and the whole discount is then the cashier's. */
  promotion?:
    | { promotionId: string; discount: { amount: string; currency: string } }
    | null
    | undefined;
}
export interface TicketTenderInput {
  tenderNo: number;
  method: string;
  amount: { amount: string; currency: string };
  reference: string | null;
}
export interface TicketEventInput {
  kind: string;
  code: string;
  subject: string;
  supervisorPrincipalId: string;
  reason: string;
}
export interface NewCustomerInput {
  id: string;
  code: string;
  nameEn: string;
  phone: string | null;
}
export interface TicketInput {
  /** `| undefined` because the wire schema's field is `.optional()` and `exactOptionalPropertyTypes` is on:
   *  a parsed `TicketBatchBody` must satisfy this twin as it stands. Absent, undefined and null all mean
   *  "no rounding evidence" to `verifyCashRounding`. */
  cashRounding?:
    | { lineNo: number; adjustment: { amount: string; currency: string } }
    | null
    | undefined;
  clientRef: string;
  shiftId: string;
  cashierPrincipalId: string;
  customerId: string | null;
  newCustomer?: NewCustomerInput | null;
  kind: string;
  returnsClientRef: string | null;
  currency: string;
  soldAt: string;
  lines: TicketLineInput[];
  tenders: TicketTenderInput[];
  events: TicketEventInput[];
  attendance: { kind: string; principalId: string; at: string }[];
  catalogueRevision: string | bigint;
}
export interface TicketBatchInput {
  terminalId: string;
  batchId: string;
  tickets: TicketInput[];
  shifts: unknown[];
  tillEvents: unknown[];
  /** ⚠️ OD-10 (ADR 0064). Optional, so a three-array client and 6A's own tests are unchanged. */
  cashEvents?: unknown[] | undefined;
}

export interface TicketOutcome {
  clientRef: string;
  status: "accepted" | "duplicate" | "rejected";
  documentId: string | null;
  number: string | null;
  error: { code: string; detail: string } | null;
}
export interface MessageOutcome {
  ref: string;
  status: "accepted" | "duplicate" | "rejected";
  error: { code: string; detail: string } | null;
}
export interface BatchOutcome {
  batchId: string;
  results: TicketOutcome[];
  shiftResults: MessageOutcome[];
  tillEventResults: MessageOutcome[];
  /** ⚠️ OD-10 — always present, empty when the batch carried no `cashEvents`. */
  cashEventResults: MessageOutcome[];
  catalogueRevision: bigint;
}

export interface TerminalApplyContext {
  terminalId: string;
  companyId: string;
  branchId: string;
  principalId: string;
  jobs?: JobClient;
}

/** §4.6.5's four, and no fifth. A method outside this set never reaches a policy rule, so it would plan no
 *  ledger line and fail `assert_document_balanced` at COMMIT — a correct but late and confusing failure. */
const TENDER_METHODS = new Set(["cash", "card", "transfer", "store_credit"]);

/**
 * Applies one `TicketBatch`. **One transaction, a savepoint per ticket** (spec:1303): a bad ticket rolls back
 * to its own savepoint and its neighbours still commit. Business refusals retain their whole payload in
 * the manager queue. A serialization failure or deadlock while retaining one aborts the batch for retry; any
 * other refusal of the quarantine write is appended to the ticket's rejection detail, so the till still holds
 * the payload. Rejected messages remain in the till outbox, including a reference collision owned by another
 * terminal.
 *
 * Documents still post through `postDocument`; this module writes no financial or stock projection.
 * Tax is recomputed by the tax service. Returns preserve verified carrying-cost and historical
 * source budgets; stock movements, consumptions, numbering and ledger writes remain in posting.
 *
 * **The terminal acts and the cashier is attributed** (hazard 19, SAH-044). `created_by` and `posted_by` come
 * from the column default `app.current_actor()`, which is `ctx.actorId` — the terminal's principal, resolved
 * from the signed call. `attributed_to` is `cashierPrincipalId`, a data column. No line of this function
 * passes a principal id from the payload into an actor column.
 */
export async function applyBatch(
  tx: Sql,
  ctx: TenantContext,
  terminal: TerminalApplyContext,
  batch: TicketBatchInput,
): Promise<BatchOutcome> {
  if (ctx.actorId !== terminal.principalId || batch.terminalId !== terminal.terminalId)
    throw new SyncError(
      "ERR_TERMINAL_SIGNATURE_INVALID",
      "batch does not belong to the acting terminal",
    );
  // 1. Serialise concurrent applies for ONE terminal (§4.1's fixed literals, Task 0 amendment 18). The
  //    synchronous route and the pos.sync.apply job can race after a client timeout; without this both pass
  //    the dedup read and collide on document_company_id_client_ref_key. Holding it means the second one
  //    SEES the first one's rows and answers `duplicate`, which is the difference between a clean idempotent
  //    answer and a noisy 23505 the caller has to interpret.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`sync-batch:${terminal.terminalId}`}, 0))`;

  await lockTenantAuditSerial(tx, ctx.tenantId);

  // 2. One catalogue read for the whole batch, so the till learns how stale it is in the same response.
  const catalogueRevision = await currentCatalogueRevision(tx, terminal.companyId);

  const split = classifyShifts(batch.shifts);
  const shiftAnswers = new Map<number, MessageOutcome>(
    split.malformed.map((item) => [item.index, item.outcome]),
  );
  for (const item of split.opens)
    shiftAnswers.set(
      item.index,
      await runMessage(tx, item.ref, (sp) => applyShiftOpen(sp, ctx, terminal, item.msg)),
    );
  const results: TicketOutcome[] = [];
  for (const ticket of batch.tickets) {
    try {
      results.push(
        await (tx as unknown as TransactionSql).savepoint(async (sp) => {
          const outcome = await applyTicket(sp as unknown as Sql, ctx, terminal, ticket);
          await sp`set constraints all immediate`;
          await sp`set constraints all deferred`;
          return outcome;
        }),
      );
    } catch (e: unknown) {
      if (["40P01", "40001"].includes(String((e as { code?: string }).code))) throw e;
      let { code, detail } = classify(e);
      if (code === "DUPLICATE") {
        try {
          const existing = await (tx as unknown as TransactionSql).savepoint((sp) =>
            findExisting(sp as unknown as Sql, terminal, ticket.clientRef),
          );
          if (existing) {
            results.push({
              clientRef: ticket.clientRef,
              status: "duplicate",
              documentId: existing.id,
              number: existing.number,
              error: null,
            });
            continue;
          }
          code = "ERR_CONFLICT_UNIQUE";
          detail = "client reference collision did not resolve to an applied terminal ticket";
        } catch (collision) {
          ({ code, detail } = classify(collision));
        }
      }
      // A separate savepoint preserves neighbours even if the quarantine reference belongs to another terminal.
      try {
        await (tx as unknown as TransactionSql).savepoint((sp) =>
          upsertNeedsAttention(sp as unknown as Sql, ctx, {
            companyId: terminal.companyId,
            branchId: terminal.branchId,
            terminalId: terminal.terminalId,
            clientRef: ticket.clientRef,
            payload: ticket,
            errorCode: code,
            errorDetail: detail,
          }),
        );
      } catch (queueError) {
        if (["40P01", "40001"].includes(String((queueError as { code?: string }).code)))
          throw queueError;
        detail += `; quarantine write refused: ${classify(queueError).detail}`;
      }
      results.push({
        clientRef: ticket.clientRef,
        status: "rejected",
        documentId: null,
        number: null,
        error: { code, detail },
      });
    }
  }

  const tillEventResults: MessageOutcome[] = [];
  for (const raw of batch.tillEvents)
    tillEventResults.push(
      await runMessage(tx, tillEventRef(raw), (sp) =>
        applyTillEvent(sp, ctx, terminal, (raw ?? {}) as TillEventInput),
      ),
    );
  // Cash events, BETWEEN the till events and the closes (ADR 0064): a banking or a safe drop is cash out of
  // the drawer before the count, and a paid-out funded by the day's sales needs those sales posted first.
  const cashEventResults: MessageOutcome[] = [];
  for (const raw of batch.cashEvents ?? [])
    cashEventResults.push(
      await runMessage(tx, cashEventRef(raw), (sp) =>
        applyCashEvent(sp, ctx, terminal, (raw ?? {}) as TillCashInput),
      ),
    );
  for (const item of split.closes)
    shiftAnswers.set(
      item.index,
      await runMessage(tx, item.ref, (sp) => applyShiftClose(sp, ctx, terminal, item.msg)),
    );
  return {
    batchId: batch.batchId,
    results,
    shiftResults: batch.shifts.map((_, index) => shiftAnswers.get(index)!),
    tillEventResults,
    cashEventResults,
    catalogueRevision,
  };
}

// ── one ticket, in the order the algorithm fixes ───────────────────────────────────────────────────────

async function applyTicket(
  sp: Sql,
  ctx: TenantContext,
  terminal: TerminalApplyContext,
  ticket: TicketInput,
): Promise<TicketOutcome> {
  // (a) Dedup, BEFORE writing anything (spec:1304). The read is the common case; the unique index below is
  //     the race. Both answer `duplicate`, and neither writes.
  const existing = await findExisting(sp, terminal, ticket.clientRef);
  if (existing) {
    return {
      clientRef: ticket.clientRef,
      status: "duplicate",
      documentId: existing.id,
      number: existing.number,
      error: null,
    };
  }

  // (b) Shape. Every refusal names the line, because "invalid ticket" is unactionable at a till.
  const company = await loadCompany(sp, terminal.companyId, terminal.branchId);
  // The cashier's own discounts, reconstructed from verified evidence: the cash rounding first (its target is
  // chosen from the gross after every discount), then the promotions, whose share is the shop's decision.
  const promoted = await verifyPromotions(
    sp,
    terminal,
    await verifyCashRounding(sp, terminal, ticket),
  );
  const authorityTicket = promoted.ticket;
  validateShape(ticket, company.currency, authorityTicket);
  await validateItemReferences(sp, terminal, ticket);

  await assertShiftKnown(sp, terminal, ticket.shiftId);
  await setEventContext(sp, {});
  // (d) Authority, re-verified against the SERVER's current assignments and never against anything the till
  //     sent (spec:1324). The codes come from the ticket's own content, and the override door is 2B's guard.
  await verifyAuthority(sp, ctx, terminal, ticket);

  // (e) Customer quick-create. `id` is the uuidv7 the till minted offline and is also `customerId`, so a
  //     re-sent ticket creates no second party. `on conflict do nothing` then a read-back by code, so a
  //     a competing offline identity is refused rather than changing the customer silently.
  const partyId = await quickCreateCustomer(sp, ctx, terminal, ticket);
  const returnFacts = await prepareReturns(sp, terminal, ticket, company, partyId);

  // (f) The header. `created_by` is NOT written: the column default is app.current_actor(), which is the
  //     terminal (hazard 19). `effective_date` is the till's LOCAL sale date and never now() — a ticket sold
  //     at 23:50 belongs to that day's takings whatever hour the sync happens (spec:2039).
  //
  //     `series` IS written, with the policy's own literal 'POS', because plan0A's app.document declares
  //     `series text not null` with no default — a draft has to carry one. It is a PLACEHOLDER and never the
  //     final value: §4.3.6's issue SQL does `update app.document set … series = $series …`, and $series is
  //     what `resolveSeries` (Task 4) returns — 'POS-<terminal code>' for a terminal-tagged document. Every
  //     other slice's draft path does the same thing (3C's `draftTypedDocument` takes a `series` argument),
  //     so this is the convention and not an exception.
  //
  //     `shift_id` is 0061's column (Task 0 amendment 6, and 6D's own amendment A2 from the other side). It
  //     carries no foreign key at 6A and gains none at 0070, so writing the till's minted id here is safe and
  //     is what lets 6D resolve a shift's tickets without re-keying a single 6A document.
  //
  //     There is NO `memo` column on app.document and this insert names none: 2C's 0027 added `notes text`,
  //     and a POS ticket has nothing to put in it — the cashier's free text, when Phase 6 grows one, is a
  //     `text` line, not a header field.
  const [doc] = await sp<{ id: string }[]>`
    insert into app.document (
      tenant_id, company_id, branch_id, document_type_id, status, series, effective_date, currency,
      exchange_rate, client_ref, terminal_id, shift_id, attributed_to, party_id, warehouse_id, tax_inclusive)
    select ${ctx.tenantId}, ${terminal.companyId}, ${terminal.branchId}, dt.id, 'draft', 'POS',
           (${ticket.soldAt}::timestamptz at time zone ${company.timezone})::date,
           ${ticket.currency}, 1, ${ticket.clientRef}, ${terminal.terminalId}, ${ticket.shiftId},
           ${ticket.cashierPrincipalId}, ${partyId}, ${company.posWarehouseId}, true
      from app.document_type dt
     where dt.company_id = ${terminal.companyId} and dt.code = 'POS_TICKET'
    returning id`;
  if (!doc)
    throw new SyncError(
      "ERR_NOT_FOUND",
      "the POS_TICKET document type is not configured for this company",
    );
  const documentId = doc.id;

  // (g) Preserve offline item line identities; tender and settlement lines follow their maximum.
  await insertLines(
    sp,
    ctx,
    terminal.companyId,
    documentId,
    ticket,
    returnFacts,
    promoted.honoured,
  );

  for (const attendance of ticket.attendance) {
    if (attendance.kind !== "clock_in" && attendance.kind !== "clock_out")
      throw new SyncError("ERR_VALIDATION_FAILED", "signed attendance must be a clock event");
    const [cashier] = await sp<
      { employeeId: string }[]
    >`select employee_id as "employeeId" from app.pos_cashier
      where principal_id=${attendance.principalId} and company_id=${terminal.companyId}
        and branch_id=${terminal.branchId} and revoked_at is null`;
    if (!cashier)
      throw new SyncError("ERR_NOT_FOUND", "no active cashier for this attendance event");
    const [clockAuthorised] = await sp<{ ok: boolean }[]>`
      select app.principal_has(${attendance.principalId}::uuid, 'pos.attendance.clock',
                               ${terminal.companyId}::uuid, ${terminal.branchId}::uuid) as ok`;
    if (clockAuthorised?.ok !== true)
      throw new SyncError(
        "ERR_RBAC_FORBIDDEN",
        "attendance cashier does not hold pos.attendance.clock at this branch",
      );

    const event = await recordAttendance(sp, terminal.companyId, {
      employeeId: cashier.employeeId,
      kind: attendance.kind as AttendanceKind,
      occurredAt: attendance.at,
      branchId: terminal.branchId,
      terminalId: terminal.terminalId,
      cashierPrincipalId: attendance.principalId,
    });
    if (!event)
      throw new SyncError("ERR_NOT_FOUND", "attendance employee is not visible to this terminal");
  }

  // (h) Recompute tax and compare THROUGH Money. `computeDocumentTax` has already WRITTEN the server's
  //     figures, so a mismatch is a refusal and never a correction: a till whose catalogue is stale re-pulls
  //     and re-prices, and no receipt is issued at a rate nobody chose (SAH-020's discipline at the till).
  const sourceId = [...returnFacts.values()][0]?.sourceDocumentId;
  const computed = await computeDocumentTax(
    sp,
    ctx,
    documentId,
    sourceId ? { historicalSourceId: sourceId } : {},
  );
  verifyTax(ticket, computed);
  // Authority and branch limits read the RECONSTRUCTED manual discounts (ADR 0059's integration correction):
  // the wire discount also carries the verified cash-rounding adjustment and any verified promotion, and
  // neither an automatic rounding nor the shop's promotion is a discount the cashier must hold
  // `pos.ticket.discount` for or one the branch limit counts (ADR 0059's PR 12 review amendment). Evidence the
  // server could not prove stays in the cashier's discount, and a refusal says why it was not honoured.
  const verdict = await verifyTicket(
    sp,
    { companyId: terminal.companyId, branchId: terminal.branchId, currency: ticket.currency },
    authorityTicket,
  );
  const unhonoured =
    promoted.unhonoured.length === 0
      ? ""
      : `; promotion evidence not honoured — ${promoted.unhonoured.join("; ")}`;
  if (verdict.missingCodes.length > 0)
    throw new SyncError(
      "ERR_RBAC_FORBIDDEN",
      `cashier ${ticket.cashierPrincipalId} lacks ${verdict.missingCodes.join(", ")} at branch ${terminal.branchId}${unhonoured}`,
    );
  if (verdict.refusals.length > 0)
    throw new SyncError(
      "ERR_POS_LIMIT_EXCEEDED",
      verdict.refusals.map((r) => r.detail).join("; ") + unhonoured,
    );

  // (i) The overrides, through 2B's door and never by an insert of our own (hazard 24). The guard checks the
  //     supervisor holds the code at the document's branch AND is neither created_by nor attributed_to.
  for (const ev of ticket.events) {
    await setEventContext(sp, {
      reason: `${ev.subject}: ${ev.reason}`,
      attributedTo: ev.supervisorPrincipalId,
    });
    await recordOverride(sp, ctx, {
      documentId,
      code: "pos.ticket.override",
      reason: `${ev.subject}: ${ev.reason}`,
      attributedTo: ev.supervisorPrincipalId,
    });
  }

  await setEventContext(sp, {});
  // (j) And nothing else. postDocument issues, numbers, resolves the policy, plans, moves stock, consumes
  //     layers, writes tax transactions and writes the ledger — all of it 1A/2A/3B/5A's, unchanged.
  const posted = await postDocument(sp, ctx, {
    documentId,
    ...(terminal.jobs === undefined ? {} : { jobs: terminal.jobs }),
  });
  // A ticket refused earlier and accepted now — its refusal was cured by a grant, a limit or an open period,
  // with the payload unchanged — closes its open needs-attention row, so the manager's queue holds only what
  // still needs a person (PR 12 review). Inside this ticket's savepoint, so the two stand or fall together;
  // `resolved_by` is stamped from the session (0060), which is the terminal that sent it.
  await sp`
    update app.needs_attention
       set resolved_at = now(), resolved_by = ${ctx.actorId},
           resolution_note = ${`posted as ${posted.number.toString()} when the till sent it again`}
     where company_id = ${terminal.companyId} and branch_id = ${terminal.branchId}
       and client_ref = ${ticket.clientRef} and resolved_at is null`;
  return {
    clientRef: ticket.clientRef,
    status: "accepted",
    documentId,
    number: posted.number.toString(),
    error: null,
  };
}

// ── the eleven helpers ──────────────────────────────────────────────────────────────────────────────────

async function findExisting(
  tx: Sql,
  terminal: TerminalApplyContext,
  clientRef: string,
): Promise<{ id: string; number: string | null } | null> {
  const [row] = await tx<
    {
      id: string;
      number: string | null;
      terminal_id: string | null;
      branch_id: string | null;
      status: string;
      code: string;
    }[]
  >`
    select d.id, d.number::text as number, d.terminal_id, d.branch_id, d.status, dt.code
      from app.document d join app.document_type dt on dt.id = d.document_type_id
     where d.company_id = ${terminal.companyId} and d.client_ref = ${clientRef}`;
  if (!row) return null;
  if (
    row.terminal_id !== terminal.terminalId ||
    row.branch_id !== terminal.branchId ||
    row.code !== "POS_TICKET" ||
    !["posted", "reversed"].includes(row.status)
  )
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `client ref ${clientRef} collides with another document`,
    );
  return row;
}

interface CompanyRow {
  currency: string;
  timezone: string;
  posWarehouseId: string;
}
async function loadCompany(tx: Sql, companyId: string, branchId: string): Promise<CompanyRow> {
  // The warehouse a POS_TICKET issues from: the company's single `stock` warehouse at the terminal's branch
  // in Phase 6. `policy.requires` names `warehouse`, so a company with none refuses at the policy layer with
  // ERR_POLICY_REQUIRES_MISSING naming it — which is the right error, and better than a NULL FK here.
  const [row] = await tx<{ currency: string; timezone: string; warehouse_id: string | null }[]>`
    select c.base_currency as currency, c.timezone,
           (select w.id from app.warehouse w
             where w.company_id = c.id and w.branch_id = ${branchId} and w.kind = 'stock' and w.archived_at is null
             order by w.code limit 1) as warehouse_id
      from app.company c where c.id = ${companyId}`;
  if (!row) throw new SyncError("ERR_NOT_FOUND", `company ${companyId} is not visible`);
  if (row.warehouse_id === null) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `company ${companyId} has no stock warehouse; a POS ticket cannot issue stock`,
    );
  }
  return { currency: row.currency, timezone: row.timezone, posWarehouseId: row.warehouse_id };
}

async function itemConversion(
  tx: Sql,
  terminal: Pick<TerminalApplyContext, "companyId">,
  line: TicketLineInput,
): Promise<{ numerator: string; denominator: string }> {
  const [row] = await tx<{ numerator: string; denominator: string }[]>`
    select case when i.base_unit_id=${line.unitId} then 1 else u.numerator end::text as numerator,
           case when i.base_unit_id=${line.unitId} then 1 else u.denominator end::text as denominator
      from app.item i left join app.unit_conversion u on u.item_id=i.id and u.unit_id=${line.unitId}
     where i.id=${line.itemId} and i.company_id=${terminal.companyId}`;
  if (!row?.numerator || !row.denominator)
    fail(`line ${line.lineNo}: unit cannot be converted for this item`);
  const exact = rational(BigInt(row.numerator), BigInt(row.denominator));
  return { numerator: exact.numerator.toString(), denominator: exact.denominator.toString() };
}

async function validateItemReferences(
  tx: Sql,
  terminal: TerminalApplyContext,
  ticket: TicketInput,
): Promise<void> {
  for (const line of ticket.lines) {
    const [item] = await tx<
      { base_unit_id: string }[]
    >`select base_unit_id from app.item where id=${line.itemId} and company_id=${terminal.companyId} and archived_at is null`;
    if (!item)
      throw new SyncError(
        "ERR_VALIDATION_FAILED",
        `line ${line.lineNo}: item must be an active item of the terminal company`,
      );
    const [unit] = await tx<
      { id: string }[]
    >`select id from app.unit_of_measure where id=${line.unitId} and company_id=${terminal.companyId}`;
    if (!unit)
      throw new SyncError(
        "ERR_VALIDATION_FAILED",
        `line ${line.lineNo}: unit must belong to the terminal company`,
      );
    if (line.unitId !== item.base_unit_id) {
      const [conversion] = await tx<
        { ok: boolean }[]
      >`select numerator>0 and denominator>0 as ok from app.unit_conversion where item_id=${line.itemId} and unit_id=${line.unitId}`;
      if (!conversion?.ok)
        throw new SyncError(
          "ERR_VALIDATION_FAILED",
          `line ${line.lineNo}: unit requires a positive item conversion`,
        );
    }
    if (line.lotId !== null) {
      const [lot] = await tx<
        { id: string }[]
      >`select id from app.lot where id=${line.lotId} and item_id=${line.itemId} and company_id=${terminal.companyId}`;
      if (!lot)
        throw new SyncError(
          "ERR_VALIDATION_FAILED",
          `line ${line.lineNo}: lot must belong to the named item and company`,
        );
    }
  }
}

function fail(detail: string): never {
  throw new SyncError("ERR_VALIDATION_FAILED", detail);
}

function validateShape(
  ticket: TicketInput,
  companyCurrency: string,
  authorityTicket: TicketInput = ticket,
): void {
  if (ticket.kind !== "sale" && ticket.kind !== "return")
    fail(`ticket ${ticket.clientRef}: kind is '${ticket.kind}', not sale or return`);
  if (ticket.currency !== companyCurrency) {
    fail(
      `ticket ${ticket.clientRef}: currency ${ticket.currency} is not the company's ${companyCurrency}; a till sells in the company's currency (D-currency, spec:2041)`,
    );
  }
  if (ticket.lines.length === 0) fail(`ticket ${ticket.clientRef}: no lines`);
  if (ticket.tenders.length === 0 && ticket.customerId === null && ticket.newCustomer == null)
    fail(`ticket ${ticket.clientRef}: an account sale requires a customer`);
  if (ticket.kind === "sale" && ticket.returnsClientRef !== null)
    fail("a sale cannot reference an original return");
  if (!Number.isFinite(Date.parse(ticket.soldAt))) fail("soldAt must be a valid timestamp");
  const lineNumbers = new Set<number>();
  const tenderNumbers = new Set<number>();

  // Every money object on the wire carries `currency` as a PLAIN string (§4.2.8's `MoneySchema`), and
  // `Money<C>` is parameterised by the branded `CurrencyCode` that `currency()` alone produces (§4.2.1) —
  // so the brand is applied once, here, and `money()` is the single gate a mixed-currency ticket must pass.
  // After this function no code in this file reads a `.currency` string again.
  const ccy = currency(ticket.currency);
  const money = (m: { amount: string; currency: string }, field: string) => {
    if (m.currency !== ticket.currency) {
      fail(
        `ticket ${ticket.clientRef} ${field}: currency ${m.currency} is not the ticket's ${ticket.currency}`,
      );
    }
    return Money.of(m.amount, ccy);
  };

  let lineTotal = Money.zero(ccy);
  for (const l of ticket.lines) {
    if (!Number.isSafeInteger(l.lineNo) || l.lineNo <= 0 || lineNumbers.has(l.lineNo))
      fail(`line ${l.lineNo}: line numbers must be unique positive integers`);
    lineNumbers.add(l.lineNo);
    const q = Quantity.of(l.quantity);
    // §4.4.2's A9 and 3A's rule read from the OTHER side: nothing here chooses a direction from a sign, it
    // only refuses a ticket whose own kind and quantities disagree. A sale with a negative line is a return
    // that forgot to say so, and applying it would post a receipt from a policy declaring `issue`.
    // `Quantity` has `isZero` and `isNegative` and **no `isPositive`** (§4.2.1's member list is 0D's and
    // frozen), so "> 0" is spelled out of the two it does have rather than assumed onto it.
    if (ticket.kind === "sale" && (q.isZero() || q.isNegative()))
      fail(`ticket ${ticket.clientRef} line ${l.lineNo}: a sale line quantity must be > 0`);
    if (ticket.kind === "return" && !q.isNegative())
      fail(`ticket ${ticket.clientRef} line ${l.lineNo}: a return line quantity must be < 0`);
    const price = money(l.unitPrice, `line ${l.lineNo} unitPrice`);
    const discount = money(l.discount, `line ${l.lineNo} discount`);
    if (price.isNegative()) fail(`line ${l.lineNo}: unit price cannot be negative`);
    const manualDiscount = money(
      authorityTicket.lines.find((line) => line.lineNo === l.lineNo)!.discount,
      `line ${l.lineNo} manual discount`,
    );
    if (
      ticket.returnsClientRef === null &&
      !manualDiscount.isZero() &&
      manualDiscount.isNegative() !== q.isNegative()
    )
      fail(`line ${l.lineNo}: discount sign disagrees with quantity`);
    const entered = price.multiply(q.toString(), "HALF_AWAY_FROM_ZERO");
    if (ticket.returnsClientRef === null && manualDiscount.abs().compare(entered.abs()) > 0)
      fail(`line ${l.lineNo}: discount exceeds gross price`);
    if (
      ticket.returnsClientRef === null &&
      !money(l.total, `line ${l.lineNo} total`).equals(entered.subtract(discount))
    )
      fail(`line ${l.lineNo}: total is not quantity times unit price less discount`);
    money(l.discount, `line ${l.lineNo} discount`);
    money(l.taxAmount, `line ${l.lineNo} taxAmount`);
    lineTotal = lineTotal.add(money(l.total, `line ${l.lineNo} total`));
  }

  let tenderTotal = Money.zero(ccy);
  for (const t of ticket.tenders) {
    if (!Number.isSafeInteger(t.tenderNo) || t.tenderNo <= 0 || tenderNumbers.has(t.tenderNo))
      fail(`tender ${t.tenderNo}: numbers must be unique positive integers`);
    tenderNumbers.add(t.tenderNo);
    const amount = money(t.amount, `tender ${t.tenderNo}`);
    if (!amount.isZero() && amount.isNegative() !== (ticket.kind === "return"))
      fail(`tender ${t.tenderNo}: sign disagrees with ticket kind`);
    if (!TENDER_METHODS.has(t.method)) {
      fail(
        `ticket ${ticket.clientRef} tender ${t.tenderNo}: method '${t.method}' is not one of cash, card, transfer, store_credit (§4.6.5)`,
      );
    }
    tenderTotal = tenderTotal.add(money(t.amount, `tender ${t.tenderNo}`));
  }
  // Through Money, never Number: a cent of float drift here would post an unbalanced document that
  // assert_document_balanced would then refuse at COMMIT, naming the ledger instead of the ticket.
  if (ticket.tenders.length > 0 && !tenderTotal.equals(lineTotal)) {
    fail(
      `ticket ${ticket.clientRef}: tenders total ${tenderTotal.toString()} but lines total ${lineTotal.toString()}`,
    );
  }
}

async function verifyAuthority(
  sp: Sql,
  _ctx: TenantContext,
  terminal: TerminalApplyContext,
  ticket: TicketInput,
): Promise<void> {
  await requireHuman(sp, ticket.cashierPrincipalId, "cashier");
  for (const ev of ticket.events) {
    if (
      ev.kind !== "override" ||
      ev.code !== POS_PERMISSION.ticketOverride ||
      !["discount", "void", "blind_return", "price_override"].includes(ev.subject) ||
      ev.reason.trim() === ""
    )
      throw new SyncError("ERR_VALIDATION_FAILED", "invalid override event");
    await requireHuman(sp, ev.supervisorPrincipalId, "supervisor");
    const [supervisor] =
      await sp`select 1 from app.pos_cashier where principal_id=${ev.supervisorPrincipalId} and company_id=${terminal.companyId} and branch_id=${terminal.branchId} and revoked_at is null`;
    if (!supervisor)
      throw new SyncError(
        "ERR_OVERRIDE_NOT_AUTHORISED",
        "supervisor has no live cashier credential at this branch",
      );
  }
}

async function requireHuman(sp: Sql, principalId: string, role: string): Promise<void> {
  const [row] = await sp<
    { kind: string }[]
  >`select kind from app.principal where id = ${principalId}`;
  if (row?.kind !== "human")
    throw new SyncError("ERR_RBAC_FORBIDDEN", `${role} must be a visible human principal`);
}

async function requireCustomer(
  sp: Sql,
  terminal: TerminalApplyContext,
  id: string | null,
): Promise<string | null> {
  if (id === null) return null;
  const [row] = await sp<
    { id: string }[]
  >`select id from app.party where id = ${id} and company_id = ${terminal.companyId} and kind = 'customer' and archived_at is null`;
  if (!row)
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      "customer must be an active customer of the terminal company",
    );
  return row.id;
}

async function quickCreateCustomer(
  sp: Sql,
  ctx: TenantContext,
  terminal: TerminalApplyContext,
  ticket: TicketInput,
): Promise<string | null> {
  const nc = ticket.newCustomer;
  if (nc == null) return requireCustomer(sp, terminal, ticket.customerId);
  if (ticket.customerId !== null && ticket.customerId !== nc.id) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `ticket ${ticket.clientRef}: customerId ${ticket.customerId} is not the quick-created party's id ${nc.id}`,
    );
  }
  // The receivable account is §4.15's `1200`, the same default §4.5.7 gives every party — resolved BY CODE
  // and never by a literal id, so a company that reordered its chart still resolves.
  const [account] = await sp<{ id: string }[]>`
    select id from app.account where company_id = ${terminal.companyId} and code = '1200'`;
  await sp`
    insert into app.party (id, tenant_id, company_id, kind, code, name_en, phone, receivable_account_id)
    values (${nc.id}, ${ctx.tenantId}, ${terminal.companyId}, 'customer', ${nc.code}, ${nc.nameEn},
            ${nc.phone}, ${account?.id ?? null})
    on conflict (company_id, code) do nothing`;
  const [party] = await sp<{ id: string }[]>`
    select id from app.party where company_id = ${terminal.companyId} and code = ${nc.code}`;
  // Re-sends preserve the offline identity; a competing identity cannot silently change the customer.
  if (party?.id !== nc.id)
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      "customer code already belongs to another customer identity",
    );
  return requireCustomer(sp, terminal, party.id);
}

async function insertLines(
  sp: Sql,
  ctx: TenantContext,
  companyId: string,
  documentId: string,
  ticket: TicketInput,
  returnFacts: Map<number, ReturnLineFacts>,
  promotions: ReadonlyMap<number, string>,
): Promise<void> {
  const ccy = currency(ticket.currency); // `validateShape` proved every line's currency equals it
  let lineNo = 0;
  for (const l of ticket.lines) {
    lineNo = Math.max(lineNo, l.lineNo);
    const facts = returnFacts.get(l.lineNo);
    const conversion = await itemConversion(sp, { companyId }, l);
    // ADR 0059 (owner direction 2026-10-22): the posted `discount` keeps the cash-rounding adjustment, and the
    // line records how much of it is rounding, so a report can tell rounding from a manual discount. A
    // referenced refund carries its share of the sale line's record (`prepareReturns`); a sale or blind return
    // carries the adjustment `verifyCashRounding` has already proved on its target line, and no other line.
    const rounding =
      facts?.cashRounding !== undefined
        ? Money.of(facts.cashRounding, ccy)
        : ticket.cashRounding != null && ticket.cashRounding.lineNo === l.lineNo
          ? lineCashRounding(
              Money.of(ticket.cashRounding.adjustment.amount, ccy),
              Quantity.of(l.quantity),
            )
          : Money.zero(ccy);
    // The same for a promotion (ADR 0059's PR 12 review amendment): the share `verifyPromotions` honoured on a
    // sale or blind return line, or a referenced refund's share of its sale line's record. An unproved claim
    // records nothing, so its whole discount stays the cashier's in the report as it was at the limits.
    const promotion = Money.of(facts?.promotion ?? promotions.get(l.lineNo) ?? "0.0000", ccy);
    const customFields = {
      posReturnSource: facts?.sourceDocumentId ?? null,
      posUnitConversion: conversion,
      ...(rounding.isZero() ? {} : { [CASH_ROUNDING_FIELD]: rounding.toString() }),
      ...(promotion.isZero() ? {} : { [PROMOTION_FIELD]: promotion.toString() }),
    };
    const [inserted] = await sp<{ id: string }[]>`
      insert into app.document_line (
        tenant_id, company_id, document_id, line_no, kind, item_id, lot_id, quantity, unit_quantity, unit_id,
        unit_price, discount, amount, tax_code_id, tax_amount, total_incl_tax, cost, custom_fields)
      values (${ctx.tenantId}, ${companyId}, ${documentId}, ${l.lineNo}, 'item', ${l.itemId}, ${l.lotId}, null, ${l.quantity}, ${l.unitId},
              ${l.unitPrice.amount}, ${l.discount.amount},
              ${Money.of(l.total.amount, ccy).subtract(Money.of(l.taxAmount.amount, ccy)).toString()},
              ${l.taxCodeId}, ${l.taxAmount.amount}, ${l.total.amount}, ${facts?.cost ?? null}, ${sp.json(customFields)}) returning id`;
    if (facts?.linkQuantity) {
      // `prepareReturns` has already refused changed conversion facts against the pinned ones, so a base
      // quantity the trigger converts differently from the source's proportional share is a nonintegral
      // unit's rounding residue (ADR 0056's return hardening): refused, never absorbed by the trigger.
      const [actual] = await sp<
        { quantity: string }[]
      >`select abs(quantity)::text as quantity from app.document_line where id=${inserted!.id}`;
      if (!actual || Quantity.of(actual.quantity).compare(Quantity.of(facts.linkQuantity)) !== 0)
        throw new SyncError(
          "ERR_VALIDATION_FAILED",
          `line ${l.lineNo}: ambiguous rounding — the converted base quantity is not the original sale's proportional share; return the remaining quantity whole`,
        );
    }
    if (facts?.sourceDocumentId && facts.sourceLineId)
      await linkFulfilment(sp, ctx, {
        sourceDocumentId: facts.sourceDocumentId,
        targetDocumentId: documentId,
        linkKind: "returns",
        priceFromSource: false,
        lines: [
          {
            sourceLineId: facts.sourceLineId,
            targetLineId: inserted!.id,
            quantity: facts.linkQuantity!,
          },
        ],
      });
  }
  for (const t of ticket.tenders) {
    lineNo += 1;
    // `method` is lifted out of custom_fields into LineSnapshot.tenderMethod by loadSnapshot (Task 10 Step 3),
    // which is what the policy's `when: { "line.tender_method": … }` reads. `reference` stays in the untyped
    // bag: nothing branches on it, and a card receipt number is data.
    await sp`
      insert into app.document_line (
        tenant_id, company_id, document_id, line_no, kind, amount, custom_fields)
      values (${ctx.tenantId}, ${companyId}, ${documentId}, ${lineNo}, 'tender', ${t.amount.amount},
              ${sp.json({ method: t.method, reference: t.reference })})`;
  }
  if (ticket.tenders.length === 0) {
    const gross = ticket.lines.reduce(
      (sum, l) => sum.add(Money.of(l.total.amount, ccy)),
      Money.zero(ccy),
    );
    await sp`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, amount, tax_amount, total_incl_tax, debit, credit)
      values (${ctx.tenantId}, ${companyId}, ${documentId}, ${lineNo + 1}, 'account', 0, 0, 0,
        ${gross.isNegative() ? "0.0000" : gross.toString()}, ${gross.isNegative() ? gross.abs().toString() : "0.0000"})`;
  }
}

function verifyTax(
  ticket: TicketInput,
  computed: { lineNo: number; taxAmount: string; totalInclTax: string }[],
): void {
  const ccy = currency(ticket.currency);
  const byLine = new Map(computed.map((c) => [c.lineNo, c]));
  for (let i = 0; i < ticket.lines.length; i += 1) {
    const wire = ticket.lines[i]!;
    const server = byLine.get(wire.lineNo);
    if (server === undefined)
      throw new SyncError(
        "ERR_VALIDATION_FAILED",
        `line ${wire.lineNo}: tax computation returned no line`,
      ); // refused, never skipped: an untaxed line still gets a zero-tax result, so a gap here is a line it never saw
    // Money.equals, NEVER string equality: "6.00" and "6.0000" are the same money, and a string comparison
    // would refuse every ticket a till happens to format at a different scale — which would read as a
    // protocol bug rather than a pricing one, and would be diagnosed as such for a long time.
    if (
      !Money.of(server.taxAmount, ccy).equals(Money.of(wire.taxAmount.amount, ccy)) ||
      !Money.of(server.totalInclTax, ccy).equals(Money.of(wire.total.amount, ccy))
    ) {
      throw new SyncError(
        "ERR_VALIDATION_FAILED",
        `ticket ${ticket.clientRef} line ${wire.lineNo}: the till says tax ${wire.taxAmount.amount} and this server computes ${server.taxAmount}` +
          `; re-pull the catalogue and re-price — the server does not overwrite a price the shop did not choose (SAH-020)`,
      );
    }
  }
}

/**
 * The one classifier, and `ERR_SYNC_TICKET_REJECTED` is its named default (ADR 0056).
 *
 * Every branch below maps to a code already in `ERRORS`, and the default is what keeps the `error-codes` lint
 * green for that row (§4.2.4: a code present in `ERRORS` with no raiser fails the build). `"DUPLICATE"` is a
 * sentinel and not a code: the ticket loop turns it into a `duplicate` outcome (or `ERR_CONFLICT_UNIQUE` when
 * the colliding row is not this terminal's ticket) and `runMessage` into `ERR_CONFLICT_UNIQUE`, so it never
 * reaches a needs-attention row or a wire response.
 */
function classify(e: unknown): { code: string; detail: string } {
  if (e instanceof SyncError) return { code: e.code, detail: e.detail };
  if (e instanceof PostingError) return { code: e.code, detail: e.message };
  const pg = e as { code?: string; constraint_name?: string; message?: string };
  if (pg.code === "23505" && pg.constraint_name === "document_company_id_client_ref_key") {
    return { code: "DUPLICATE", detail: "applied by a concurrent transaction" };
  }
  if (pg.code === "23505")
    return {
      code: "ERR_CONFLICT_UNIQUE",
      detail: pg.constraint_name ?? "a unique constraint was violated",
    };
  if (pg.code === "23503")
    return {
      code: "ERR_CONFLICT_REFERENCE",
      detail: pg.constraint_name ?? "a referenced row does not exist",
    };
  if (pg.code === "42501")
    return { code: "ERR_RLS_DENIED", detail: "row-level security refused this write" };
  if (pg.code === "23514") {
    // Every guard in this system raises `ERR_<CODE>: detail` as its CHECK message (plan0A:1130-1141), so the
    // token is the code: ERR_STOCK_INSUFFICIENT, ERR_OVERRIDE_NOT_AUTHORISED, ERR_PERIOD_NOT_OPEN,
    // ERR_LEDGER_UNBALANCED, ERR_ACTOR_IMMUTABLE and the rest arrive here and are passed through unchanged.
    const m = /^(ERR_[A-Z_]+):\s*(.*)$/s.exec(pg.message ?? "");
    if (m) return { code: m[1]!, detail: m[2]! };
  }
  // Named, not silent. A failure this function cannot classify is still a REFUSAL with a payload a branch
  // manager can act on — never a dropped ticket, and never a 500 that loses the sale.
  return { code: "ERR_SYNC_TICKET_REJECTED", detail: e instanceof Error ? e.message : String(e) };
}

interface ReturnLineFacts {
  cost: string;
  sourceDocumentId?: string;
  sourceLineId?: string;
  linkQuantity?: string;
  /** A referenced refund line's share of its sale line's cash rounding, in `CASH_ROUNDING_FIELD`'s stored form. */
  cashRounding?: string;
  /** Its share of the sale line's verified promotion, in `PROMOTION_FIELD`'s stored form. */
  promotion?: string;
}

/** Returns carry trusted server cost, never a wire-selected stock value. */
async function prepareReturns(
  tx: Sql,
  terminal: TerminalApplyContext,
  ticket: TicketInput,
  company: CompanyRow,
  partyId: string | null,
): Promise<Map<number, ReturnLineFacts>> {
  const facts = new Map<number, ReturnLineFacts>();
  if (ticket.kind !== "return") return facts;
  const ccy = currency(ticket.currency);
  if (ticket.returnsClientRef !== null) {
    const [source] = await tx<
      {
        id: string;
        party_id: string | null;
        currency: string;
        tendered: boolean;
        on_account: boolean;
      }[]
    >`
      select d.id, d.party_id, d.currency,
             exists (select 1 from app.document_line t where t.document_id = d.id and t.kind = 'tender') as tendered,
             exists (select 1 from app.document_line a where a.document_id = d.id and a.kind = 'account') as on_account
      from app.document d
      join app.document_type dt on dt.id = d.document_type_id
      where d.company_id = ${terminal.companyId} and d.branch_id = ${terminal.branchId}
        and d.client_ref = ${ticket.returnsClientRef} and dt.code = 'POS_TICKET' and d.status = 'posted' and d.reverses_document_id is null
        and not exists (select 1 from app.document_line x where x.document_id = d.id and x.kind = 'item' and x.quantity < 0)
      for share of d`;
    if (!source || source.party_id !== partyId || source.currency.trim() !== ticket.currency)
      fail("original sale must be posted at this branch with the same customer and currency");
    // A referenced refund settles the way its sale did (ADR 0056, 2026-10-22): a sale debited to the
    // customer's account is credited back to it with no tender, and a paid sale is refunded through tenders.
    // A tendered refund of an account sale leaves the customer holding both the refund and the debt; an
    // account credit for a paid sale turns money the drawer took into credit the customer can spend again.
    if (ticket.tenders.length === 0 && source.tendered)
      fail("a paid original sale is refunded through tenders, not to the customer's account");
    if (ticket.tenders.length > 0 && source.on_account)
      fail("an account sale is refunded to the customer's account; a tendered refund is refused");
    const sourceLines = await tx<
      {
        id: string;
        item_id: string;
        lot_id: string | null;
        unit_id: string;
        quantity: string;
        entered_quantity: string;
        unit_price: string;
        discount: string;
        amount: string;
        gross: string;
        tax_code_id: string | null;
        cost: string | null;
        custom_fields: Record<string, unknown>;
      }[]
    >`
      select id, item_id, lot_id, unit_id, quantity::text, coalesce(unit_quantity, quantity)::text as entered_quantity,
             unit_price::text, discount::text, amount::text, total_incl_tax::text as gross, tax_code_id, cost::text, custom_fields
      from app.document_line where document_id = ${source!.id} and kind = 'item' order by id`;
    for (const line of sourceLines)
      await tx`select pg_advisory_xact_lock(hashtextextended(${`document_link:${line.id}`}, 0))`;
    const seen = new Set<string>();
    for (const wire of ticket.lines) {
      const matches = sourceLines.filter(
        (l) => l.item_id === wire.itemId && l.lot_id === wire.lotId && l.unit_id === wire.unitId,
      );
      if (matches.length !== 1)
        fail(
          `line ${wire.lineNo}: original item, lot and unit must match one unambiguous source line`,
        );
      const src = matches[0]!;
      if (seen.has(src.id)) fail(`line ${wire.lineNo}: the same original line is requested twice`);
      seen.add(src.id);
      // The SAME history `computeDocumentTax`'s historical branch reads back once the refund is drafted.
      const done = await loadPosReturnHistory(tx, src.id, source!.id, null);
      if (done.untrusted || src.cost === null)
        fail(`line ${wire.lineNo}: original return history or cost is not trustworthy`);
      const conversion = await itemConversion(tx, terminal, wire);
      const pinned = src.custom_fields["posUnitConversion"] as
        | { numerator?: string; denominator?: string }
        | undefined;
      if (
        !pinned ||
        pinned.numerator !== conversion.numerator ||
        pinned.denominator !== conversion.denominator
      )
        fail(`line ${wire.lineNo}: unit conversion changed since the original sale`);
      const asked = Quantity.of(wire.quantity).negate();
      const previousEntered = Quantity.of(done.enteredQuantity);
      const sourceEntered = Quantity.of(src.entered_quantity);
      if (previousEntered.add(asked).compare(sourceEntered) > 0)
        fail(`line ${wire.lineNo}: quantity exceeds original sale's remaining return quantity`);
      // ADR 0056's cumulative ENTERED-quantity rule — the till's, and the one `computeDocumentTax` writes.
      const rule = posReturnShare(
        { quantity: Quantity.of(src.quantity), enteredQuantity: sourceEntered },
        { quantity: Quantity.of(done.quantity), enteredQuantity: previousEntered },
        asked,
      );
      const linked = rule.linked;
      const remaining = Quantity.of(src.quantity).subtract(Quantity.of(done.quantity));
      if (linked.isZero() || linked.isNegative() || linked.compare(remaining) > 0)
        fail(`line ${wire.lineNo}: quantity exceeds original sale's remaining return quantity`);
      // ADR 0056 refuses a nonintegral unit's rounding residue rather than change the quantity trigger: the
      // trigger's own conversion (0032) of this entered quantity must BE the linked share. Asked here, before
      // anything is drafted, so the refusal can name both figures — returning the remainder whole is not
      // always the way out (seven thirds returned as 2 then 5 leave 1.666666 where 5 thirds are 1.666667).
      const [converted] = await tx<{ quantity: string }[]>`
        select round(${asked.toString()}::numeric * ${conversion.numerator}::numeric
                     / ${conversion.denominator}::numeric, 6)::text as quantity`;
      if (Quantity.of(converted!.quantity).compare(linked) !== 0)
        fail(
          `line ${wire.lineNo}: ambiguous rounding — ${asked.toString()} of this unit is ${converted!.quantity} ` +
            `base units, but the original sale's proportional share is ${linked.toString()}; return the ` +
            "remaining quantity in a different split",
        );
      const share = (full: string, previous: string) =>
        rule.share(Money.of(full, ccy), Money.of(previous, ccy));
      const gross = share(src.gross, done.gross);
      const net = share(src.amount, done.net);
      if (
        !Money.of(wire.unitPrice.amount, ccy).equals(Money.of(src.unit_price, ccy)) ||
        wire.taxCodeId !== src.tax_code_id ||
        !Money.of(wire.discount.amount, ccy).equals(share(src.discount, done.discount).negate()) ||
        !Money.of(wire.total.amount, ccy).equals(gross.negate()) ||
        !Money.of(wire.taxAmount.amount, ccy).equals(gross.subtract(net).negate())
      )
        fail(
          `line ${wire.lineNo}: refund must preserve the original price, discount, gross and tax facts`,
        );
      const cost = share(src.cost!, done.cost);
      if (cost.isNegative()) fail(`line ${wire.lineNo}: remaining source cost is negative`);
      // The refund gives back its share of the sale's cash rounding by the SAME cumulative rule as the discount
      // it carries, the completing refund taking the exact residue (ADR 0059, 2026-10-22). The sale line's
      // record and every refund line's are in the line-direction form, so the share is stored as computed.
      const sourceRounding = src.custom_fields[CASH_ROUNDING_FIELD] ?? "0.0000";
      if (typeof sourceRounding !== "string")
        fail(`line ${wire.lineNo}: original cash-rounding record is not trustworthy`);
      const rounding = share(sourceRounding, done.cashRounding);
      // And of its verified promotion, by the same rule (ADR 0059's PR 12 review amendment).
      const sourcePromotion = src.custom_fields[PROMOTION_FIELD] ?? "0.0000";
      if (typeof sourcePromotion !== "string")
        fail(`line ${wire.lineNo}: original promotion record is not trustworthy`);
      const promotion = share(sourcePromotion, done.promotion);
      facts.set(wire.lineNo, {
        cost: cost.toString(),
        sourceDocumentId: source!.id,
        sourceLineId: src.id,
        linkQuantity: linked.toString(),
        cashRounding: rounding.toString(),
        promotion: promotion.toString(),
      });
    }
    return facts;
  }
  const sentinels = await loadSentinelLots(
    tx,
    ticket.lines.map((l) => l.itemId),
  );
  const keys = ticket.lines.map((l) => ({
    itemId: l.itemId,
    warehouseId: company.posWarehouseId,
    lotId: l.lotId ?? sentinels.get(l.itemId) ?? "",
  }));
  if (keys.some((k) => k.lotId === "")) fail("blind return item has no stock lot");
  await lockStockKeys(tx, terminal.companyId, keys);
  for (const wire of ticket.lines) {
    const layers = await openLayersFor(tx, {
      companyId: terminal.companyId,
      itemId: wire.itemId,
      warehouseId: company.posWarehouseId,
      baseCurrency: ccy,
    });
    if (layers.length === 0)
      fail(`line ${wire.lineNo}: blind return has no valid server cost layer`);
    const [converted] = await tx<{ quantity: string }[]>`
      select round(abs(${wire.quantity}::numeric) * case when i.base_unit_id=${wire.unitId} then 1 else u.numerator::numeric/u.denominator::numeric end,6)::text as quantity
      from app.item i left join app.unit_conversion u on u.item_id=i.id and u.unit_id=${wire.unitId}
      where i.id=${wire.itemId} and i.company_id=${terminal.companyId}`;
    if (!converted?.quantity) fail(`line ${wire.lineNo}: unit cannot be converted for this item`);
    const cost = costingEngine
      .average(layers, ccy)
      .multiply(converted!.quantity, "HALF_AWAY_FROM_ZERO");
    facts.set(wire.lineNo, { cost: cost.toString() });
  }
  return facts;
}

async function runMessage(
  tx: Sql,
  ref: string,
  body: (sp: Sql) => Promise<MessageOutcome>,
): Promise<MessageOutcome> {
  try {
    return await (tx as unknown as TransactionSql).savepoint(async (sp) => {
      const answer = await body(sp as unknown as Sql);
      await sp`set constraints all immediate`;
      await sp`set constraints all deferred`;
      return answer;
    });
  } catch (error) {
    if (["40P01", "40001"].includes(String((error as { code?: string }).code))) throw error;
    const { code, detail } = classify(error);
    return {
      ref,
      status: "rejected",
      error: { code: code === "DUPLICATE" ? "ERR_CONFLICT_UNIQUE" : code, detail },
    };
  }
}
