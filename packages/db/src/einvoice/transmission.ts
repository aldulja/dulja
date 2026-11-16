// packages/db/src/einvoice/transmission.ts
//
// The transmission log is the state of record (ADR 0053). Every remote call is: claim (one short
// transaction) -> call (NO transaction) -> record (one short transaction), and the record writes only
// while the row still holds that call's claim (`endClaim`). This module never holds a
// withTenant transaction, or a lock on the row, across a call to an authority (spec:1368). Each verb
// takes the POOL and needs one connection at a time from it, so a caller must not hold another
// connection of the same pool while it waits: the cancel and poll routes are SELF_TRANSACTED for that
// reason, outside the idempotency middleware's request-spanning transaction (ADR 0053, amendment
// 2026-10-06).

import type { Sql } from "postgres";
import { type TransmissionStatus } from "@dulja/domain";
import { loadSnapshot } from "../posting/load";
import { withTenant, type TenantContext } from "../with-tenant";
import { credentialsFor, type CompanyEInvoiceSettings } from "./credentials";
import { EInvoiceError, UnreadableAcknowledgementError } from "./errors";
import { TransientTransmissionError } from "./http-transmitter";
import { transmitterFor } from "./registry";

export interface EinvoiceTransmissionRow {
  id: string;
  companyId: string;
  documentId: string;
  transmitter: string;
  profileVersion: number | null;
  externalId: string | null;
  status: TransmissionStatus;
  attempts: number;
  lastError: string | null;
  /** Lower-case hex of the stored bytea — the wire form, and what a test compares. */
  requestSha256: string | null;
  response: Record<string, unknown> | null;
  qrPayload: string | null;
  submittedAt: string | null;
  acceptedAt: string | null;
  cancelledAt: string | null;
  polledAt: string | null;
  /** A remote call is in flight since this instant; null means none is (ADR 0053). */
  claimedAt: string | null;
  createdAt: string;
}

/**
 * ADR 0053's table, as data. `rejected` is deliberately resubmittable; `cancelled` is terminal. An
 * `error` led by UNADDRESSED_ACKNOWLEDGEMENT_PREFIX is a member, but `claim()` refuses it to a submit
 * until the operator's submit route has recorded the request (`admitOperatorSubmit`).
 */
export const SUBMITTABLE_FROM: readonly TransmissionStatus[] = ["pending", "error", "rejected"];
export const POLLABLE_FROM: readonly TransmissionStatus[] = ["submitted"];
export const CANCELLABLE_FROM: readonly TransmissionStatus[] = ["accepted"];

/**
 * The remote states a POLL may record (ADR 0053, amendment 2026-10-06), and only from a 2xx answer.
 * A poll only ever runs on a row the authority already holds, so any other outcome — `error` (an
 * unmapped label, a receipt that does not match), `pending`, or ANY label on a non-2xx answer
 * (`rejected` included: http-transmitter lets a 4xx `rejected` through because a refused SUBMIT is
 * an outcome) — is NOT news about the document: it is recorded as `submitted` with its diagnostic
 * in `last_error`. Recording `error` or `rejected` would make the row resubmittable while the
 * authority holds it under `external_id` — which is how one invoice is sent twice — and `error`
 * would also stop the worker's re-enqueue, which continues only on `submitted`.
 */
const POLL_DEFINITIVE: readonly TransmissionStatus[] = [
  "submitted",
  "accepted",
  "rejected",
  "cancelled",
];

/**
 * The states a SUBMIT records as the authority said them. Any other outcome (`error`, `pending`,
 * `cancelled`) is recorded by whether the authority ACKNOWLEDGED intake — a 2xx that returned an
 * external id: then `submitted` (pollable, never resubmittable); otherwise `error` (resubmittable,
 * because the log has no id to reconcile — on a 2xx with the warning `unaddressedAcknowledgement`
 * writes, since the authority may hold it all the same, and then by an operator only:
 * `admitOperatorSubmit`). `pending` in the log means "never sent".
 */
const SUBMIT_DEFINITIVE: readonly TransmissionStatus[] = ["submitted", "accepted", "rejected"];

const is2xx = (httpStatus: number): boolean => httpStatus >= 200 && httpStatus < 300;

/**
 * `last_error` for a submit or poll outcome. An unmapped label is named (LEGACY-020: visible, never a
 * false acceptance); a non-2xx answer, a refusal, an `error`, and any outcome recorded under a
 * status other than the one the authority gave keep the redacted body, which carries `httpStatus`
 * — so an operator can tell an authority's 404 from a 200 with a missing field. A clean answer
 * recorded as given clears it.
 */
