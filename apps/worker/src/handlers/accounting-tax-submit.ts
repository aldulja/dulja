// apps/worker/src/handlers/accounting-tax-submit.ts (5B)
//
// spec:2356 lists "tax submission" among apps/worker's handlers. spec:2225 asks for "retry and
// status reconciliation"; contracts amendment 2 carries both on one JOBS name through `phase`.
//
// Transient (5xx, timeout, connection) -> THROW, so pg-boss retries with retryLimit 8 and its own
// exponential backoff. Everything else -> return, because a refusal is an outcome and retrying it
// eight times is how an integration gets rate-limited off an authority's platform (ADR 0053).

import {
  EInvoiceError,
  getTransmission,
  pollTransmission,
  submitTransmission,
  UNADDRESSED_ACKNOWLEDGEMENT_PREFIX,
  withTenant,
  type JobEnvelope,
  type TenantContext,
} from "@dulja/db";
import type { Sql } from "postgres";
import type { JobHandler } from "../handler";
import { jobs } from "../jobs";
import { log } from "../log";

/** Automatic polling stops at twelve total calls, including submission and transient retries.
 *  The submitted row remains available for operator reconciliation through
 *  `POST /v1/companies/{companyId}/einvoice-transmissions/{transmissionId}/poll`, which this limit
 *  does not bind (ADR 0053, amendment 2026-10-06). */
export const POLL_LIMIT = 12;

/** 60 · 2^attempts, capped at one hour. */
export function pollDelaySeconds(attempts: number): number {
  const raw = 60 * 2 ** Math.max(0, Math.min(attempts, 20));
  return Math.min(raw, 3600);
}

