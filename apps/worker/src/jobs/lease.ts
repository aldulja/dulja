import type { Sql } from "postgres";
import {
  JobNotInsertedError,
  withTenant,
  type EnqueueOptions,
  type JobEnvelope,
  type JobPayload,
  type LeaseState,
  type TenantContext,
} from "@dulja/db";
import type { Logger } from "@dulja/contracts";
import { jobs } from "../jobs";

/** The jobs whose rows are claimed under a lease (`@dulja/db`'s `jobs/lease.ts`): 7A's report run, 7C's export and
 *  9B's cut-over load (`app.import_run`, migration 0103). */
export type LeasedJobName = "reporting.render" | "admin.export.run" | "admin.import.run";

/**
 * What a delivery does when its row is held by a LIVE claim (Phase 7 second review, finding 1): it enqueues the
 * claim's ONE follow-up delivery — the same payload, due after the lease (`reportRunFollowUpOptions` /
 * `exportJobFollowUpOptions`) — and returns. It never throws to be retried: a throw spent one of pg-boss's
 * retries per delivery, and they ran out before the lease lapsed, leaving the row `running` with no job left.
 *
 * pg-boss refusing the follow-up (`JobNotInsertedError`) means this claim's follow-up is already scheduled — a
 * duplicate delivery saw the same live claim — and is not an error. Any other enqueue failure throws, so pg-boss
 * retries THIS delivery: the follow-up has not been scheduled, and the retry is what schedules it.
 */
export async function deferPastLease<N extends LeasedJobName>(
  sql: Sql,
  ctx: TenantContext,
  name: N,
  job: JobEnvelope<JobPayload[N]>,
  state: LeaseState,
  options: EnqueueOptions & { singletonKey: string; startAfterSeconds: number },
  logger: Logger,
): Promise<void> {
  try {
    await withTenant(sql, ctx, async (tx) => {
      await jobs().enqueue(
        tx,
        name,
        { tenantId: job.tenantId, requestId: job.requestId, payload: job.payload },
        options,
      );
    });
    logger.info(
      { attempts: state.attempts, start_after_seconds: options.startAfterSeconds },
      "held by a live claim; a follow-up delivery is scheduled after its lease",
    );
  } catch (error) {
    if (!(error instanceof JobNotInsertedError)) throw error;
    logger.info(
      { attempts: state.attempts },
      "held by a live claim; its follow-up delivery is already scheduled",
    );
  }
}
