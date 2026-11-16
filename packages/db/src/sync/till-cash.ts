import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import { recordOverride } from "../posting/lifecycle";
import {
  buildTillDocument,
  resolveAccountByCode,
  tillEffectiveDate,
  type TillDocumentKind,
} from "../posting/till";
import { SyncError } from "./enrolment";
import { assertShiftKnown, moneyFromMessage } from "./shifts";
import { POS_PERMISSION } from "./authority";
import type { MessageOutcome, TerminalApplyContext } from "./apply";
import type { TenantContext } from "../with-tenant";

/**
 * ⚠️ OD-10 (answered yes, 2026-11-04 — `docs/owner/od-10/decision.md`). The db-tier twin of
 * `@dulja/sync`'s `TillCashMsg`: `kind` is `string` because §3.1 forbids `packages/db` importing
 * `@dulja/sync`, so this is a structural twin the wire type satisfies (6A's `TicketInput` precedent).
 */
export interface TillCashInput {
  clientRef: string;
  shiftId: string;
  kind: string;
  amount: { amount: string; currency: string };
  cashierPrincipalId: string;
  supervisorPrincipalId: string | null;
  occurredAt: string;
  reference: string | null;
  fromSafe: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §4.10.1's ack key for a cash event: the till's own `clientRef`. An unkeyable message acks as `""`,
 *  which matches no outbox row, so the till keeps it pending — `tillEventRef`'s shape. */
export function cashEventRef(m: unknown): string {
  return String(((m ?? {}) as Record<string, unknown>).clientRef ?? "");
}

/** kind → the §4.14 type code, the §4.15 debit code, and how the credit code is chosen. ADR 0064's table
 *  in one place, so no caller re-derives it. `banking`'s credit depends on `fromSafe`. */
const CASH_EVENT: Readonly<
  Record<
    string,
    {
      typeCode: string;
      kind: TillDocumentKind;
      debit: string;
      credit: (fromSafe: boolean) => string;
    }
  >
> = {
  paid_out: { typeCode: "TILL_PAID_OUT", kind: "paid_out", debit: "5130", credit: () => "1110" },
  safe_drop: { typeCode: "TILL_SAFE_DROP", kind: "safe_drop", debit: "1130", credit: () => "1110" },
  banking: {
    typeCode: "TILL_BANKING",
    kind: "banking",
    debit: "1100",
    credit: (fromSafe) => (fromSafe ? "1130" : "1110"),
  },
};

/** The till-cash §4.14 type codes, so the dedup read can tell a re-sent cash event from a reference that
 *  names some other document of the company. */
const CASH_TYPE_CODES = Object.values(CASH_EVENT).map((e) => e.typeCode);

/**
 * The authority and limit checks a cash event needs — 6C's `verifyTillVoid` shape, applied to cash.
 *
 * **Every kind needs a live cashier of this branch holding `pos.shift.own`, and that cashier must be the
 * shift's own** (`app.shift.opened_principal_id`): a cash event is an act on one's own drawer. Another live
 * cashier of the branch is refused `ERR_RBAC_FORBIDDEN` — otherwise their paid-out would post against a
 * drawer they never held, under a limit they do not answer for, and the shift's owner would absorb it in
 * their over/short (ADR 0064's 2026-11-07 amendment). The approving supervisor of a paid-out above the limit
 * is a different principal by design (OD-10 fact 1) and is checked separately below.
 *
 * **Only `paid_out` is limited, and that is the owner's decision** (OD-10 facts 1 and 2): a safe drop and
 * a banking move the company's own cash between its own containers, and a safe drop lowers the cash at risk
 * in the drawer, so a shop's control interest is in making them easy. A paid-out is the only one where cash
 * leaves the company: 6C's `branch_pos_policy` carries `paid_out_allowed` and `max_paid_out_amount` for it
 * (migration 0066), and above the limit a DIFFERENT live principal holding `pos.ticket.override` must
 * authorise it. A paid-out also needs a reference (OD-10 fact 4).
 *
 * **Read the policy ROW, never the cashier snapshot** (spec:1324, ADR 0061).
 *
 * Returns whether a supervisor's override lifted the limit, so the caller records it on the document.
 */
export async function verifyCashEvent(
  sp: Sql,
  terminal: TerminalApplyContext,
  msg: TillCashInput,
  amount: Money,
  shiftCashierPrincipalId: string,
): Promise<{ overridden: boolean }> {
  const at = `cash event ${msg.clientRef}`;
  const [cashier] = await sp<{ allowed: boolean }[]>`
    select app.principal_has(${msg.cashierPrincipalId}, ${POS_PERMISSION.shiftOwn},
                             ${terminal.companyId}, ${terminal.branchId}) as allowed
      from app.pos_cashier
     where principal_id = ${msg.cashierPrincipalId} and company_id = ${terminal.companyId}
       and branch_id = ${terminal.branchId} and revoked_at is null`;
  if (!cashier?.allowed) {
    throw new SyncError(
      "ERR_RBAC_FORBIDDEN",
      `${at}: principal ${msg.cashierPrincipalId} is not a live cashier holding ${POS_PERMISSION.shiftOwn}` +
        ` at branch ${terminal.branchId}; a cash event is an act on one's own drawer`,
    );
  }
  if (msg.cashierPrincipalId !== shiftCashierPrincipalId) {
    throw new SyncError(
      "ERR_RBAC_FORBIDDEN",
      `${at}: principal ${msg.cashierPrincipalId} is not the shift's own cashier (shift ${msg.shiftId} was` +
        ` opened by ${shiftCashierPrincipalId}); a cash event is an act on one's own drawer`,
    );
  }
  if (msg.kind !== "paid_out") {
    if (msg.supervisorPrincipalId !== null) {
      throw new SyncError(
        "ERR_VALIDATION_FAILED",
        `${at}: a ${msg.kind} is the cashier's own act and carries no supervisor approval`,
      );
    }
    return { overridden: false };
  }

  if (msg.reference === null || msg.reference.trim() === "") {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: a paid_out needs a reference (the supplier receipt or voucher number) — OD-10`,
    );
  }

  const [policy] = await sp<{ allowed: boolean; max_amount: string }[]>`
    select paid_out_allowed as allowed, max_paid_out_amount::text as max_amount
      from app.branch_pos_policy
     where company_id = ${terminal.companyId} and branch_id = ${terminal.branchId}`;
  // No row means the closed defaults, exactly as 6C decided: a branch with no policy permits nothing.
  if (!policy || policy.allowed === false) {
    throw new SyncError(
      "ERR_POS_LIMIT_EXCEEDED",
      `${at}: branch ${terminal.branchId} does not allow paid_out (branch_pos_policy.paid_out_allowed)`,
    );
  }
  const limit = Money.of(policy.max_amount, currency(amount.currency));
  if (amount.compare(limit) <= 0) {
    if (msg.supervisorPrincipalId !== null) {
      throw new SyncError(
        "ERR_VALIDATION_FAILED",
        `${at}: ${amount.toString()} is within the branch max_paid_out_amount ${limit.toString()};` +
          ` a supervisor approval is only sent above it`,
      );
    }
    return { overridden: false };
  }
  if (msg.supervisorPrincipalId === null) {
    throw new SyncError(
      "ERR_POS_LIMIT_EXCEEDED",
      `${at}: ${amount.toString()} exceeds branch ${terminal.branchId}'s max_paid_out_amount` +
        ` ${limit.toString()}; a different supervisor holding ${POS_PERMISSION.ticketOverride} must approve`,
    );
  }
  if (msg.supervisorPrincipalId === msg.cashierPrincipalId) {
    throw new SyncError(
      "ERR_OVERRIDE_NOT_AUTHORISED",
      `${at}: paid-out approval requires a different supervisor`,
    );
  }
  const [supervisor] = await sp<{ allowed: boolean }[]>`
    select app.principal_has(${msg.supervisorPrincipalId}, ${POS_PERMISSION.ticketOverride},
                             ${terminal.companyId}, ${terminal.branchId}) as allowed
      from app.pos_cashier
     where principal_id = ${msg.supervisorPrincipalId} and company_id = ${terminal.companyId}
       and branch_id = ${terminal.branchId} and revoked_at is null`;
  if (!supervisor?.allowed) {
    throw new SyncError(
      "ERR_OVERRIDE_NOT_AUTHORISED",
      `${at}: supervisor ${msg.supervisorPrincipalId} lacks live ${POS_PERMISSION.ticketOverride} authority` +
        ` at branch ${terminal.branchId}`,
    );
  }
  return { overridden: true };
}

