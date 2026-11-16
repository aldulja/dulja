import { Money, currency } from "@dulja/domain";
import { reverseDocument } from "../posting/reverse";
import { setEventContext, recordOverride } from "../posting/lifecycle";
import { tillEffectiveDate } from "../posting/till";
import { verifyTillVoid } from "./limits";
import type { Sql } from "postgres";
import { SyncError } from "./enrolment";
import { assertShiftKnown } from "./shifts";
import type { MessageOutcome, TerminalApplyContext } from "./apply";
import type { TenantContext } from "../with-tenant";

export interface TillEventInput {
  clientRef: string;
  shiftId: string;
  kind: string;
  ticketClientRef: string | null;
  cashierPrincipalId: string;
  supervisorPrincipalId: string | null;
  occurredAt: string;
  reason?: string | null;
}

const KINDS = new Set(["no_sale", "drawer_open", "void"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §4.10.1's ack key. An unkeyable message acks as `""`, which matches no outbox row, so the till keeps
 *  it pending — the safe direction (spec:1337), and the same shape as `shiftRef`. */
export function tillEventRef(m: unknown): string {
  return String(((m ?? {}) as Record<string, unknown>).clientRef ?? "");
}

/**
 * One append-only event.
 *
 * **Idempotent on `client_ref`, which §4.6.1 makes globally unique** — not `(company_id, client_ref)`.
 * The ref is the till's own uuidv7, so a collision across companies is not a real event, and the global
 * key means the dedup read needs no company in hand. Read-then-insert with `on conflict do nothing`, so
 * both the common case and the concurrent race answer `duplicate` (6A's `applyTicket` step (a) shape).
 *
 * **A `void` names its ticket by CLIENT REF and this function resolves it.** The till minted that ref
 * offline and has no document id; storing the ref would leave the join to every future reader, and
 * `till_event.ticket_document_id` has a composite FK to `app.document` that a ref cannot satisfy. A void
 * whose ticket the server has never seen is **rejected** rather than stored with a null: the till will
 * re-send both, and till events run after tickets and before closes in the batch (Task 3 step 3d) precisely so a void and its ticket
 * can arrive together.
 */
export async function applyTillEvent(
  sp: Sql,
  ctx: TenantContext,
  terminal: TerminalApplyContext,
  msg: TillEventInput,
): Promise<MessageOutcome> {
  const ref = tillEventRef(msg);
  const at = `till event ${msg.clientRef}`;

  if (!UUID_RE.test(String(msg.clientRef))) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: clientRef is not a uuid — the till mints it (§4.10.1)`,
    );
  }
  if (!KINDS.has(msg.kind)) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: kind must be no_sale, drawer_open or void, received ${JSON.stringify(msg.kind)}`,
    );
  }
  if (msg.kind !== "void" && msg.ticketClientRef !== null && msg.ticketClientRef !== undefined) {
    // The DDL says the same thing (`till_event_ticket_only_on_void`), and refusing here gives the till a
    // sentence instead of a constraint name. Both are kept: the CHECK guards every other writer.
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: only a void names a ticket; a ${msg.kind} is about the drawer and carries ticketClientRef null`,
    );
  }
  if (!UUID_RE.test(String(msg.cashierPrincipalId))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: cashierPrincipalId is not a uuid`);
  }
  if (Number.isNaN(Date.parse(String(msg.occurredAt)))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: occurredAt is not an ISO 8601 timestamp`);
  }

  const [existing] = await sp<
    { id: string; terminal_id: string; branch_id: string }[]
  >`select id,terminal_id,branch_id from app.till_event where client_ref=${msg.clientRef}`;
  if (existing) {
    if (existing.terminal_id !== terminal.terminalId || existing.branch_id !== terminal.branchId)
      throw new SyncError("ERR_CONFLICT_REFERENCE", "event belongs to another terminal or branch");
    return { ref, status: "duplicate", error: null };
  }
  await assertShiftKnown(sp, terminal, msg.shiftId);
  if (msg.kind !== "void") {
    if (msg.supervisorPrincipalId !== null)
      throw new SyncError(
        "ERR_VALIDATION_FAILED",
        "drawer events do not carry supervisor approval",
      );
    const [cashier] = await sp<
      { allowed: boolean }[]
    >`select app.principal_has(${msg.cashierPrincipalId}, 'pos.shift.own', ${terminal.companyId}, ${terminal.branchId}) allowed from app.pos_cashier where principal_id=${msg.cashierPrincipalId} and company_id=${terminal.companyId} and branch_id=${terminal.branchId} and revoked_at is null`;
    if (!cashier?.allowed)
      throw new SyncError(
        "ERR_RBAC_FORBIDDEN",
        "drawer event requires a live branch cashier with pos.shift.own",
      );
  }

  let ticketDocumentId: string | null = null;
  if (msg.kind === "void") {
    if (!UUID_RE.test(String(msg.ticketClientRef))) {
      throw new SyncError(
        "ERR_VALIDATION_FAILED",
        `${at}: a void requires ticketClientRef as a uuid`,
      );
    }
    const [doc] = await sp<{ id: string; currency: string; gross: string }[]>`
      select d.id,d.currency,(select coalesce(sum(l.total_incl_tax),0)::text from app.document_line l where l.document_id=d.id and l.kind='item') gross from app.document d join app.document_type t on t.id=d.document_type_id
       where d.company_id = ${terminal.companyId} and d.client_ref = ${msg.ticketClientRef} and d.terminal_id=${terminal.terminalId} and d.shift_id=${msg.shiftId} and t.code='POS_TICKET' and d.status='posted' `;
    if (!doc) {
      throw new SyncError(
        "ERR_CONFLICT_REFERENCE",
        `${at}: ticketClientRef ${msg.ticketClientRef} names no ticket in company ${terminal.companyId};` +
          ` send the ticket in this batch or before it — till events are applied after tickets (§4.10.1)`,
      );
    }
    const reason = msg.reason ?? "";
    await verifyTillVoid(
      sp,
      { companyId: terminal.companyId, branchId: terminal.branchId, currency: doc.currency },
      {
        cashierPrincipalId: msg.cashierPrincipalId,
        supervisorPrincipalId: msg.supervisorPrincipalId,
        amount: Money.of(doc.gross, currency(doc.currency)),
        reason,
      },
    );
    if (msg.supervisorPrincipalId !== null)
      await recordOverride(sp, ctx, {
        documentId: doc.id,
        code: "pos.ticket.override",
        attributedTo: msg.supervisorPrincipalId,
        reason,
      });
    await setEventContext(sp, { reason, attributedTo: msg.cashierPrincipalId });
    await reverseDocument(sp, ctx, {
      documentId: doc.id,
      effectiveDate: await tillEffectiveDate(sp, terminal.companyId, msg.occurredAt),
      reason,
      // The mirror puts the ticket's stock back, so a later-dated movement of the item makes it back-dated and
      // postDocument (step 14) enqueues the cost replay through this client — exactly as the ticket's own post
      // does in apply.ts. Without it every such void was refused ERR_INTERNAL on every resend (review MON-05).
      ...(terminal.jobs === undefined ? {} : { jobs: terminal.jobs }),
    });
    ticketDocumentId = doc.id;
  }

  const inserted = await sp<{ id: string }[]>`
    insert into app.till_event (tenant_id, company_id, branch_id, terminal_id, shift_id, kind,
                                ticket_document_id, cashier_principal_id, supervisor_principal_id,
                                occurred_at, client_ref, reason)
    values (app.current_tenant(), ${terminal.companyId}, ${terminal.branchId}, ${terminal.terminalId},
            ${msg.shiftId}, ${msg.kind}, ${ticketDocumentId}, ${msg.cashierPrincipalId},
            ${msg.supervisorPrincipalId ?? null}, ${msg.occurredAt}::timestamptz, ${msg.clientRef}, ${msg.reason ?? null})
    returning id`;

  return { ref, status: inserted.length === 1 ? "accepted" : "duplicate", error: null };
}