function diagnostic(
  outcome: {
    status: TransmissionStatus;
    raw: Record<string, unknown>;
    unmapped: string | null;
    httpStatus: number;
  },
  recorded: TransmissionStatus,
): string | null {
  const body = JSON.stringify(outcome.raw);
  if (outcome.unmapped !== null) {
    const label = `unmapped remote status ${outcome.unmapped}`;
    return (is2xx(outcome.httpStatus) ? label : `${label}: ${body}`).slice(0, 2000);
  }
  if (
    !is2xx(outcome.httpStatus) ||
    outcome.status === "rejected" ||
    outcome.status === "error" ||
    recorded !== outcome.status
  )
    return body.slice(0, 2000);
  return null;
}

/**
 * How `last_error` begins on a submit the authority answered with a 2xx that this log records `error`
 * (`unaddressedAcknowledgement`), and the ONE spelling of it: a row in `error` that starts with it is
 * not actionable by automation — the worker's submit phase leaves it alone and the submit claim
 * refuses it — and the operator's submit route (`admitOperatorSubmit`) removes it to record the
 * deliberate resubmission (ADR 0053, amendment 2026-10-06, "terminal for automation"). Everything
 * after it is the diagnostic.
 */
export const UNADDRESSED_ACKNOWLEDGEMENT_PREFIX =
  "the authority may already hold this document — confirm with it before resubmitting: ";

/**
 * `last_error` for a submit the authority answered with a 2xx that this log records `error` — an
 * acknowledgement the transmitter could not read, or an outcome that names no usable external id
 * (an unmapped label with no id; a MyInvois 202 whose acceptedDocuments the codec cannot correlate).
 * It has nothing to poll, so it cannot be `submitted`, and `error` keeps resubmission possible; but
 * unlike a 4xx it is NOT evidence the authority holds nothing (ADR 0053, amendment 2026-10-06). The
 * job ends without resending it, no later job resends it, and this text puts the decision in front of
 * the operator: the warning, then the HTTP status, the reason and the redacted answer — the only place
 * a submission reference the authority returned (a submissionUID) reaches the wire, since `response`
 * does not. The warning comes first so the 2000-character cut can only shorten what follows it.
 */
function unaddressedAcknowledgement(
  httpStatus: number,
  reason: string,
  raw: Record<string, unknown>,
): string {
  return `${UNADDRESSED_ACKNOWLEDGEMENT_PREFIX}http ${httpStatus}, but ${reason}; response: ${JSON.stringify(raw)}`.slice(
    0,
    2000,
  );
}

/** The same window §4.2.9 reclaims a dead idempotency reservation after. Not a second number. */
export const CLAIM_WINDOW_SECONDS = 120;

// The seventeen-column projection is written out IN FULL in each of the two queries that need it.
/** Insert the pending row. Called from §4.3.2 step 14 inside the posting transaction (Task 6). */
export async function recordPending(
  tx: Sql,
  input: { documentId: string; companyId: string; transmitter: string },
): Promise<string> {
  const [document] = await tx<
    { id: string }[]
  >`select id from app.document where id = ${input.documentId} and company_id = ${input.companyId}`;
  if (!document)
    throw new EInvoiceError("ERR_NOT_FOUND", "transmission document is not in this company");
  const [row] = await tx<{ id: string }[]>`
    insert into app.einvoice_transmission (tenant_id, company_id, document_id, transmitter)
    values (app.current_tenant(), ${input.companyId}, ${input.documentId}, ${input.transmitter})
    on conflict (tenant_id, document_id) do nothing
    returning id::text as id`;
  if (row) return row.id;
  const [existing] = await tx<
    { id: string }[]
  >`select id::text from app.einvoice_transmission where document_id = ${input.documentId} and company_id = ${input.companyId}`;
  if (!existing) throw new EInvoiceError("ERR_NOT_FOUND", "transmission is not in this company");
  return existing.id;
}

export async function getTransmission(
  tx: Sql,
  transmissionId: string,
): Promise<EinvoiceTransmissionRow> {
  const rows = await tx<EinvoiceTransmissionRow[]>`
    select id::text                                            as "id",
           company_id::text                                    as "companyId",
           document_id::text                                   as "documentId",
           transmitter                                         as "transmitter",
           profile_version                                     as "profileVersion",
           external_id                                         as "externalId",
           status                                              as "status",
           attempts                                            as "attempts",
           last_error                                          as "lastError",
           encode(request_sha256, 'hex')                       as "requestSha256",
           response                                            as "response",
           qr_payload                                          as "qrPayload",
           to_char(submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "submittedAt",
           to_char(accepted_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "acceptedAt",
           to_char(cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "cancelledAt",
           to_char(polled_at    at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "polledAt",
           to_char(claimed_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "claimedAt",
           to_char(created_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "createdAt"
      from app.einvoice_transmission where id = ${transmissionId}`;
  const row = rows[0];
  if (!row) {
    // RLS has already reduced the table to the caller's tenant, so "invisible" and "absent" are the
    // same answer here — and §4.2.4 requires ERR_NOT_FOUND never to reveal cross-tenant existence.
    throw new EInvoiceError("ERR_NOT_FOUND", `transmission ${transmissionId} does not exist`);
  }
  return row;
}