/**
 * One cash event: dedup on the document's `client_ref`, verify, post through `buildTillDocument`.
 *
 * Dedup reads `app.document` and not a table of its own, because a cash event **is** a document and
 * `unique (company_id, client_ref)` is already the key 6A's tickets dedup on. The dedup read comes before
 * the open-shift check so a re-send after the close still answers `duplicate`.
 */
export async function applyCashEvent(
  sp: Sql,
  ctx: TenantContext,
  terminal: TerminalApplyContext,
  msg: TillCashInput,
): Promise<MessageOutcome> {
  const ref = cashEventRef(msg);
  const at = `cash event ${msg.clientRef}`;

  if (!UUID_RE.test(String(msg.clientRef))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: clientRef is not a uuid`);
  }
  const spec = CASH_EVENT[msg.kind];
  if (!spec) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: kind must be paid_out, safe_drop or banking, received ${JSON.stringify(msg.kind)}`,
    );
  }
  if (!UUID_RE.test(String(msg.cashierPrincipalId))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: cashierPrincipalId is not a uuid`);
  }
  if (msg.supervisorPrincipalId !== null && !UUID_RE.test(String(msg.supervisorPrincipalId))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: supervisorPrincipalId is not a uuid`);
  }
  if (Number.isNaN(Date.parse(String(msg.occurredAt)))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: occurredAt is not an ISO 8601 timestamp`);
  }
  if (msg.kind !== "banking" && msg.fromSafe === true) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: only a banking may take cash out of the safe; a ${msg.kind} always leaves the drawer`,
    );
  }

  const [existing] = await sp<{ terminal_id: string | null; code: string }[]>`
    select d.terminal_id::text, t.code
      from app.document d join app.document_type t on t.id = d.document_type_id
     where d.company_id = ${terminal.companyId} and d.client_ref = ${msg.clientRef}`;
  if (existing) {
    if (existing.terminal_id !== terminal.terminalId || !CASH_TYPE_CODES.includes(existing.code)) {
      throw new SyncError(
        "ERR_CONFLICT_REFERENCE",
        `${at}: clientRef already names a ${existing.code} that is not a cash event of this terminal`,
      );
    }
    return { ref, status: "duplicate", error: null };
  }

  await assertShiftKnown(sp, terminal, msg.shiftId);
  const [shift] = await sp<{ currency: string; opened_principal_id: string }[]>`
    select currency, opened_principal_id::text from app.shift where id = ${msg.shiftId}`;
  const amount = moneyFromMessage(msg.amount, "amount", shift!.currency, at);
  if (amount.isZero() || amount.isNegative()) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: amount must be a positive magnitude, received ${msg.amount.amount}`,
    );
  }
  const reference = msg.reference?.trim() ? msg.reference.trim() : null;

  const { overridden } = await verifyCashEvent(
    sp,
    terminal,
    msg,
    amount,
    shift!.opened_principal_id,
  );

  const result = await buildTillDocument(sp, ctx, terminal, {
    kind: spec.kind,
    typeCode: spec.typeCode,
    shiftId: msg.shiftId,
    amount,
    debitAccountCode: spec.debit,
    creditAccountCode: spec.credit(msg.fromSafe === true),
    effectiveDate: await tillEffectiveDate(sp, terminal.companyId, msg.occurredAt),
    attributedTo: msg.cashierPrincipalId,
    description:
      reference === null
        ? `${spec.typeCode} on shift ${msg.shiftId}`
        : `${spec.typeCode} on shift ${msg.shiftId} — ${reference}`,
    clientRef: msg.clientRef,
  });

  if (overridden) {
    // 2B's `assert_override_authorised` re-checks the supervisor's code at the document's branch and that
    // they are neither its creator (the terminal) nor its attributed cashier — the same guard a void meets.
    await recordOverride(sp, ctx, {
      documentId: result.documentId,
      code: "pos.ticket.override",
      attributedTo: msg.supervisorPrincipalId!,
      reason: `paid_out: ${reference}`,
    });
  }

  await afterCashEvent(sp, terminal, msg, result.documentId, amount, reference);
  return { ref, status: "accepted", error: null };
}

/**
 * A banking gets an `app.till_banking_link` row (6D Task 11, migration 0071); the other two kinds get
 * nothing, because their document says everything there is to say. The bank account is resolved from
 * `1100` by code — the same account the policy's debit leg used, read once so the link and the ledger
 * cannot disagree. The link carries the one fact no ledger leg does: the shift (amendment A16).
 */
async function afterCashEvent(
  sp: Sql,
  terminal: TerminalApplyContext,
  msg: TillCashInput,
  documentId: string,
  amount: Money,
  reference: string | null,
): Promise<void> {
  if (msg.kind !== "banking") return;
  const bankAccountId = await resolveAccountByCode(sp, terminal.companyId, "1100");
  await sp`
    insert into app.till_banking_link (tenant_id, company_id, branch_id, banking_document_id, shift_id,
                                       bank_account_id, from_safe, value_date, amount, currency, reference)
    select app.current_tenant(), d.company_id, d.branch_id, d.id, d.shift_id, ${bankAccountId},
           ${msg.fromSafe === true}, d.effective_date, ${amount.toString()}::numeric, d.currency, ${reference}
      from app.document d
     where d.id = ${documentId}`;
}
