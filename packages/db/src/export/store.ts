import type { Sql } from "postgres";
import {
  FAILURE_DETAIL_MAX,
  claimLeased,
  leaseFence,
  leaseFollowUpOptions,
  leaseJobOptions,
  leaseState,
  type Lease,
  type LeaseJobOptions,
  type LeaseState,
} from "../jobs/lease";

/**
 * The `export_job` lifecycle (contracts §4.6.1, 7C amendment A9): `queued` by the API in the request's
 * transaction, `running` when the `admin.export.run` job claims it, then `done` with an archive or `failed`
 * with a reason. Every function takes the caller's `withTenant` transaction; RLS bounds the tenant and the
 * callers pass the company they gated.
 */
export type ExportStatus = "queued" | "running" | "done" | "failed";
export type ExportFormat = "csv" | "json" | "both";

/**
 * How long a `running` export claim is trusted (Phase 7 review, finding 2): a claim older than this belonged to
 * a worker that died, and the redelivered job reclaims the export. An export has no engine timeout of its own —
 * it is bounded by the tenant's size and the worker's memory (ADR 0069) — so the lease is an hour, six times
 * the report run's.
 */
export const EXPORT_JOB_LEASE_SECONDS = 3600;
/** Claims an export may take before the next fails it instead of claiming it again. */
export const EXPORT_JOB_MAX_CLAIMS = 3;
/** The lease an `admin.export.run` claim holds (`jobs/lease.ts`, shared with the report run's). */
const EXPORT_LEASE: Lease = {
  table: (tx) => tx`app.export_job j`,
  leaseSeconds: EXPORT_JOB_LEASE_SECONDS,
  maxClaims: EXPORT_JOB_MAX_CLAIMS,
  abandoned: `ERR_INTERNAL: the export was claimed ${EXPORT_JOB_MAX_CLAIMS} times and never finished; every worker that built it stopped`,
};
/** The pg-boss options every `admin.export.run` job is enqueued with — `leaseJobOptions` over the export's
 *  own lease, the rule `REPORT_RUN_JOB_OPTIONS` follows. */
export const EXPORT_JOB_JOB_OPTIONS: LeaseJobOptions = leaseJobOptions(EXPORT_LEASE);

export interface ExportJobRow {
  id: string;
  companyId: string;
  requestedBy: string;
  format: ExportFormat;
  status: ExportStatus;
  readableModules: readonly string[];
  lotAttachments: boolean;
  includeAttachments: boolean;
  tableCount: number | null;
  /** `bigint` columns travel as decimal strings, so no count is ever rounded through a JavaScript number. */
  rowCount: string | null;
  byteSize: string | null;
  objectKey: string | null;
  /** Lower-case hex, so a caller can compare a download without a Buffer. */
  sha256: string | null;
  manifest: unknown;
  startedAt: string | null;
  /** Claims taken so far — the fencing token the worker passes back to `completeExportJob`/`failExportJob`. */
  attempts: number;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
}

interface RawJob {
  id: string;
  company_id: string;
  requested_by: string;
  format: ExportFormat;
  status: ExportStatus;
  readable_modules: string[];
  lot_attachments: boolean;
  include_attachments: boolean;
  table_count: number | null;
  row_count: string | null;
  byte_size: string | null;
  object_key: string | null;
  sha256: string | null;
  manifest: unknown;
  started_at: string | null;
  attempts: number;
  finished_at: string | null;
  error: string | null;
  created_at: string;
}

/**
 * The SELECT list every read below shares, so one column list cannot drift from another. It is a postgres.js
 * fragment, never a string of SQL (§3.3, test 27). `created_at` keeps its microseconds: it is the list's
 * keyset, and a cursor truncated to milliseconds would skip every row created later in the same millisecond
 * as the page's last one (the rule 7A's run store follows).
 */
