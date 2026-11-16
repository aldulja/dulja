import type { Sql } from "postgres";
import { JobNotInsertedError, type JobClient, type JobEnvelope } from "../jobs/enqueue";
import type { TicketBatchInput } from "./apply";
import { SyncError } from "./enrolment";

/** What `POST /v1/sync/tickets` queues for a batch over `SYNC_BATCH_SYNC_LIMIT` (§4.10.4): the terminal the
 *  signature named, never the body's, and the batch as validated. */
export interface QueuedSyncBatch {
  terminalId: string;
  batch: TicketBatchInput;
}

/** The job that carries a queued batch. `queued` while pg-boss may still run it (`created`, `retry` between
 *  attempts, `active`); otherwise how it finished: `completed`, or `failed` once its retries are spent. */
export interface QueuedSyncJob {
  jobId: string;
  state: "queued" | "completed" | "failed";
}

/**
 * Queues an over-size batch as `pos.sync.apply` keyed by its `batchId` (§4.10.4) and answers the job that
 * carries it: the job this call inserted (`queued`) or, for a re-send of the same batch, the job already
 * holding the key, with its state.
 *
 * **Why a re-send needs this (PR 12 review).** `pos.sync.apply` is a `standard` queue, so `createJobClient`
 * gives the keyed send 0D's 24-hour `singletonSeconds` slot, and pg-boss's `job_i4` refuses a second job for
 * the key in that UTC-day slot whatever state the first is in, `cancelled` apart. `enqueue` reports the refusal
 * as `JobNotInsertedError`, and the route once let it surface as a 500, so the recovery §4.10.4 prescribes
 * ("re-send the same batch") failed for the rest of the day, even after the queued job had finished. Here the
 * refusal is answered with the job that holds the slot, read through the same index on the same transaction:
 * nothing new is inserted, which is what the route's `singletonKey` promises. **The state is returned, not
 * hidden:** a holder that has completed or failed is not `queued`, and the route must not say it is.
 *
 * **Only the same batch gets that job back.** The holder's tenant, terminal and batch must all equal this
 * request's. They are compared in SQL, and the holder's id and state leave the database only when they do, so
 * another tenant's job id never reaches this process. Anything else is a different batch reusing the `batchId`
 * and is refused with `ERR_VALIDATION_FAILED`: answering it 202 would report as queued tickets that no job
 * carries.
 *
 * pg-boss inserts with `ON CONFLICT DO NOTHING`, so the transaction is intact when `JobNotInsertedError` is
 * caught. Every other error is re-thrown unchanged, and so is that one if no holder is found, which only a job
 * cancelled between the two statements could cause.
 */
export async function enqueueSyncBatch(
  tx: Sql,
  jobs: JobClient,
  job: JobEnvelope<QueuedSyncBatch>,
): Promise<QueuedSyncJob> {
  const { terminalId, batch } = job.payload;
  try {
    const jobId = await jobs.enqueue(tx, "pos.sync.apply", job, { singletonKey: batch.batchId });
    return { jobId, state: "queued" };
  } catch (error) {
    if (!(error instanceof JobNotInsertedError)) throw error;
    // The predicate and key expression are `job_i4`'s, the index that refused the insert; the newest slot is
    // the current one. `data->'payload'->'batch'` is the JSON pg-boss stored, so jsonb equality with this
    // batch's JSON is "the same batch" regardless of key order. The JSON goes up as TEXT and is parsed by the
    // cast: a parameter typed jsonb would be serialised again by postgres.js, into one JSON string. The outer
    // select returns a holder's id and state only for the same batch, so a different one yields nulls.
    const [holder] = await tx<{ id: string | null; state: string | null; same: boolean }[]>`
      select case when slot.same then slot.id end as id,
             case when slot.same then slot.state end as state,
             slot.same
        from (select id::text as id,
                     state::text as state,
                     coalesce(data->>'tenantId' = ${job.tenantId}
                              and data->'payload'->>'terminalId' = ${terminalId}
                              and data->'payload'->'batch' = ${JSON.stringify(batch)}::text::jsonb,
                              false) as same
                from pgboss.job
               where name = 'pos.sync.apply'
                 and coalesce(singleton_key, '') = ${batch.batchId}
                 and singleton_on is not null
                 and state <> 'cancelled'
               order by singleton_on desc, created_on desc
               limit 1) as slot`;
    if (!holder) throw error;
    if (!holder.same || holder.id === null)
      throw new SyncError(
        "ERR_VALIDATION_FAILED",
        `batchId ${batch.batchId} is already used by another batch`,
      );
    const state =
      holder.state === "completed" || holder.state === "failed" ? holder.state : "queued";
    return { jobId: holder.id, state };
  }
}