export interface ListTransmissionsInput {
  companyId: string;
  status?: TransmissionStatus;
  afterId?: string | null;
  limit: number;
}

/**
 * Newest first, keyset-paged on `id` alone — `id` is a uuidv7 and is therefore time-ordered
 * (§3.2), so `id desc` IS "newest first" and no second sort key is needed. The route encodes the
 * cursor with §4.2.8's `encodeCursor`/`decodeCursor`; this function takes the decoded `afterId`,
 * because `packages/db` may not import `@dulja/contracts` (§3.1).
 */
export async function listTransmissions(
  tx: Sql,
  input: ListTransmissionsInput,
): Promise<EinvoiceTransmissionRow[]> {
  return tx<EinvoiceTransmissionRow[]>`
    select id::text                                            as "id",
           company_id::text                                    as "companyId",
           document_id::text                                   as "documentId",
           transmitter                                         as "transmitter",
           profile_version                                     as "profileVersion",
           external_id                                         as "externalId",
           status                                              as "status",
           attempts                                            as "attempts",
           last_error                                          as "lastError",
           encode(request_sha256, 'hex')                       as "requestSha256",
           response                                            as "response",
           qr_payload                                          as "qrPayload",
           to_char(submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "submittedAt",
           to_char(accepted_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "acceptedAt",
           to_char(cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "cancelledAt",
           to_char(polled_at    at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "polledAt",
           to_char(claimed_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "claimedAt",
           to_char(created_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "createdAt"
      from app.einvoice_transmission
     where company_id = ${input.companyId}
       and (${input.status ?? null}::text is null or status = ${input.status ?? null})
       and (${input.afterId ?? null}::uuid is null or id < ${input.afterId ?? null})
     order by id desc
     limit ${input.limit}`;
}

export async function companySettings(
  tx: Sql,
  companyId: string,
): Promise<CompanyEInvoiceSettings> {
  const [row] = await tx<
    { transmitter: string | null; clientId: string | null; credentialRef: string | null }[]
  >`
    select einvoice_transmitter    as "transmitter",
           einvoice_client_id      as "clientId",
           einvoice_credential_ref as "credentialRef"
      from app.company where id = ${companyId}`;
  if (!row) throw new EInvoiceError("ERR_NOT_FOUND", `company ${companyId} does not exist`);
  return row;
}

// ── the claim ─────────────────────────────────────────────────────────────────────────────────

type Verb = "submit" | "poll" | "cancel";

/**
 * `companyId`, when given, binds the claim to the caller's company (AGENTS.md: RLS bounds the tenant
 * and nothing else, so a route whose gate cleared a company passes it down). It is compared in THIS
 * transaction and BEFORE the status, so another company's row is ERR_NOT_FOUND whatever its status,
 * with the very detail `getTransmission` gives an id that does not exist — a sibling company learns
 * neither that the row exists nor what state it is in — and nothing is claimed. The worker omits it:
 * its payload names no company and its tenant is the job's own.
 *
 * The row it returns names the claim — its `attempts` and `claimedAt` are the values just written —
 * and the call's record is guarded by them (`endClaim`).
 *
 * The row is locked before it is read, so every check below and the update after them act on one
 * state of it (PR 11 review, third pass). A record changes `status` and clears `claimed_at` and
 * never touches `attempts`; read unlocked, a record that committed between this read and the
 * update left the update's predicate true, and a claim whose status check had passed on the old
 * status claimed the row anyway — a submit resent a document the authority already held under the
 * first call's external id. Locked, that record waits for this transaction instead, and the update
 * finds the claim it read still standing. The lock is the one the update takes (`for no key
 * update`), taken at the read instead: the lock order is the update's own — the row, then the
 * tenant's audit serialisation at its audit row — and the transaction still ends before any remote
 * call.
 */
