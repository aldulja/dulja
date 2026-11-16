import type { Sql } from "postgres";
import type { EnqueueOptions } from "./enqueue";
import type { SqlFragment } from "../reports/sql-fragment";

/**
 * The ONE cap on a stored failure reason — a report run's (`report_run.error`) and a tenant export's
 * (`export_job.error`) — and on the `CODE: detail` the worker's `failureDetail` builds. It lives here because
 * `packages/db` may not import an application (§3.1): the worker imports it from `@dulja/db`, so the helper and
 * the stores can never cap at two figures (Phase 7 second review, finding 7).
 */
export const FAILURE_DETAIL_MAX = 2000;

/**
 * A row claimed by a worker under a LEASE (Phase 7 review, finding 2; second review, finding 7): the
 * `report_run` and `export_job` lifecycles share this machinery and differ only in the figures.
 *
 * - `table` is the literal table fragment WITH the alias the caller's select list qualifies its columns by
 *   (`app.report_run r`, `app.export_job j`) — authored by the caller, never a name assembled from a string
 *   (§3.3, test 27). Both tables carry `status`, `started_at`, `attempts`, `finished_at` and `error`.
 * - `leaseSeconds` is how long a `running` claim is trusted: an older one belonged to a worker that died.
 * - `maxClaims` is how many claims a row may take; the next claim FAILS it instead, with `abandoned`.
 */
export interface Lease {
  readonly table: (tx: Sql) => SqlFragment;
  readonly leaseSeconds: number;
  readonly maxClaims: number;
  /** The `failed` reason a row claimed `maxClaims` times gets on the claim after. */
  readonly abandoned: string;
}

/**
 * The pg-boss options every job over a leased row is enqueued with — stated, not defaulted:
 * - `expireInSeconds` = the lease, so a delivery whose worker died is redelivered no sooner than the lease
 *   lapses (pg-boss adds `retryDelaySeconds`, with backoff, before the retry starts), and the reclaim succeeds.
 *   A row whose worker renews its claim (`renewLeased`, the import run's heartbeat) can outlive its job's expiry:
 *   pg-boss then redelivers while the first handler still runs, and that delivery finds a LIVE claim and defers
 *   past it (`leaseFollowUpOptions`) — it never loads beside the first;
 * - `retryLimit` = the claims plus two: one delivery more than the claims fails an abandoned row, and one more
 *   absorbs a delivery whose own failure write failed.
 */
export interface LeaseJobOptions extends EnqueueOptions {
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly expireInSeconds: number;
}

export function leaseJobOptions(lease: Lease): LeaseJobOptions {
  return {
    retryLimit: lease.maxClaims + 2,
    retryDelaySeconds: 60,
    expireInSeconds: lease.leaseSeconds,
  };
}

/**
 * `queued → running`, conditionally — or the reclaim of a row whose worker died.
 *
 * - A `queued` row is claimed. A second delivery of a job whose first delivery FINISHED finds the row `done` or
 *   `failed` and gets `undefined`: a no-op, never a second render or archive.
 * - A `running` row whose claim is older than `leaseSeconds` is reclaimed.
 * - A `running` row under a LIVE claim gets `undefined`; the handler tells it apart from a settled row.
 *
 * Every claim increments `attempts`, the fencing token the worker hands back to its complete and fail writes
 * (`leaseFence`), so a superseded worker that wakes up cannot overwrite its successor's outcome. A reclaim that
 * would be claim number `maxClaims + 1` FAILS the row instead, in the same statement, and the row it returns
 * says `failed`. `started_at` restarts with every claim: it is the lease's start.
 */
export async function claimLeased<R extends object>(
  tx: Sql,
  lease: Lease,
  id: string,
  returning: SqlFragment,
): Promise<R | undefined> {
  const [raw] = await tx<R[]>`
    update ${lease.table(tx)}
       set status      = case when attempts >= ${lease.maxClaims} then 'failed' else 'running' end,
           error       = case when attempts >= ${lease.maxClaims} then ${lease.abandoned} else error end,
           finished_at = case when attempts >= ${lease.maxClaims} then now() else null end,
           started_at  = now(),
           attempts    = attempts + 1
     where id = ${id}::uuid
       and (status = 'queued'
            or (status = 'running'
                and started_at < now() - make_interval(secs => ${lease.leaseSeconds})))
    returning ${returning}`;
  return raw;
}

/** What a heartbeat found: the claim renewed, still fresh enough to need no write, or taken over by another claim. */
export type LeaseRenewal = "renewed" | "fresh" | "superseded";

