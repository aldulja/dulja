// apps/worker/src/jobs.ts (5B)
//
// §4.2.6's `JobHandler<N>` is `(sql, job, ctx) => Promise<void>` and takes no JobClient, but the
// e-invoice handler must re-enqueue itself for the poll phase. This is 0D's `log()` / `setLogger()`
// accessor applied to the job client, and for the same reason: the entrypoint owns the pg-boss
// instance and a handler must not construct one.
//
// If 0D or a later slice already shipped an equivalent accessor, USE THAT and delete this file —
// two ways for a handler to reach the job client is hazard 9.

import type { JobClient } from "@dulja/db";

let client: JobClient | null = null;

export function setJobs(next: JobClient): void {
  client = next;
}

export function jobs(): JobClient {
  if (client === null) {
    throw new Error(
      "apps/worker: setJobs() has not run — the entrypoint must call it before any handler",
    );
  }
  return client;
}
