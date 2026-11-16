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
import { ReportError } from "./errors";

/**
 * The `report_run` lifecycle (contracts §4.11.2, ADR 0067): `queued` by the API in the request's transaction,
 * `running` when the `reporting.render` job claims it, then `done` with an artefact or `failed` with a reason.
 * Every function takes the caller's `withTenant` transaction; RLS bounds the tenant and the callers pass the
 * company they gated.
 */
export type ReportRunStatus = "queued" | "running" | "done" | "failed";

/**
 * How long a `running` claim is trusted (Phase 7 review, finding 2). A claim older than this belonged to a
 * worker that died — pg-boss redelivers its job once `expireInSeconds` lapses — and the redelivery reclaims the
 * run. Ten times the PDF engine's own `REPORT_RENDER_TIMEOUT_MS` (60 s, `apps/worker/src/reports/engines`), so
 * a live render is never mistaken for a dead one; `apps/worker/test/reports/render.test.ts` pins the order.
 */
export const REPORT_RUN_LEASE_SECONDS = 600;
/** Claims a run may take before the next is refused and the run FAILED instead: a run that kills its worker
 *  every time it renders must end `failed`, not `running` forever. */
export const REPORT_RUN_MAX_CLAIMS = 3;
/** The lease a `reporting.render` claim holds (`jobs/lease.ts`, shared with the tenant export's). */
const RUN_LEASE: Lease = {
  table: (tx) => tx`app.report_run r`,
  leaseSeconds: REPORT_RUN_LEASE_SECONDS,
  maxClaims: REPORT_RUN_MAX_CLAIMS,
  abandoned: `ERR_INTERNAL: the run was claimed ${REPORT_RUN_MAX_CLAIMS} times and never finished; every worker that rendered it stopped (narrow the parameters, or report it)`,
};
/** The pg-boss options every `reporting.render` job is enqueued with — `leaseJobOptions` over the run's lease
 *  (`expireInSeconds` = the lease; `retryLimit` = the claims plus two). */
export const REPORT_RUN_JOB_OPTIONS: LeaseJobOptions = leaseJobOptions(RUN_LEASE);

export interface ReportRunRow {
  id: string;
  companyId: string;
  reportDefinitionId: string;
  savedViewId: string | null;
  parameters: Readonly<Record<string, string>>;
  format: "pdf" | "xlsx" | "csv";
  lang: "en" | "ar";
  status: ReportRunStatus;
  requestedBy: string;
  objectKey: string | null;
  /** Lower-case hex, so a caller can compare a download without a Buffer. */
  sha256: string | null;
  /** When the current claim was taken; null while `queued`. Never on the wire. */
  startedAt: string | null;
  /** Claims taken so far — the fencing token a worker passes back to `completeReportRun`/`failReportRun`. */
  attempts: number;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
}

/**
 * `<tenant_id>/reports/<run_id>/<attempt>.<ext>` — server-generated from ids alone, so no client path can reach
 * the store (SAH-038, the same rule §4.5.8's `objectKeyFor` follows for attachments).
 *
 * The CLAIM's `attempts` is part of the key (Phase 7 second review, finding 2): fencing guards the row, not the
 * store, and under one key per run a superseded worker that woke up `put` its stale bytes over the bytes its
 * successor had stored and recorded the digest of. Each claim now writes its own object; the row names the one
 * its completing claim stored (`completeReportRun`), and the download reads that stored key — so the bytes
 * served are always the bytes whose digest the row holds.
 */
export function reportObjectKeyFor(
  tenantId: string,
  runId: string,
  extension: string,
  attempt: number,
): string {
  return `${tenantId}/reports/${runId}/${attempt}.${extension}`;
}

/**
 * The SELECT list every read below shares, so one column list cannot drift from another. `created_at` keeps
 * its microseconds: it is the list's keyset, and a cursor truncated to milliseconds would skip every row
 * created later in the same millisecond as the page's last one.
 */