export const accountingTaxSubmit: JobHandler<"accounting.tax.submit"> = async (
  sql: Sql,
  job: JobEnvelope<{ transmissionId: string; phase: "submit" | "poll" }>,
  ctx: TenantContext,
): Promise<void> => {
  const { transmissionId, phase } = job.payload;
  if (typeof transmissionId !== "string" || (phase !== "submit" && phase !== "poll")) return;
  const logger = log().child({ job: "accounting.tax.submit", transmissionId, phase });

  // pg-boss delivers at least once, and a transmission may have been settled by the manual route
  // between the enqueue and the delivery. A job for a row that is gone, invisible under RLS, or no
  // longer in a legal state for its phase is a NO-OP: throwing would burn the retry budget on a
  // settled row and would make a cross-tenant payload look like an outage (test 12's job half).
  let current;
  try {
    current = await withTenant(sql, ctx, (tx) => getTransmission(tx, transmissionId));
  } catch (e) {
    if (e instanceof EInvoiceError && e.code === "ERR_NOT_FOUND") {
      logger.info({}, "transmission not visible to this tenant — nothing to do");
      return;
    }
    throw e;
  }
  const companyId = current.companyId;
  // The operator's way forward, named in the row itself whenever this handler stops polling: the
  // route is the only verb that reaches a `submitted` row once it does, and it is not bound by
  // POLL_LIMIT.
  const operatorPoll = `POST /v1/companies/${companyId}/einvoice-transmissions/${transmissionId}/poll`;

  const recordPollLimit = async (attempts: number): Promise<void> => {
    const marker = `poll limit reached after ${attempts} attempts; the authority has not resolved this transmission — reconcile it with ${operatorPoll}`;
    // The marker LEADS and the authority's last answer follows it: the twelfth poll's diagnostic (an
    // unmapped label, a 403's body) is why the row never resolved, and `response` is not on the
    // wire. A row that already carries the marker — a duplicate delivery, or this early-return path
    // again — keeps it as it is, so the text never nests. `claimed_at is null`: never under a live
    // claim, whose own record is about to land.
    await withTenant(sql, ctx, async (tx) => {
      await tx`
        update app.einvoice_transmission
           set last_error = case
                 when last_error like 'poll limit reached%' then last_error
                 else left(${marker} || coalesce('; last answer: ' || last_error, ''), 2000)
               end
         where id = ${transmissionId} and status = 'submitted' and claimed_at is null`;
    });
    logger.warn(
      { attempts, operatorPoll },
      "poll limit reached — the row stays submitted and automatic polling stops; an operator reconciles it with the poll route",
    );
  };

  // Check before calling, including on pg-boss retries and duplicate deliveries.
  if (phase === "poll" && current.status === "submitted" && current.attempts >= POLL_LIMIT) {
    await recordPollLimit(current.attempts);
    return;
  }

  const enqueuePoll = async (attempts: number): Promise<void> => {
    if (attempts >= POLL_LIMIT) {
      await recordPollLimit(attempts);
      return;
    }
    // The stately queue allows this poll to schedule its successor while it is active.
    // Duplicate requests collapse into the queued successor under the same poll key.
    await withTenant(sql, ctx, async (tx) => {
      await jobs().enqueue(
        tx,
        "accounting.tax.submit",
        {
          tenantId: ctx.tenantId,
          requestId: ctx.requestId,
          payload: { transmissionId, phase: "poll" },
        },
        {
          singletonKey: `${transmissionId}:poll`,
          startAfterSeconds: pollDelaySeconds(Math.max(0, attempts - 1)),
          retryLimit: 8,
          retryDelaySeconds: 60,
        },
      );
    });
  };

  // A SUBMIT job that reads the row `submitted` is a redelivery of a submit that already landed:
  // submitTransmission commits `submitted` in its own transaction and enqueuePoll runs in another, so
  // a failed enqueue (a dropped connection, a worker stopped between the two) hands pg-boss a submit
  // job to retry whose claim `submitted` refuses. Read as "nothing to do", that left the row with no
  // poll job and no poll-limit marker — automatic reconciliation never began. Its one missing piece is
  // the poll, so schedule it; the singleton key collapses it into one the first delivery did enqueue,
  // and nothing reaches the authority from here.
  if (phase === "submit" && current.status === "submitted") {
    logger.info(
      { status: current.status, attempts: current.attempts },
      "already submitted — scheduling its poll",
    );
    await enqueuePoll(current.attempts);
    return;
  }

  // ADR 0053, amendment 2026-10-06: a submit the authority answered 2xx but the log could not address
  // is recorded `error` under UNADDRESSED_ACKNOWLEDGEMENT_PREFIX — the authority may already hold the
  // document — and that is terminal for AUTOMATION. `error` is in SUBMITTABLE_FROM, so without this a
  // second submit job resent it: an operator's Submit pressed while the posting job's call was in
  // flight (the row still read `pending`) queued one behind it under the same singletonKey, and it
  // ran on the warning the first one recorded (PR 11 review). A no-op, like a settled row. The
  // operator's submit route is the deliberate resubmission: it replaces the prefix in the
  // transaction that enqueues (`admitOperatorSubmit`), so the job it enqueues proceeds. This read is
  // the early, explained exit; the rule itself holds in submitTransmission's claim, which refuses the
  // same row with ERR_EINVOICE_STATUS_ILLEGAL — the no-op below — if the warning lands after it.
  if (
    phase === "submit" &&
    current.status === "error" &&
    current.lastError?.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX) === true
  ) {
    logger.warn(
      { status: current.status, attempts: current.attempts },
      "the authority may already hold this document — automation does not resubmit it; an operator's submit does",
    );
    return;
  }

  try {
    if (phase === "submit") {
      const row = await submitTransmission(sql, ctx, { transmissionId });
      logger.info({ status: row.status, externalId: row.externalId }, "submitted");
      if (row.status === "submitted") await enqueuePoll(row.attempts);
      return;
    }

    const row = await pollTransmission(sql, ctx, { transmissionId });
    logger.info({ status: row.status }, "polled");
    if (row.status === "submitted") await enqueuePoll(row.attempts);
  } catch (e) {
    if (e instanceof EInvoiceError && e.code === "ERR_EINVOICE_STATUS_ILLEGAL") {
      if (phase === "poll" && current.status === "submitted") {
        // The row was pollable when this job read it, so the claim was refused because a call is in
        // flight under ANOTHER claim — the operator poll route's, since this queue is single-flighted
        // by singletonKey — or because such a call recorded after the read above (the claim reads
        // the row locked, so it sees that record), or this job's own call outlived
        // CLAIM_WINDOW_SECONDS and another claim took the row over before it recorded (so it
        // recorded nothing). That claimant schedules nothing: returning here would end automatic
        // polling below POLL_LIMIT with no successor and no marker. Schedule the successor instead;
        // it re-reads the row, so a row the other call settled makes it a no-op, and the singleton
        // key collapses duplicates.
        logger.info(
          { status: current.status, detail: e.detail },
          "poll refused under another claim — scheduling the next poll",
        );
        await enqueuePoll(current.attempts);
        return;
      }
      // Already settled for this phase — or, on a submit, a row that took the warning after the
      // read above, which the claim refuses to automation, or a submit whose call outlived
      // CLAIM_WINDOW_SECONDS and whose claim another submit took over: its outcome was not recorded,
      // the row is that submit's, and that submit schedules the poll. A no-op.
      logger.info(
        { status: current.status, detail: e.detail },
        "no longer actionable — nothing to do",
      );
      return;
    }
    if (e instanceof EInvoiceError && e.code === "ERR_EINVOICE_NOT_ENABLED") {
      // An admin turned e-invoicing off between the post (or the submit) and this job; retrying
      // eight times would change nothing. The claim is already released (`recordFault`).
      if (phase === "submit") {
        // The row keeps its submittable status, and the operator can resubmit after re-enabling.
        logger.warn(
          { status: current.status },
          "e-invoicing is no longer enabled for this company — the row keeps its status, and an operator resubmits it once e-invoicing is enabled again",
        );
        return;
      }
      // A POLL: the authority holds this `submitted` row, automatic polling ends here and nothing
      // schedules another, so re-enabling resumes nothing by itself. Like the poll-limit marker, the
      // row names the verb that reconciles it (PR 11 review); it replaces the fault text
      // `recordFault` just wrote, which it carries, so a redelivery never nests it. Never under a
      // live claim, whose own record is about to land.
      const marker = `automatic polling stopped: ${e.detail} — once e-invoicing is enabled again, reconcile this transmission with ${operatorPoll}`;
      await withTenant(sql, ctx, async (tx) => {
        await tx`
          update app.einvoice_transmission
             set last_error = left(${marker}, 2000)
           where id = ${transmissionId} and status = 'submitted' and claimed_at is null`;
      });
      logger.warn(
        { status: current.status, operatorPoll },
        "e-invoicing is no longer enabled for this company — automatic polling stops and the row stays submitted; an operator reconciles it with the poll route once e-invoicing is enabled again",
      );
      return;
    }
    throw e; // TransientTransmissionError and ERR_EINVOICE_TRANSMITTER_UNAVAILABLE retry
  }
};