async function claim(
  sql: Sql,
  ctx: TenantContext,
  transmissionId: string,
  verb: Verb,
  legalFrom: readonly TransmissionStatus[],
  companyId: string | undefined,
): Promise<EinvoiceTransmissionRow> {
  return withTenant(sql, ctx, async (tx) => {
    await tx`select id from app.einvoice_transmission where id = ${transmissionId} for no key update`;
    const current = await getTransmission(tx, transmissionId);
    if (companyId !== undefined && current.companyId !== companyId) {
      throw new EInvoiceError("ERR_NOT_FOUND", `transmission ${transmissionId} does not exist`);
    }
    if (!legalFrom.includes(current.status)) {
      throw new EInvoiceError(
        "ERR_EINVOICE_STATUS_ILLEGAL",
        `transmission ${transmissionId} is ${current.status}; ${verb} has allowed states ${legalFrom.join(", ")}`,
      );
    }
    // ADR 0053, amendment 2026-10-06: an `error` the log recorded on a 2xx it could not address is
    // terminal for automation, and this is where that holds — in the transaction that takes the
    // claim, like the status rule above — not only in the worker's pre-read, which reads the row in
    // an earlier transaction and could see it before the warning landed (PR 11 review, second pass).
    // The row is locked, so no record lands between this read and the update below: only a
    // submit's record writes the warning, and a submit whose claim is still standing here refuses
    // this claim below (`claimed_at`). A submit that outlived CLAIM_WINDOW_SECONDS, whose claim this
    // one then takes over, writes nothing at all: its record is guarded by the claim it held
    // (`endClaim`).
    // `admitOperatorSubmit` removes the prefix for the operator's deliberate resubmission, so the
    // job that route enqueues passes.
    if (
      verb === "submit" &&
      current.status === "error" &&
      current.lastError?.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX) === true
    ) {
      throw new EInvoiceError(
        "ERR_EINVOICE_STATUS_ILLEGAL",
        `transmission ${transmissionId} is error after a 2xx this log could not address, and the authority may already hold it; only an operator's submit resubmits it`,
      );
    }
    // `claimed_at` is stamped at the millisecond precision of the row's `claimedAt` projection, so
    // the row this function returns names its claim EXACTLY, and `endClaim` can compare the column
    // with it: `now()` carries microseconds the projection drops, and an equality on those would
    // match no record — every call would look taken over, its own included.
    const claimed = await tx<{ id: string }[]>`
      update app.einvoice_transmission
         set attempts   = attempts + 1,
             claimed_at = date_trunc('milliseconds', now())
       where id = ${transmissionId}
         and attempts = ${current.attempts}
         and (claimed_at is null
              or claimed_at < now() - make_interval(secs => ${CLAIM_WINDOW_SECONDS}))
      returning id::text as id`;
    if (claimed.length === 0) {
      // Another caller has a call IN FLIGHT (`claimed_at` set and younger than the window). The row
      // is locked, so nothing moved since the read — `attempts` restates it — and that call's
      // record, if it is landing now, waits on this lock and lands once this transaction ends.
      // ADR 0053: the job path is single-flighted by singletonKey and the route path by
      // Idempotency-Key, so this is the residual race and the right answer is to refuse rather than
      // to double-submit to the authority. It is NOT the ordinary submit-then-poll sequence: every
      // verb clears `claimed_at` when its call ends, under the claim it took.
      throw callInFlight(transmissionId);
    }
    return getTransmission(tx, transmissionId);
  });
}

function callInFlight(transmissionId: string): EInvoiceError {
  return new EInvoiceError(
    "ERR_EINVOICE_STATUS_ILLEGAL",
    `transmission ${transmissionId} has a call in flight (claimed within ${CLAIM_WINDOW_SECONDS}s)`,
  );
}

/**
 * The operator's submit (`POST …/einvoice-transmissions/{id}/submit`), in the transaction that
 * enqueues its job and after that route's company and status checks. Two things, both ADR 0053's
 * amendment 2026-10-06 made enforceable (PR 11 review):
 *
 * - **A call in flight refuses it**, as `claim()` would — `claimed_at` younger than
 *   CLAIM_WINDOW_SECONDS, read on the database's clock as `claim()` reads it. While the posting job's
 *   submit is in flight the row still reads `pending`, so an operator who pressed Submit then
 *   enqueued a second job behind it, which ran on whatever the first one recorded.
 * - **A row automation must not resubmit** — `error` led by UNADDRESSED_ACKNOWLEDGEMENT_PREFIX,
 *   because the authority answered 2xx and may hold the document — **records the operator's
 *   request**: the prefix is replaced by a note that an operator asked for the resubmission, and the
 *   diagnostic after it is kept. That is the deliberate resubmission the warning asks for, made by
 *   the one caller who could have confirmed with the authority; the job it enqueues then finds a row
 *   automation may act on. The update is audited under the operator (`app.einvoice_transmission`'s
 *   audit trigger), and a row without the prefix — every other `error`, `pending`, `rejected` — is
 *   left as it is, so admitting twice never nests the note.
 *
 * Nothing is claimed and nothing is sent: the job does both. Returns the row as it now stands.
 */
export async function admitOperatorSubmit(
  tx: Sql,
  transmissionId: string,
): Promise<EinvoiceTransmissionRow> {
  const [row] = await tx<{ inFlight: boolean }[]>`
    select claimed_at is not null
           and claimed_at >= now() - make_interval(secs => ${CLAIM_WINDOW_SECONDS}) as "inFlight"
      from app.einvoice_transmission
     where id = ${transmissionId}`;
  if (!row)
    throw new EInvoiceError("ERR_NOT_FOUND", `transmission ${transmissionId} does not exist`);
  if (row.inFlight) throw callInFlight(transmissionId);
  await tx`
    update app.einvoice_transmission
       set last_error = left('resubmission requested by an operator; '
                             || substr(last_error, char_length(${UNADDRESSED_ACKNOWLEDGEMENT_PREFIX}::text) + 1),
                             2000)
     where id = ${transmissionId}
       and status = 'error'
       and starts_with(last_error, ${UNADDRESSED_ACKNOWLEDGEMENT_PREFIX})`;
  return getTransmission(tx, transmissionId);
}