/**
 * A HEARTBEAT on a live claim (9B review, finding 5): restarts `started_at` — the lease's start — while the claim
 * `attempt` is still the row's current one and `running`, so a worker that is making progress is never taken over by
 * a redelivery that arrives once `leaseSeconds` have passed since the claim. `minAgeSeconds` throttles it: a claim
 * renewed less than that long ago is left alone (`fresh`), because every renewal is an audited UPDATE of the row.
 * `superseded` means the row is no longer this claim's — reclaimed after a lapse, or settled — and the worker must
 * stop before it writes anything more. The row is locked (`for update`), so a reclaim cannot slip between the
 * check and the renewal.
 */
export async function renewLeased(
  tx: Sql,
  lease: Lease,
  id: string,
  attempt: number,
  minAgeSeconds: number,
): Promise<LeaseRenewal> {
  const [row] = await tx<{ due: boolean }[]>`
    select started_at < now() - make_interval(secs => ${minAgeSeconds}) as due
      from ${lease.table(tx)}
     where id = ${id}::uuid and status = 'running' and attempts = ${attempt}
       for update`;
  if (row === undefined) return "superseded";
  if (!row.due) return "fresh";
  await tx`
    update ${lease.table(tx)} set started_at = now()
     where id = ${id}::uuid and status = 'running' and attempts = ${attempt}`;
  return "renewed";
}

/** The fencing predicate: a worker's write lands only while the claim it took is still the current one. With
 *  no `attempt` (an API-side write), no fence. */
export function leaseFence(tx: Sql, attempt: number | undefined): SqlFragment {
  return attempt === undefined ? tx`` : tx`and attempts = ${attempt}`;
}

/** What a delivery that could not claim reads back: the row's status, its claim count and how long its current
 *  claim has left (whole seconds, rounded UP, never negative; 0 for a row with no claim). */
export interface LeaseState {
  readonly status: string;
  readonly attempts: number;
  readonly remainingSeconds: number;
}

/**
 * The row's lease, read on the database's clock — the clock `claimLeased` compares against — so the follow-up a
 * delivery schedules from it (`leaseFollowUpOptions`) can never fire before the claim it waits on has lapsed.
 * `null` for a row this transaction cannot see (another tenant's id under RLS, or none at all).
 */
export async function leaseState(tx: Sql, lease: Lease, id: string): Promise<LeaseState | null> {
  const [row] = await tx<{ status: string; attempts: number; remaining_seconds: number }[]>`
    select status, attempts,
           coalesce(greatest(0, ceil(extract(epoch from
             (started_at + make_interval(secs => ${lease.leaseSeconds})) - clock_timestamp()))), 0)::int
             as remaining_seconds
      from ${lease.table(tx)}
     where id = ${id}::uuid`;
  return row === undefined
    ? null
    : { status: row.status, attempts: row.attempts, remainingSeconds: row.remaining_seconds };
}

/** How long after a live claim's lease lapses its follow-up delivery is due: enough that the reclaim's own
 *  `started_at < now() - lease` holds on arrival, whatever the rounding. */
export const LEASE_FOLLOW_UP_MARGIN_SECONDS = 30;

/**
 * The follow-up a delivery that found a LIVE claim enqueues instead of throwing (Phase 7 second review,
 * finding 1). Throwing spent one of pg-boss's retries per delivery, with backoff, and the retries ran out long
 * before an hour's export lease (60 + 120 + 240 + 480 + 960 s < 3,600 s) — the row stayed `running` with no job
 * left to reclaim or fail it. A follow-up is a NEW job with its own full retry budget, due after the lease:
 *
 * - `startAfterSeconds` = the claim's remaining lease plus `LEASE_FOLLOW_UP_MARGIN_SECONDS`, so it arrives to a
 *   claim it can take over (or to a settled row, and is a no-op);
 * - `singletonKey` = `<id>:lease:<attempts>` — ONE follow-up per claim, however many deliveries saw it live
 *   (pg-boss refuses the duplicate, `JobNotInsertedError`, and the delivery treats that as "already scheduled").
 *   The next claim has a new `attempts`, so its own follow-up is never refused by this one's.
 *
 * Every claim therefore has a delivery due after it lapses, and `claimLeased` fails the row on the claim after
 * `maxClaims`: a row that never finishes ends `failed`, without depending on the retry budget.
 */
export function leaseFollowUpOptions(
  lease: Lease,
  id: string,
  state: LeaseState,
): LeaseJobOptions & { singletonKey: string; startAfterSeconds: number } {
  return {
    ...leaseJobOptions(lease),
    singletonKey: leaseFollowUpKey(id, state.attempts),
    startAfterSeconds: state.remainingSeconds + LEASE_FOLLOW_UP_MARGIN_SECONDS,
  };
}

/** `<id>:lease:<attempts>` — the follow-up's key for one claim of one row. */
export function leaseFollowUpKey(id: string, attempts: number): string {
  return `${id}:lease:${attempts}`;
}
