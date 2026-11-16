import type { Sql } from "postgres";
import {
  FAILURE_DETAIL_MAX,
  claimLeased,
  leaseFence,
  leaseFollowUpOptions,
  leaseJobOptions,
  leaseState,
  renewLeased,
  type Lease,
  type LeaseJobOptions,
  type LeaseRenewal,
  type LeaseState,
} from "../jobs/lease";

/**
 * The `import_run` lifecycle (migration 0103; 9B Task 9, contracts round 20 C17): `queued` by the API in the request's
 * transaction, `running` when the `admin.import.run` job claims it, then `done` with the load's counts or `failed`
 * with a reason. 7C's `export_job` lifecycle over the same lease machinery (`jobs/lease.ts`). Every function takes the
 * caller's `withTenant` transaction; RLS bounds the tenant and the callers pass the company they gated.
 */
export type ImportRunStatus = "queued" | "running" | "done" | "failed";

/** One loader's counts, as `runLoad`'s `LoadReport.perLoader` carries them (`@dulja/importer`'s `LoaderReport`). */
export interface ImportRunLoaderCounts {
  inserted: number;
  skipped: number;
  conflicts: number;
}

/**
 * How long a `running` import claim is trusted WITHOUT a heartbeat. The worker renews the claim before every page it
 * commits (`renewImportRunLease`, at most once per `IMPORT_RUN_HEARTBEAT_SECONDS`), so a load of any length keeps its
 * claim while it makes progress; only a worker that died, or one page that runs longer than four hours, lets the lease
 * lapse. A takeover of a claim that is still LOADING is not harmless — the second load meets the first's keys
 * ("recorded by a concurrent load") and fails the run, and the first's outcome is then fenced out — which is why the
 * heartbeat exists and why the superseded worker stops before its next page (9B review, finding 5). pg-boss expires
 * the job at the same figure (`IMPORT_RUN_JOB_OPTIONS`); a redelivery while the first handler still runs finds the
 * renewed claim live and defers past it.
 */
export const IMPORT_RUN_LEASE_SECONDS = 14_400;
/** The heartbeat's throttle: a claim renewed less than five minutes ago is not renewed again (each renewal is an
 *  audited UPDATE). Far inside the lease, so a load whose pages each take under four hours never loses its claim. */
export const IMPORT_RUN_HEARTBEAT_SECONDS = 300;
/** Claims a run may take before the next fails it instead. Two: a load a worker died in is resumed once. */
export const IMPORT_RUN_MAX_CLAIMS = 2;
const IMPORT_LEASE: Lease = {
  table: (tx) => tx`app.import_run r`,
  leaseSeconds: IMPORT_RUN_LEASE_SECONDS,
  maxClaims: IMPORT_RUN_MAX_CLAIMS,
  abandoned: `ERR_INTERNAL: the import run was claimed ${IMPORT_RUN_MAX_CLAIMS} times and never finished; every worker that ran it stopped. start it again and the load resumes after its last committed page`,
};
/** The pg-boss options every `admin.import.run` job is enqueued with — `leaseJobOptions` over the run's lease. */
export const IMPORT_RUN_JOB_OPTIONS: LeaseJobOptions = leaseJobOptions(IMPORT_LEASE);

export interface ImportRunRow {
  id: string;
  companyId: string;
  requestedBy: string;
  cutOverDate: string;
  dryRun: boolean;
  only: string[] | null;
  /** The owner's account map as the request carried it — validated by the job (`assertAccountMap`), not here. */
  accountMap: unknown;
  status: ImportRunStatus;
  perLoader: Record<string, ImportRunLoaderCounts> | null;
  skipCount: number | null;
  artefactCount: number | null;
  startedAt: string | null;
  /** Claims taken so far — the fencing token the worker passes back to `completeImportRun`/`failImportRun`. */
  attempts: number;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
}

interface RawRun {
  id: string;
  company_id: string;
  requested_by: string;
  cut_over_date: string;
  dry_run: boolean;
  only_targets: string[] | null;
  account_map: unknown;
  status: ImportRunStatus;
  per_loader: Record<string, ImportRunLoaderCounts> | null;
  skip_count: number | null;
  artefact_count: number | null;
  started_at: string | null;
  attempts: number;
  finished_at: string | null;
  error: string | null;
  created_at: string;
}

/** The one SELECT list every read shares — a postgres.js fragment, never a string of SQL (§3.3, test 27).
 *  `created_at` keeps its microseconds: it is the list's keyset (7A's and 7C's rule). */