function selectList(tx: Sql) {
  return tx`j.id, j.company_id, j.requested_by, j.format, j.status, j.readable_modules,
            j.lot_attachments, j.include_attachments, j.table_count,
            j.row_count::text as row_count, j.byte_size::text as byte_size, j.object_key,
            encode(j.sha256, 'hex') as sha256, j.manifest,
            to_char(j.started_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at,
            j.attempts,
            to_char(j.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as finished_at,
            j.error,
            to_char(j.created_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
}

function toRow(raw: RawJob): ExportJobRow {
  return {
    id: raw.id,
    companyId: raw.company_id,
    requestedBy: raw.requested_by,
    format: raw.format,
    status: raw.status,
    readableModules: raw.readable_modules,
    lotAttachments: raw.lot_attachments,
    includeAttachments: raw.include_attachments,
    tableCount: raw.table_count,
    rowCount: raw.row_count,
    byteSize: raw.byte_size,
    objectKey: raw.object_key,
    sha256: raw.sha256,
    manifest: raw.manifest,
    startedAt: raw.started_at,
    attempts: raw.attempts,
    finishedAt: raw.finished_at,
    error: raw.error,
    createdAt: raw.created_at,
  };
}

/** `<tenant_id>/exports/<export_job_id>/<attempt>.tar.gz` — server-generated from ids alone, so no client path
 *  can reach the store (SAH-038; the rule §4.5.8's `objectKeyFor` and 7A's `reportObjectKeyFor` follow). The
 *  claim's `attempts` is in the key for the reason `reportObjectKeyFor` gives (second review, finding 2): a
 *  superseded worker writes its own object, never over the archive whose digest its successor recorded. */
export function exportObjectKeyFor(tenantId: string, exportJobId: string, attempt: number): string {
  return `${tenantId}/exports/${exportJobId}/${attempt}.tar.gz`;
}

export interface NewExportJob {
  companyId: string;
  format: ExportFormat;
  readableModules: readonly string[];
  lotAttachments: boolean;
  includeAttachments: boolean;
}

/** `requested_by` is left to its column default and `app.stamp_actor` (§3.3): the acting principal. */
export async function createExportJob(tx: Sql, input: NewExportJob): Promise<ExportJobRow> {
  const [raw] = await tx<RawJob[]>`
    insert into app.export_job as j
      (tenant_id, company_id, format, status, readable_modules, lot_attachments, include_attachments)
    values (app.current_tenant(), ${input.companyId}::uuid, ${input.format}, 'queued',
            ${[...input.readableModules]}::text[], ${input.lotAttachments}, ${input.includeAttachments})
    returning ${selectList(tx)}`;
  return toRow(raw!);
}

export async function getExportJob(tx: Sql, id: string): Promise<ExportJobRow | null> {
  const [raw] = await tx<RawJob[]>`
    select ${selectList(tx)} from app.export_job j where j.id = ${id}::uuid`;
  return raw === undefined ? null : toRow(raw);
}

export interface ExportJobQueryParams {
  companyId: string;
  /** Narrows the list to one requester's jobs — the export routes pass the caller (ADR 0070). */
  requestedBy?: string;
  status?: ExportStatus;
  limit: number;
  cursor?: { createdAt: string; id: string } | null;
}

/** Keyset-paged on `(created_at, id)`, newest first — the order `export_job_company_created_idx` serves. */
export async function listExportJobs(
  tx: Sql,
  params: ExportJobQueryParams,
): Promise<ExportJobRow[]> {
  const byStatus = params.status === undefined ? tx`` : tx`and j.status = ${params.status}`;
  const byRequester =
    params.requestedBy === undefined ? tx`` : tx`and j.requested_by = ${params.requestedBy}::uuid`;
  const after =
    params.cursor === undefined || params.cursor === null
      ? tx``
      : tx`and (j.created_at, j.id) < (${params.cursor.createdAt}::timestamptz, ${params.cursor.id}::uuid)`;
  const rows = await tx<RawJob[]>`
    select ${selectList(tx)} from app.export_job j
     where j.company_id = ${params.companyId}::uuid ${byRequester} ${byStatus} ${after}
     order by j.created_at desc, j.id desc
     limit ${params.limit}`;
  return rows.map(toRow);
}

/**
 * `queued → running`, conditionally — or the reclaim of an export whose worker died (Phase 7 review, finding
 * 2); the rule `claimReportRun` states, over `EXPORT_JOB_LEASE_SECONDS` and `EXPORT_JOB_MAX_CLAIMS`. A second
 * delivery of a FINISHED job gets null and is a no-op rather than a second archive; a `running` row under a
 * live claim gets null too, and the handler enqueues ONE follow-up due after the lease
 * (`exportJobFollowUpOptions`; second review, finding 1); a reclaim past the maximum
 * fails the export in the same statement. `started_at` restarts with every claim — it is the lease's start,
 * and the archive's `generatedAt` is the claim that built it.
 */
export async function claimExportJob(tx: Sql, id: string): Promise<ExportJobRow | null> {
  const raw = await claimLeased<RawJob>(tx, EXPORT_LEASE, id, selectList(tx));
  return raw === undefined ? null : toRow(raw);
}

/** The export's status, claim count and remaining lease, on the database's clock (`leaseState`). */
export function exportJobLeaseState(tx: Sql, id: string): Promise<LeaseState | null> {
  return leaseState(tx, EXPORT_LEASE, id);
}

/** The options of the ONE follow-up `admin.export.run` delivery a live claim gets (`leaseFollowUpOptions`). */
export function exportJobFollowUpOptions(id: string, state: LeaseState) {
  return leaseFollowUpOptions(EXPORT_LEASE, id, state);
}

export interface CompleteExportJob {
  id: string;
  objectKey: string;
  sha256: Uint8Array;
  byteSize: number;
  tableCount: number;
  rowCount: number;
  manifest: unknown;
  /** The claim's own `attempts`: a worker whose claim was superseded writes nothing. */
  attempt?: number;
}

/** `running → done`. The archive is stored BEFORE this runs, so a `done` row always names bytes that exist.
 *  `false` when the claim was superseded (nothing written): the caller deletes the object it stored. */
export async function completeExportJob(tx: Sql, input: CompleteExportJob): Promise<boolean> {
  const result = await tx`
    update app.export_job
       set status = 'done', object_key = ${input.objectKey},
           sha256 = ${Buffer.from(input.sha256)},
           byte_size = ${input.byteSize}, table_count = ${input.tableCount},
           row_count = ${input.rowCount}, manifest = ${JSON.stringify(input.manifest)}::text::jsonb,
           finished_at = now(), error = null
     where id = ${input.id}::uuid and status = 'running' ${leaseFence(tx, input.attempt)}`;
  return result.count === 1;
}

/** `queued | running → failed`, with the reason and no artefact (the outcome CHECK refuses both at once). The
 *  reason is capped at `FAILURE_DETAIL_MAX` characters, as `failReportRun` caps a run's (Phase 7 review, finding 6). */
export async function failExportJob(
  tx: Sql,
  input: { id: string; error: string; attempt?: number },
): Promise<void> {
  await tx`
    update app.export_job
       set status = 'failed', error = ${input.error.slice(0, FAILURE_DETAIL_MAX)}, finished_at = now(), object_key = null,
           sha256 = null
     where id = ${input.id}::uuid and status in ('queued', 'running') ${leaseFence(tx, input.attempt)}`;
}