/**
 * Records why a remote call failed AND **ends the claim** — `claimed_at = null`, `polled_at = now()`
 * (the call completed, unsuccessfully, at this instant).
 *
 * Ending the claim is the load-bearing half and the reason is arithmetic: `claim()` refuses re-entry
 * while `claimed_at` is younger than `CLAIM_WINDOW_SECONDS` (120), and `accounting.tax.submit` is
 * enqueued with `retryDelaySeconds: 60`, so pg-boss's first retry arrives INSIDE that window. If the
 * claim outlived the call, `claim()` would raise `ERR_EINVOICE_STATUS_ILLEGAL`, the handler's catch
 * would read that as "no longer actionable — nothing to do", pg-boss would mark the job complete,
 * and the row would be abandoned at `pending` with `retryLimit 8` never exercised for the one case
 * it exists for (§4.9.3, spec:2225).
 *
 * `attempts` is NOT decremented — it counts attempts, and the bounded retry is pg-boss's job.
 *
 * Like every record, it ends only the claim this call holds (`endClaim`). Under a claim another
 * caller took over it writes nothing — least of all `claimed_at = null`, which would release that
 * caller's claim while its call is in flight — and the call's own error still reaches its caller:
 * the call did fail, a pg-boss retry re-reads the row, and the operator's route answers as it would.
 */
async function recordFault(
  sql: Sql,
  ctx: TenantContext,
  claimed: EinvoiceTransmissionRow,
  verb: Verb,
  message: string,
): Promise<void> {
  await withTenant(sql, ctx, async (tx) => {
    const ended = await tx`
      update app.einvoice_transmission
         set last_error  = ${message.slice(0, 2000)},
             claimed_at  = null,
             polled_at   = now()
       where id = ${claimed.id}
         and ${endClaim(tx, claimed)}
      returning id`;
    if (ended.length === 0) reportTakenOver(claimed.id, verb, `fault: ${message}`);
  });
}

/**
 * The predicate every write that ENDS a call carries — the submit, poll and cancel records and
 * `recordFault` (ADR 0053 §3, PR 11 review): the row still holds the claim this call took, the
 * `attempts` and `claimed_at` `claim()` wrote and returned. `claim()` admits a second caller once
 * `claimed_at` is older than CLAIM_WINDOW_SECONDS; that caller increments `attempts` and restamps
 * `claimed_at`, so a call that outlived the window matches no row when it ends, and writes nothing.
 * Matched on `id` alone, its outcome landed over the second caller's and its `claimed_at = null`
 * released the second claim mid-call, admitting a third. The profile's `timeoutMs` (at most half
 * the window, einvoice-profile.schema.json) keeps an ordinary call well inside it; this is for one
 * that is not — a stalled pool, a paused process.
 */
function endClaim(tx: Sql, claimed: EinvoiceTransmissionRow) {
  return tx`attempts = ${claimed.attempts} and claimed_at = ${claimed.claimedAt}::timestamptz`;
}

/**
 * A call whose claim was taken over: nothing of it is recorded, so this line is the only trace of
 * what it learned — on a submit, the external id under which the authority may now hold the
 * document a second time. `packages/db` has no logger (it may import `@dulja/domain` alone), so it
 * writes the entrypoints' JSON line shape to stderr, as `jobs/enqueue.ts`'s `writeBossError` does.
 */
function reportTakenOver(transmissionId: string, verb: Verb, outcome: string): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      msg: `e-invoice ${verb} call ended under a claim another call had taken over (older than ${CLAIM_WINDOW_SECONDS}s); its outcome was not recorded`,
      transmissionId,
      verb,
      outcome: outcome.slice(0, 2000),
      time: new Date().toISOString(),
    })}\n`,
  );
}

/**
 * What a superseded call's caller receives instead of a row: ERR_EINVOICE_STATUS_ILLEGAL, the code
 * `claim()` already gives "another call holds this row". The row is the other claim's, and returning
 * it would hand the worker someone else's in-flight state to enqueue a poll on, and an operator a
 * 200 for an outcome that is not theirs; the worker reads this code as "nothing to do" on a submit
 * and schedules the next poll on a poll, both right when another claimant owns the row.
 */
function claimTakenOver(transmissionId: string, verb: Verb, outcome: string): EInvoiceError {
  reportTakenOver(transmissionId, verb, outcome);
  return new EInvoiceError(
    "ERR_EINVOICE_STATUS_ILLEGAL",
    `transmission ${transmissionId}: another call took over this ${verb}'s claim after ${CLAIM_WINDOW_SECONDS}s, so its outcome was not recorded`,
  );
}