function selectList(tx: Sql) {
  return tx`r.id, r.company_id, r.requested_by, to_char(r.cut_over_date, 'YYYY-MM-DD') as cut_over_date,
            r.dry_run, r.only_targets, r.account_map, r.status, r.per_loader, r.skip_count, r.artefact_count,
            to_char(r.started_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at,
            r.attempts,
            to_char(r.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as finished_at,
            r.error,
            to_char(r.created_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
}

function toRow(raw: RawRun): ImportRunRow {
  return {
    id: raw.id,
    companyId: raw.company_id,
    requestedBy: raw.requested_by,
    cutOverDate: raw.cut_over_date,
    dryRun: raw.dry_run,
    only: raw.only_targets,
    accountMap: raw.account_map,
    status: raw.status,
    perLoader: raw.per_loader,
    skipCount: raw.skip_count,
    artefactCount: raw.artefact_count,
    startedAt: raw.started_at,
    attempts: raw.attempts,
    finishedAt: raw.finished_at,
    error: raw.error,
    createdAt: raw.created_at,
  };
}

export interface NewImportRun {
  companyId: string;
  cutOverDate: string;
  dryRun: boolean;
  only?: readonly string[] | undefined;
  accountMap?: unknown;
}

/**
 * `requested_by` is left to its column default and `app.stamp_actor` (§3.3): the acting principal. A second live run
 * of the company violates `import_run_one_live_per_company` (23505); the route reads `liveImportRun` first so the
 * refusal can name the run in the way, and the index is what holds under a race.
 */
export async function createImportRun(tx: Sql, input: NewImportRun): Promise<ImportRunRow> {
  const only = input.only === undefined ? null : [...input.only];
  const accountMap =
    input.accountMap === undefined || input.accountMap === null
      ? null
      : JSON.stringify(input.accountMap);
  const [raw] = await tx<RawRun[]>`
    insert into app.import_run as r
      (tenant_id, company_id, cut_over_date, dry_run, only_targets, account_map, status)
    values (app.current_tenant(), ${input.companyId}::uuid, ${input.cutOverDate}::date, ${input.dryRun},
            ${only}::text[], ${accountMap}::text::jsonb, 'queued')
    returning ${selectList(tx)}`;
  return toRow(raw!);
}

export async function getImportRun(tx: Sql, id: string): Promise<ImportRunRow | null> {
  const [raw] = await tx<
    RawRun[]
  >`select ${selectList(tx)} from app.import_run r where r.id = ${id}::uuid`;
  return raw === undefined ? null : toRow(raw);
}

/** The company's queued or running run, if any — at most one (`import_run_one_live_per_company`). */
export async function liveImportRun(tx: Sql, companyId: string): Promise<ImportRunRow | null> {
  const [raw] = await tx<RawRun[]>`
    select ${selectList(tx)} from app.import_run r
     where r.company_id = ${companyId}::uuid and r.status in ('queued', 'running')`;
  return raw === undefined ? null : toRow(raw);
}

export interface ImportRunQueryParams {
  companyId: string;
  status?: ImportRunStatus;
  limit: number;
  cursor?: { createdAt: string; id: string } | null;
}

/** Keyset-paged on `(created_at, id)`, newest first — the order `import_run_company_created_idx` serves. */
export async function listImportRuns(
  tx: Sql,
  params: ImportRunQueryParams,
): Promise<ImportRunRow[]> {
  const byStatus = params.status === undefined ? tx`` : tx`and r.status = ${params.status}`;
  const after =
    params.cursor === undefined || params.cursor === null
      ? tx``
      : tx`and (r.created_at, r.id) < (${params.cursor.createdAt}::timestamptz, ${params.cursor.id}::uuid)`;
  const rows = await tx<RawRun[]>`
    select ${selectList(tx)} from app.import_run r
     where r.company_id = ${params.companyId}::uuid ${byStatus} ${after}
     order by r.created_at desc, r.id desc
     limit ${params.limit}`;
  return rows.map(toRow);
}

/**
 * `queued → running`, conditionally — or the reclaim of a run whose worker died (`claimLeased`). A second delivery
 * of a FINISHED job gets null and is a no-op rather than a second load; a `running` row under a live claim gets null
 * too, and the handler schedules ONE follow-up after the lease (`importRunFollowUpOptions`); a reclaim past
 * `IMPORT_RUN_MAX_CLAIMS` fails the run in the same statement.
 */
export async function claimImportRun(tx: Sql, id: string): Promise<ImportRunRow | null> {
  const raw = await claimLeased<RawRun>(tx, IMPORT_LEASE, id, selectList(tx));
  return raw === undefined ? null : toRow(raw);
}

/**
 * The worker's heartbeat on its claim `attempt` (`renewLeased`): `renewed`, `fresh` (renewed under
 * `IMPORT_RUN_HEARTBEAT_SECONDS` ago, nothing written) or `superseded` — another claim holds the run now, or it is
 * settled, and the load must stop before it writes another page.
 */
export function renewImportRunLease(tx: Sql, id: string, attempt: number): Promise<LeaseRenewal> {
  return renewLeased(tx, IMPORT_LEASE, id, attempt, IMPORT_RUN_HEARTBEAT_SECONDS);
}

/** How long after a busy delivery its follow-up is due (9B review, finding 7): a load already running in the worker
 *  process — the one-load-per-process guard — is waited out in five-minute steps, each a NEW job with its own retries,
 *  never by throwing and spending this delivery's. */
export const IMPORT_RUN_BUSY_RETRY_SECONDS = 300;

/** The follow-up a delivery that found its worker busy enqueues instead of throwing: the same payload, due after
 *  `IMPORT_RUN_BUSY_RETRY_SECONDS`, with the lease's options and a key naming the run. */
export function importRunBusyFollowUpOptions(
  id: string,
): LeaseJobOptions & { singletonKey: string; startAfterSeconds: number } {
  return {
    ...IMPORT_RUN_JOB_OPTIONS,
    singletonKey: `${id}:busy`,
    startAfterSeconds: IMPORT_RUN_BUSY_RETRY_SECONDS,
  };
}

/**
 * 9B review, finding 7 — the operator's way out of a run whose job is gone. A run that has stayed `queued` and never
 * been claimed (`attempts = 0`) for longer than the lease (`IMPORT_RUN_LEASE_SECONDS`) is one whose `admin.import.run`
 * job was lost — exhausted its retries, archived unworked, or never delivered — and it would hold the company's one
 * live slot (`import_run_one_live_per_company`) for ever, refusing every later request with 409. `POST …/imports`
 * calls this first, in its own transaction: each such run is failed with a stable reason, as the requester, and the
 * new request proceeds. A claimed run is never touched — its lease and follow-ups settle it — and a delivery that
 * arrives afterwards finds the run settled and does nothing. Returns the superseded runs' ids.
 */
export async function supersedeStaleImportRuns(tx: Sql, companyId: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    update app.import_run
       set status = 'failed', finished_at = now(),
           error = ${`ERR_INTERNAL: the import run stayed queued for more than ${IMPORT_RUN_LEASE_SECONDS / 3600} hours and no worker ever claimed it (its job was lost or exhausted); a new import request superseded it and nothing was loaded`}
     where company_id = ${companyId}::uuid and status = 'queued' and attempts = 0
       and created_at < now() - make_interval(secs => ${IMPORT_RUN_LEASE_SECONDS})
    returning id::text as id`;
  return rows.map((r) => r.id);
}