function selectList(tx: Sql) {
  return tx`r.id, r.company_id, r.report_definition_id, r.saved_view_id, r.parameters,
            r.format, r.lang, r.status, r.requested_by, r.object_key,
            encode(r.sha256, 'hex') as sha256,
            to_char(r.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as started_at,
            r.attempts,
            to_char(r.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as finished_at,
            r.error,
            to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
}

interface RawRun {
  id: string;
  company_id: string;
  report_definition_id: string;
  saved_view_id: string | null;
  parameters: Record<string, string>;
  format: "pdf" | "xlsx" | "csv";
  lang: "en" | "ar";
  status: ReportRunStatus;
  requested_by: string;
  object_key: string | null;
  sha256: string | null;
  started_at: string | null;
  attempts: number;
  finished_at: string | null;
  error: string | null;
  created_at: string;
}

function toRow(raw: RawRun): ReportRunRow {
  return {
    id: raw.id,
    companyId: raw.company_id,
    reportDefinitionId: raw.report_definition_id,
    savedViewId: raw.saved_view_id,
    parameters: raw.parameters,
    format: raw.format,
    lang: raw.lang,
    status: raw.status,
    requestedBy: raw.requested_by,
    objectKey: raw.object_key,
    sha256: raw.sha256,
    startedAt: raw.started_at,
    attempts: raw.attempts,
    finishedAt: raw.finished_at,
    error: raw.error,
    createdAt: raw.created_at,
  };
}

export interface NewReportRun {
  companyId: string;
  reportDefinitionId: string;
  savedViewId?: string | null;
  parameters: Readonly<Record<string, string>>;
  format: "pdf" | "xlsx" | "csv";
  lang: "en" | "ar";
}

/** `requested_by` is left to its column default and `app.stamp_actor` (§3.3): the acting principal. */
export async function createReportRun(tx: Sql, input: NewReportRun): Promise<ReportRunRow> {
  const [raw] = await tx<RawRun[]>`
    insert into app.report_run as r
      (tenant_id, company_id, report_definition_id, saved_view_id, parameters, format, lang, status)
    values (app.current_tenant(), ${input.companyId}::uuid, ${input.reportDefinitionId}::uuid,
            ${input.savedViewId ?? null}::uuid, ${JSON.stringify(input.parameters)}::text::jsonb,
            ${input.format}, ${input.lang}, 'queued')
    returning ${selectList(tx)}`;
  return toRow(raw!);
}

export async function getReportRun(tx: Sql, runId: string): Promise<ReportRunRow | null> {
  const [raw] = await tx<RawRun[]>`
    select ${selectList(tx)} from app.report_run r where r.id = ${runId}::uuid`;
  return raw === undefined ? null : toRow(raw);
}

/**
 * The run, its definition and the company's base currency, in one read.
 *
 * `baseCurrency` is read here rather than sniffed from the rows because most datasets carry no `currency`
 * column at all — `item_profitability`, `stock_valuation` and every `base_*` amount are already in the
 * company's base currency by construction (contracts §4.3.3). Without it the money formatter is handed the
 * empty string and renders every money cell as `XXX 1,234.50`, which is a WRONG report rather than a failing
 * one, so the value comes back from the transaction that is already open.
 */
export async function loadRunDefinition(
  tx: Sql,
  runId: string,
): Promise<{ run: ReportRunRow; definition: unknown; baseCurrency: string } | null> {
  const [raw] = await tx<(RawRun & { definition: unknown; base_currency: string })[]>`
    select ${selectList(tx)}, d.definition, c.base_currency
      from app.report_run r
      join app.report_definition d on d.id = r.report_definition_id
      join app.company           c on c.id = r.company_id
     where r.id = ${runId}::uuid`;
  return raw === undefined
    ? null
    : { run: toRow(raw), definition: raw.definition, baseCurrency: raw.base_currency.trim() };
}

/**
 * `queued → running`, conditionally — or the reclaim of a run whose worker died (Phase 7 review, finding 2).
 *
 * - A `queued` row is claimed. pg-boss retries (§4.2.6), and a second delivery of a job whose first delivery
 *   FINISHED finds the row `done` or `failed` and gets null: a no-op, never a second render.
 * - A `running` row whose claim is older than `REPORT_RUN_LEASE_SECONDS` is reclaimed: its worker died after
 *   claiming (pg-boss redelivered the job when it expired), and without this the run stayed `running` forever.
 * - A `running` row under a LIVE claim gets null; the handler tells it apart from a settled run
 *   (`reportRunLeaseState`) and enqueues ONE follow-up delivery due after the lease
 *   (`reportRunFollowUpOptions`) — never a throw, which spent pg-boss's retries before the lease lapsed
 *   (second review, finding 1).
 *
 * Every claim increments `attempts`, the fencing token the worker hands back to `completeReportRun` and
 * `failReportRun`, so a superseded worker that wakes up cannot overwrite its successor's outcome. A reclaim
 * that would be claim number `REPORT_RUN_MAX_CLAIMS + 1` FAILS the run instead, in the same statement, and the
 * row it returns says `failed` — the handler then has nothing to do.
 */
export async function claimReportRun(tx: Sql, runId: string): Promise<ReportRunRow | null> {
  const raw = await claimLeased<RawRun>(tx, RUN_LEASE, runId, selectList(tx));
  return raw === undefined ? null : toRow(raw);
}

/** The run's status, claim count and remaining lease, on the database's clock (`leaseState`). */
export function reportRunLeaseState(tx: Sql, runId: string): Promise<LeaseState | null> {
  return leaseState(tx, RUN_LEASE, runId);
}

/** The options of the ONE follow-up `reporting.render` delivery a live claim gets (`leaseFollowUpOptions`). */
export function reportRunFollowUpOptions(runId: string, state: LeaseState) {
  return leaseFollowUpOptions(RUN_LEASE, runId, state);
}

/** `running → done`. The object is stored BEFORE this runs (the handler's step 5), so a `done` row always
 *  names bytes that exist; the CHECK refuses a `done` row without both columns. `attempt` is the claim's own
 *  `attempts`: a worker whose claim was superseded writes nothing — and learns so from the `false` this
 *  returns, so it can delete the object it stored under its own claim's key. */
export async function completeReportRun(
  tx: Sql,
  input: { runId: string; objectKey: string; sha256: Uint8Array; attempt?: number },
): Promise<boolean> {
  const result = await tx`
    update app.report_run
       set status = 'done', object_key = ${input.objectKey},
           sha256 = ${Buffer.from(input.sha256)}, finished_at = now(), error = null
     where id = ${input.runId}::uuid and status = 'running' ${leaseFence(tx, input.attempt)}`;
  return result.count === 1;
}

/** `→ failed`, with the reason the status resource shows a waiting user. Capped at `FAILURE_DETAIL_MAX` characters. With
 *  `attempt`, only while that claim is still the current one. */
export async function failReportRun(
  tx: Sql,
  input: { runId: string; error: string; attempt?: number },
): Promise<void> {
  await tx`
    update app.report_run
       set status = 'failed', error = ${input.error.slice(0, FAILURE_DETAIL_MAX)}, finished_at = now()
     where id = ${input.runId}::uuid and status in ('queued', 'running') ${leaseFence(tx, input.attempt)}`;
}

/** The four fields a caller may filter a run list on. `object_key` and `sha256` are deliberately absent: a
 *  filter over them is a probe of another principal's artefact by another name. */
export const RUN_FILTER_FIELDS = ["status", "format", "lang", "report_definition_id"] as const;

export interface FilterClauseLike {
  field: string;
  op: string;
  value: string;
}

export interface ReportRunQueryParams {
  companyId: string;
  filters: readonly FilterClauseLike[];
  limit: number;
  cursor?: { createdAt: string; id: string } | null;
}

/**
 * Newest first, keyset-paged on `(created_at, id)`, at most 1,000 rows a page.
 *
 * Only the runs whose DEFINITION's own read code the ACTING principal holds company-wide (Phase 7 review,
 * finding 4): the single-run and content routes re-resolve that code on every read (`requireReportRead`), and
 * a list gated on the export code alone handed an export-only principal every run's parameters, definition
 * and requester. The predicate is `app.actor_has(<definition's permission>, company, null)` — the same call
 * with the same NULL branch — so the list and the single-run read can never disagree, and it sits in the
 * WHERE, so a page is never short of rows the caller may see.
 *
 * The codes are resolved ONCE per call (second review, finding 6), not per run row: the distinct permissions
 * of the tenant's definitions (a handful), each asked of `app.actor_has` once, become a bound array the list
 * compares against. The list itself then carries no function call per row, walks `report_run_recent_idx`
 * newest first and stops at its limit; a caller who holds none of the codes gets an empty page without it.
 */
export async function listReportRuns(
  tx: Sql,
  params: ReportRunQueryParams,
): Promise<ReportRunRow[]> {
  let clause = tx``;
  for (const f of params.filters) {
    if (!(RUN_FILTER_FIELDS as readonly string[]).includes(f.field)) {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `filter field '${f.field}' is not filterable on report runs; the fields are ${RUN_FILTER_FIELDS.join(", ")}`,
      );
    }
    if (f.op !== "eq") {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `filter field '${f.field}' supports only the 'eq' operator`,
      );
    }
    // Each branch is a literal fragment; the field never reaches SQL as text (test 27).
    const predicate =
      f.field === "status"
        ? tx`r.status = ${f.value}`
        : f.field === "format"
          ? tx`r.format = ${f.value}`
          : f.field === "lang"
            ? tx`r.lang = ${f.value}`
            : tx`r.report_definition_id = ${f.value}::uuid`;
    clause = tx`${clause} and ${predicate}`;
  }
  const keyset =
    params.cursor == null
      ? tx``
      : tx`and (r.created_at, r.id) < (${params.cursor.createdAt}::timestamptz, ${params.cursor.id}::uuid)`;
  // Every definition the tenant holds (RLS bounds it), not only this company's: a run's definition is bound to
  // it by `(tenant_id, report_definition_id)`, and the per-row predicate this replaces asked the same.
  const [held] = await tx<{ codes: string[] }[]>`
    select coalesce(array_agg(p.code order by p.code), '{}'::text[]) as codes
      from (select distinct d.definition ->> 'permission' as code from app.report_definition d) p
     where app.actor_has(p.code, ${params.companyId}::uuid, null::uuid)`;
  if (held === undefined || held.codes.length === 0) return [];
  const raws = await tx<RawRun[]>`
    select ${selectList(tx)}
      from app.report_run r
      join app.report_definition d on d.id = r.report_definition_id
     where r.company_id = ${params.companyId}::uuid ${clause} ${keyset}
       and (d.definition ->> 'permission') = any(${held.codes}::text[])
     order by r.created_at desc, r.id desc
     limit ${Math.min(Math.max(params.limit, 1), 1000)}`;
  return raws.map(toRow);
}