// ── the three verbs ───────────────────────────────────────────────────────────────────────────

export async function submitTransmission(
  sql: Sql,
  ctx: TenantContext,
  input: { transmissionId: string; companyId?: string },
): Promise<EinvoiceTransmissionRow> {
  const claimed = await claim(
    sql,
    ctx,
    input.transmissionId,
    "submit",
    SUBMITTABLE_FROM,
    input.companyId,
  );

  // ⚠️ EVERYTHING BETWEEN THE CLAIM AND THE END OF THE CALL IS INSIDE THIS `try`, and that is the
  // whole point of the block. `credentialsFor` raises ERR_EINVOICE_NOT_ENABLED, `transmitterFor`
  // raises ERR_EINVOICE_TRANSMITTER_UNAVAILABLE, `loadSnapshot` can raise, and a canonicaliser can
  // raise on an unmappable required field — all of them AFTER `claim()` stamped `claimed_at`. A
  // throw that skipped `recordFault` would leave the claim standing for 120 seconds; pg-boss's
  // first retry arrives at 60 (`retryDelaySeconds`), `claim()` would refuse it with
  // ERR_EINVOICE_STATUS_ILLEGAL, and Task 7's handler reads that code as "no longer actionable —
  // nothing to do" and completes the job. The row would sit at `pending` for ever with
  // `retryLimit 8` never exercised. ERR_EINVOICE_TRANSMITTER_UNAVAILABLE is the state EVERY
  // the authority transmitter company is in before OD-15, which is the one path this slice most needs to keep
  // retryable (ADR 0053 §3, and Task 7's "the pg-boss retry REACHES the authority" test).
  let transmitter: ReturnType<typeof transmitterFor>;
  let doc: ReturnType<typeof transmitter.canonicalise>;
  let result: Awaited<ReturnType<typeof transmitter.submit>>;
  let qr: string | null = null;
  // Why a 2xx acknowledgement could not be read, when it could not (UnreadableAcknowledgementError).
  let unreadable: string | null = null;
  // Set when an acceptance is recorded `submitted` because its QR could not be built: the diagnostic
  // is THIS service's, not the authority's label.
  let note: string | null = null;
  let qrFailed = false;
  try {
    const settings = await withTenant(sql, ctx, (tx) => companySettings(tx, claimed.companyId));
    const credentials = credentialsFor(settings); // ERR_EINVOICE_NOT_ENABLED
    if (settings.transmitter !== claimed.transmitter) {
      throw new EInvoiceError(
        "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
        "configured transmitter differs from the transmission's recorded transmitter",
      );
    }
    // A (re)submission sends the document anew, under the code's highest profile version, and its
    // record pins the row to that version. ERR_EINVOICE_TRANSMITTER_UNAVAILABLE when it is not built.
    transmitter = transmitterFor(settings.transmitter!);

    // The snapshot is read in its own short transaction, and canonicalisation is pure — so the
    // payload is a function of STORED line figures and a later tax_code version cannot change it
    // (LEGACY-020's "regime pinned on submission"; tests/regression/legacy-020.test.ts proves it).
    const snapshot = await withTenant(sql, ctx, (tx) => loadSnapshot(tx, claimed.documentId));
    doc = transmitter.canonicalise(snapshot);

    try {
      result = await transmitter.submit(doc, credentials);
    } catch (e) {
      // ADR 0053, amendment 2026-10-06: the authority ANSWERED 2xx and the transmitter could not
      // read it. Rethrown, pg-boss's retry would POST the document again although the authority may
      // have taken it in; recorded, it is an `error` OUTCOME with no usable external id — the
      // amendment's unacknowledged case — and the job ends. Resubmitting is an operator's decision,
      // made with this diagnostic in front of them.
      if (!(e instanceof UnreadableAcknowledgementError)) throw e;
      result = {
        externalId: "",
        status: "error",
        raw: e.raw,
        unmapped: null,
        httpStatus: e.httpStatus,
      };
      unreadable = e.detail;
    }
    if (result.status === "accepted" && result.externalId !== "") {
      try {
        qr = transmitter.qrPayload(doc, { externalId: result.externalId, raw: result.raw });
      } catch (e) {
        // The authority ACCEPTED the document under `externalId`; a failed QR builder is ours. A
        // fault here used to leave the row `pending` with no id, and the retry sent it again. It
        // is recorded `submitted` under its id instead: the poll re-reads the acceptance and builds
        // the QR then, and the claim is released by the record below like any completed call.
        qrFailed = true;
        note = `accepted under ${result.externalId}, but its QR payload could not be built: ${(e as Error).message} — the next poll re-reads the acceptance`;
      }
    }
  } catch (e) {
    const message =
      e instanceof TransientTransmissionError
        ? `transient: ${e.message} (http ${e.httpStatus})`
        : `submit failed: ${(e as Error).message}`;
    await recordFault(sql, ctx, claimed, "submit", message);
    throw e; // pg-boss retries a TransientTransmissionError; anything else surfaces
  }

  // ADR 0053, amendment 2026-10-06: a submit the authority ACKNOWLEDGED is never resubmittable. A 2xx
  // that returned an external id means the authority took the document in, whatever label came with
  // it; `error` would put the row back in SUBMITTABLE_FROM and the next submit would send the same
  // invoice again, and `pending` would do the same and never be polled. Such an outcome is recorded
  // `submitted` — pollable, so reconciliation asks what became of it — with the diagnostic in
  // `last_error`. A non-2xx (including the success-shaped body http-transmitter forces to `error`)
  // or a call that returned no usable id is recorded `error`: the log holds nothing it could
  // reconcile, so resubmitting is the recovery. An acceptance whose QR failed is held at
  // `submitted` too (above): the poll finishes it.
  const acknowledged = is2xx(result.httpStatus) && result.externalId !== "";
  const recordedStatus: TransmissionStatus = qrFailed
    ? "submitted"
    : SUBMIT_DEFINITIVE.includes(result.status)
      ? result.status
      : acknowledged
        ? "submitted"
        : "error";
  // `error` on a 2xx means "no usable external id" (with one, the row would be `submitted`): the
  // authority may hold the document all the same, so that row carries the warning a 4xx's does not.
  const lastError =
    note ??
    (is2xx(result.httpStatus) && recordedStatus === "error"
      ? unaddressedAcknowledgement(
          result.httpStatus,
          unreadable !== null
            ? `its acknowledgement could not be read: ${unreadable}`
            : `it named no external id to poll: ${result.unmapped !== null ? `unmapped remote status ${result.unmapped}` : `status ${result.status}`}`,
          result.raw,
        )
      : diagnostic(result, recordedStatus));
  return withTenant(sql, ctx, async (tx) => {
    const ended = await tx`
      update app.einvoice_transmission
         set status          = ${recordedStatus},
             external_id     = coalesce(${result.externalId === "" ? null : result.externalId}, external_id),
             profile_version = ${transmitter.profile.version},
             request_sha256  = decode(${doc.hash}, 'hex'),
             response        = ${tx.json(result.raw as never)},
             submitted_at    = coalesce(submitted_at, now()),
             claimed_at      = null,                       -- the call ended; the claim ends with it
             polled_at       = now(),                      -- the last COMPLETED remote call
             accepted_at     = case when ${recordedStatus} = 'accepted' then coalesce(accepted_at, now()) else accepted_at end,
             qr_payload      = coalesce(${qr}, qr_payload),
             last_error      = ${lastError === null ? null : lastError.slice(0, 2000)}
       where id = ${input.transmissionId}
         and ${endClaim(tx, claimed)}
      returning id`;
    if (ended.length === 0)
      throw claimTakenOver(
        input.transmissionId,
        "submit",
        `status ${result.status} (http ${result.httpStatus}), external id ${result.externalId === "" ? "none" : result.externalId}`,
      );
    return getTransmission(tx, input.transmissionId);
  });
}