/** The run's status, claim count and remaining lease, on the database's clock (`leaseState`). */
export function importRunLeaseState(tx: Sql, id: string): Promise<LeaseState | null> {
  return leaseState(tx, IMPORT_LEASE, id);
}

/** The options of the ONE follow-up `admin.import.run` delivery a live claim gets (`leaseFollowUpOptions`). */
export function importRunFollowUpOptions(id: string, state: LeaseState) {
  return leaseFollowUpOptions(IMPORT_LEASE, id, state);
}

export interface CompleteImportRun {
  id: string;
  perLoader: Readonly<Record<string, ImportRunLoaderCounts>>;
  skipCount: number;
  artefactCount: number;
  /** The claim's own `attempts`: a worker whose claim was superseded writes nothing. */
  attempt?: number;
}

/** `running → done`. `false` when the claim was superseded (nothing written). */
export async function completeImportRun(tx: Sql, input: CompleteImportRun): Promise<boolean> {
  const result = await tx`
    update app.import_run
       set status = 'done', per_loader = ${JSON.stringify(input.perLoader)}::text::jsonb,
           skip_count = ${input.skipCount}, artefact_count = ${input.artefactCount},
           finished_at = now(), error = null
     where id = ${input.id}::uuid and status = 'running' ${leaseFence(tx, input.attempt)}`;
  return result.count === 1;
}

/** `queued | running → failed`, with the reason (capped at `FAILURE_DETAIL_MAX`, 7A/7C's figure) and no counts.
 *  `false` when the claim was superseded or the run had already finished. */
export async function failImportRun(
  tx: Sql,
  input: { id: string; error: string; attempt?: number },
): Promise<boolean> {
  const result = await tx`
    update app.import_run
       set status = 'failed', error = ${input.error.slice(0, FAILURE_DETAIL_MAX)}, finished_at = now(),
           per_loader = null, skip_count = null
     where id = ${input.id}::uuid and status in ('queued', 'running') ${leaseFence(tx, input.attempt)}`;
  return result.count === 1;
}
