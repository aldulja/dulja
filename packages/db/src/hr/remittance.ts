import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { readSchedule, type ScheduleScope, type StatutoryScheduleResult } from "./schedule";

/**
 * 8C T8 — remittance settlement (spec:2082: "statutory remittances as ordinary PAYMENT documents to each authority
 * modelled as a vendor party, refused if the amount differs from the schedule they settle").
 *
 * **Migration 0091's trigger is the control** for the amount: `app.assert_remittance_matches_schedule()` compares the
 * payment's own `1100` leg with `total_employee + total_employer` on every write of the link or the totals, whoever
 * writes them. This file deliberately does NOT recompute that comparison — two implementations of one arithmetic are
 * the drift hazard 9 forbids — and checks only what the trigger cannot know: that the schedule is in the caller's
 * company, that it is not already settled, that the payment is an ordinary `PAYMENT` to the scheme's authority party,
 * and that the payment settles no other schedule (0091's `statutory_schedule_remittance_key` is the backstop).
 */
export type RemittanceErrorCode =
  | "ERR_NOT_FOUND"
  | "ERR_PAYROLL_REMITTANCE_MISMATCH"
  | "ERR_VALIDATION_FAILED";

export class RemittanceError extends Error {
  constructor(
    readonly code: RemittanceErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "RemittanceError";
  }
}

export interface SettleScheduleInput extends ScheduleScope {
  scheduleId: string;
  remittanceDocumentId: string;
}

export interface UnsettleScheduleInput extends ScheduleScope {
  scheduleId: string;
  /** Required and non-blank, so a caller must state one. No column stores it: `app.audit_log` carries who, when and
   *  the before/after image of the link, and the reason is the caller's to log (a recorded limit, 8C T8). */
  reason: string;
}

interface ScheduleLock {
  id: string;
  company_id: string;
  remittance_document_id: string | null;
  authority_party_id: string | null;
  scheme_code: string;
}

async function lockSchedule(
  tx: Sql,
  scheduleId: string,
  scope: ScheduleScope,
): Promise<ScheduleLock> {
  const [row] = await tx<ScheduleLock[]>`
    select ss2.id, ss2.company_id, ss2.remittance_document_id, sc.authority_party_id, sc.code as scheme_code
      from app.statutory_schedule ss2
      join app.statutory_scheme sc on sc.id = ss2.scheme_id
     where ss2.id = ${scheduleId}
       and (${scope.companyId ?? null}::uuid is null or ss2.company_id = ${scope.companyId ?? null}::uuid)
     for update of ss2`;
  if (!row) {
    throw new RemittanceError("ERR_NOT_FOUND", `statutory schedule ${scheduleId} is not visible`);
  }
  return row;
}

/** Links the settling PAYMENT. The 0091 TRIGGER is the control; this is the better error message. */
export async function settleStatutorySchedule(
  tx: Sql,
  _ctx: TenantContext,
  input: SettleScheduleInput,
): Promise<StatutoryScheduleResult> {
  const schedule = await lockSchedule(tx, input.scheduleId, input);
  if (schedule.remittance_document_id !== null) {
    throw new RemittanceError(
      "ERR_VALIDATION_FAILED",
      `statutory schedule ${input.scheduleId} is already settled by payment ${schedule.remittance_document_id}; unsettle it first`,
    );
  }

  const [payment] = await tx<{ type_code: string; party_id: string | null; company_id: string }[]>`
    select t.code as type_code, d.party_id, d.company_id
      from app.document d join app.document_type t on t.id = d.document_type_id
     where d.id = ${input.remittanceDocumentId}`;
  if (!payment || payment.company_id !== schedule.company_id) {
    throw new RemittanceError(
      "ERR_NOT_FOUND",
      `payment ${input.remittanceDocumentId} is not visible in the schedule's company`,
    );
  }
  // spec:2082: a remittance is an ORDINARY `PAYMENT` to the authority. A PAYROLL_PAYMENT batch or a journal whose
  // bank leg happens to equal the total is not one, and the amount guard alone would let it through.
  if (payment.type_code !== "PAYMENT") {
    throw new RemittanceError(
      "ERR_VALIDATION_FAILED",
      `document ${input.remittanceDocumentId} is a ${payment.type_code}; a statutory remittance is a PAYMENT`,
    );
  }
  if (schedule.authority_party_id !== null && payment.party_id !== schedule.authority_party_id) {
    throw new RemittanceError(
      "ERR_VALIDATION_FAILED",
      `payment ${input.remittanceDocumentId} is not made to scheme ${schedule.scheme_code}'s authority party`,
    );
  }
  const [other] = await tx<{ id: string }[]>`
    select id from app.statutory_schedule
     where remittance_document_id = ${input.remittanceDocumentId} and id <> ${input.scheduleId}`;
  if (other) {
    throw new RemittanceError(
      "ERR_VALIDATION_FAILED",
      `payment ${input.remittanceDocumentId} already settles statutory schedule ${other.id}; one payment settles one schedule`,
    );
  }

  // The trigger raises ERR_PAYROLL_REMITTANCE_MISMATCH here when the payment's bank leg is not the schedule total.
  await tx`
    update app.statutory_schedule
       set remittance_document_id = ${input.remittanceDocumentId}
     where id = ${input.scheduleId}`;
  return readSchedule(tx, input.scheduleId, input);
}

/**
 * Clears the link. A mis-linked payment is UNLINKED, never edited and never deleted (spec:2049); the payment itself
 * stays posted and, if it was wrong, is reversed as its own document. `app.audit_log` carries the before/after image
 * with the acting principal. There is no route for it in v1 (round 18 B10 fixes the module at five routes).
 */
export async function unsettleStatutorySchedule(
  tx: Sql,
  _ctx: TenantContext,
  input: UnsettleScheduleInput,
): Promise<StatutoryScheduleResult> {
  if (input.reason.trim().length === 0) {
    throw new RemittanceError("ERR_VALIDATION_FAILED", "unsettling a schedule needs a reason");
  }
  const schedule = await lockSchedule(tx, input.scheduleId, input);
  if (schedule.remittance_document_id === null) {
    throw new RemittanceError(
      "ERR_NOT_FOUND",
      `statutory schedule ${input.scheduleId} is not visible or is not settled`,
    );
  }
  await tx`
    update app.statutory_schedule set remittance_document_id = null where id = ${input.scheduleId}`;
  return readSchedule(tx, input.scheduleId, input);
}