/**
 * One reconciliation call. The worker's poll phase calls it under POLL_LIMIT; the operator route
 * `POST …/einvoice-transmissions/{id}/poll` calls it with no limit, for a row automatic polling has
 * given up on (ADR 0053, amendment 2026-10-06). Either way it never demotes — see POLL_DEFINITIVE.
 */
export async function pollTransmission(
  sql: Sql,
  ctx: TenantContext,
  input: { transmissionId: string; companyId?: string },
): Promise<EinvoiceTransmissionRow> {
  const claimed = await claim(
    sql,
    ctx,
    input.transmissionId,
    "poll",
    POLLABLE_FROM,
    input.companyId,
  );

  // The settings/credentials/registry resolution is inside the `try` for the reason
  // `submitTransmission` states at length: a refusal raised after the claim and outside it would
  // leave `claimed_at` standing and swallow pg-boss's retry (ADR 0053 §3).
  let transmitter: ReturnType<typeof transmitterFor>;
  let result: Awaited<ReturnType<typeof transmitter.poll>>;
  let qr: string | null = null;
  try {
    const settings = await withTenant(sql, ctx, (tx) => companySettings(tx, claimed.companyId));
    const credentials = credentialsFor(settings);
    if (settings.transmitter !== claimed.transmitter) {
      throw new EInvoiceError(
        "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
        "configured transmitter differs from the transmission's recorded transmitter",
      );
    }
    // The row is read against the profile version it was submitted under (LEGACY-013), not whichever
    // version a new submission would use: a version bump must not strand it (ADR 0053, "Also
    // open"). A version this deployment no longer registers is ERR_EINVOICE_TRANSMITTER_UNAVAILABLE
    // naming it, from the registry; a row never submitted has no pin and takes the highest.
    transmitter = transmitterFor(settings.transmitter!, claimed.profileVersion ?? undefined);
    result = await transmitter.poll(claimed.externalId!, credentials);
    // Snapshot and QR failures must release the claim just like transport failures.
    if (is2xx(result.httpStatus) && result.status === "accepted") {
      const snapshot = await withTenant(sql, ctx, (tx) => loadSnapshot(tx, claimed.documentId));
      qr = transmitter.qrPayload(transmitter.canonicalise(snapshot), {
        externalId: claimed.externalId!,
        raw: result.raw,
      });
    }
  } catch (e) {
    const message =
      e instanceof TransientTransmissionError
        ? `transient: ${e.message} (http ${e.httpStatus})`
        : `poll failed: ${(e as Error).message}`;
    await recordFault(sql, ctx, claimed, "poll", message);
    throw e;
  }

  // A poll never demotes (POLL_DEFINITIVE, and only from a 2xx). `diagnostic` still records what the
  // authority said — a 403's or a 404's redacted body, which carries its httpStatus, or an unmapped
  // label — while the row stays `submitted`; `accepted_at`, `cancelled_at` and the QR are written
  // only on their own recorded states.
  const recordedStatus: TransmissionStatus =
    is2xx(result.httpStatus) && POLL_DEFINITIVE.includes(result.status)
      ? result.status
      : "submitted";
  return withTenant(sql, ctx, async (tx) => {
    const ended = await tx`
      update app.einvoice_transmission
         set status      = ${recordedStatus},
             response    = ${tx.json(result.raw as never)},
             claimed_at  = null,
             polled_at   = now(),
             accepted_at = case when ${recordedStatus} = 'accepted' then coalesce(accepted_at, now()) else accepted_at end,
             cancelled_at = case when ${recordedStatus} = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end,
             qr_payload  = coalesce(${qr}, qr_payload),
             last_error  = ${diagnostic(result, recordedStatus)}
       where id = ${input.transmissionId}
         and ${endClaim(tx, claimed)}
      returning id`;
    if (ended.length === 0)
      throw claimTakenOver(
        input.transmissionId,
        "poll",
        `status ${result.status} (http ${result.httpStatus})`,
      );
    return getTransmission(tx, input.transmissionId);
  });
}

export async function cancelTransmission(
  sql: Sql,
  ctx: TenantContext,
  input: { transmissionId: string; reason: string; companyId?: string },
): Promise<EinvoiceTransmissionRow> {
  const claimed = await claim(
    sql,
    ctx,
    input.transmissionId,
    "cancel",
    CANCELLABLE_FROM,
    input.companyId,
  );

  // Inside the `try` for the same reason as the other two verbs: a claim that outlives its call is
  // an abandoned row (ADR 0053 §3). The `cancel` path has no pg-boss retry behind it, but an
  // operator who fixes the settings and presses cancel again must not be told "a call is in flight".
  let transmitter: ReturnType<typeof transmitterFor>;
  let result: Awaited<ReturnType<typeof transmitter.cancel>>;
  try {
    const settings = await withTenant(sql, ctx, (tx) => companySettings(tx, claimed.companyId));
    const credentials = credentialsFor(settings);
    if (settings.transmitter !== claimed.transmitter) {
      throw new EInvoiceError(
        "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
        "configured transmitter differs from the transmission's recorded transmitter",
      );
    }
    // The row's pinned profile version, as the poll above resolves it.
    transmitter = transmitterFor(settings.transmitter!, claimed.profileVersion ?? undefined);
    result = await transmitter.cancel(claimed.externalId!, input.reason, credentials);
  } catch (e) {
    const message =
      e instanceof TransientTransmissionError
        ? `transient: ${e.message} (http ${e.httpStatus})`
        : `cancel failed: ${(e as Error).message}`;
    await recordFault(sql, ctx, claimed, "cancel", message);
    throw e;
  }

  const unmapped = result.unmapped;
  // A refused cancellation does not revoke the authority's earlier acceptance or its QR link.
  const recordedStatus = result.status === "cancelled" ? "cancelled" : claimed.status;
  return withTenant(sql, ctx, async (tx) => {
    const ended = await tx`
      update app.einvoice_transmission
         set status       = ${recordedStatus},
             response     = ${tx.json(result.raw as never)},
             claimed_at   = null,
             polled_at    = now(),
             cancelled_at = case when ${result.status} = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end,
             last_error   = ${unmapped !== null ? `unmapped remote status ${unmapped}` : result.status === "cancelled" ? `cancelled: ${input.reason.slice(0, 500)}` : JSON.stringify(result.raw).slice(0, 2000)}
       where id = ${input.transmissionId}
         and ${endClaim(tx, claimed)}
      returning id`;
    if (ended.length === 0)
      throw claimTakenOver(input.transmissionId, "cancel", `status ${result.status}`);
    return getTransmission(tx, input.transmissionId);
  });
}
