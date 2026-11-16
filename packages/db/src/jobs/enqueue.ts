import { PgBoss } from "pg-boss";
import type { Sql } from "postgres";
import { JOBS, type JobName } from "./names";
import type { JobPayload } from "./payloads";
export { JOBS, type JobName };
export type { JobPayload };
export interface JobEnvelope<T = unknown> {
  readonly tenantId: string;
  readonly requestId: string;
  readonly payload: T;
}
export interface EnqueueOptions {
  singletonKey?: string;
  startAfterSeconds?: number;
  retryLimit?: number;
  retryDelaySeconds?: number;
  /** How long a delivery may stay `active` before pg-boss fails it and, retries remaining, redelivers it — the
   *  only redelivery a worker that DIED gets. pg-boss's queue default (15 minutes) when omitted. */
  expireInSeconds?: number;
}
export interface JobClient {
  enqueue<N extends JobName>(
    tx: Sql,
    name: N,
    job: JobEnvelope<JobPayload[N]>,
    options?: EnqueueOptions,
  ): Promise<string>;
}

/**
 * The jobs whose queue is created with pg-boss's **`stately`** policy (contracts §4.2.6, ADR 0007 decision 5 as
 * amended): projection and costing jobs use a company key; tax submission uses a transmission key
 * and schedules a subsequent poll while its current job is active. pg-boss 12's `stately`
 * unique index (`job_i3`, `(name, state, coalesce(singleton_key, ''))` over `state <= 'active'`) admits one job per
 * key in each of `created`, `retry` and `active`, and its fetch will not claim a second `active` one — so:
 *
 * - a request while one is QUEUED (`created`, not started) collapses into it, which is safe because the queued
 *   job has not yet read anything;
 * - a request while one is ACTIVE inserts a new queued job, because the running job may already have read the
 *   state this request changed, and collapsing into it would lose that change until some later request.
 *
 * Every other queue stays `standard`. The deploy step (`apps/worker/src/install.ts`) and its test twin
 * (`packages/db/test/boss.ts`) create each queue with `queuePolicy(name)`, and nothing else creates one.
 */
export const STATELY_JOBS: readonly JobName[] = [
  "accounting.tax.submit",
  "inventory.cost.replay",
  "accounting.projection.rebuild",
];
export type QueuePolicy = "standard" | "stately";
/** The policy the queue called `name` is created with. `name` is a string, not a `JobName`, because the install
 *  step also creates each scheduled job's `<name>.fanout` queue, and those are all `standard`. */
export function queuePolicy(name: string): QueuePolicy {
  return (STATELY_JOBS as readonly string[]).includes(name) ? "stately" : "standard";
}

/**
 * What `createJobClient`'s `enqueue` throws when pg-boss inserts nothing and no queued job took the request
 * (ADR 0007 decision 5: never a silent non-insert — a job that never runs is exactly SAH-005). Two cases reach it:
 *
 * - a keyed job on a `standard` queue whose 24-hour `singletonSeconds` slot is already taken (by a job in any
 *   state but `cancelled` — pg-boss's `job_i4`), which is 0D's original meaning and SAH-005's pinned case;
 * - a keyed job on a `stately` queue (`STATELY_JOBS`) whose insert was refused and whose queued job could not be
 *   locked either, `COLLAPSE_ATTEMPTS` times running — which only a worker claiming each queued job in the
 *   instant between the two statements could cause.
 *
 * A stately collapse is NOT this error: `enqueue` resolves with the queued job's id. The insert is pg-boss's
 * `ON CONFLICT DO NOTHING`, so the caller's transaction is intact when this is thrown; no caller catches it.
 */
export class JobNotInsertedError extends Error {
  readonly jobName: JobName;
  readonly singletonKey: string | undefined;
  constructor(jobName: JobName, singletonKey: string | undefined) {
    super(
      [
        "pg-boss did not insert job ",
        jobName,
        ": singletonKey '",
        singletonKey ?? "",
        "' is already queued",
      ].join(""),
    );
    this.name = "JobNotInsertedError";
    this.jobName = jobName;
    this.singletonKey = singletonKey;
  }
}

/** How often a stately collapse re-tries after finding no queued job to lock. A miss means a worker claimed the
 *  queued job between the refused insert and the lock, which frees the `created` slot, so the retried insert
 *  lands; a second miss needs another job queued and claimed inside that same instant. */
const COLLAPSE_ATTEMPTS = 3;

/**
 * The collapse, for a stately job whose insert pg-boss refused because a job for the key is already `created`.
 * The request rides on that job — but only if the job cannot START before this transaction commits: a worker
 * that claimed it in between would read the company's state without this transaction's writes (an
 * invalidated cost tail, a new sale) and nothing would come back for them. So the queued row is locked
 * `FOR SHARE` until commit. pg-boss claims with `FOR UPDATE … SKIP LOCKED`, so a locked job is skipped, never
 * waited on, and several posting transactions may share the lock. Finding no `created` row means a worker
 * claimed it first, and the slot is free again: the insert is retried.
 */
async function collapseIntoQueued(
  tx: Sql,
  name: JobName,
  singletonKey: string,
  send: () => Promise<string | null>,
): Promise<string> {
  for (let attempt = 0; attempt < COLLAPSE_ATTEMPTS; attempt += 1) {
    const [queued] = await tx<{ id: string }[]>`
      select id::text as id from pgboss.job
       where name = ${name} and singleton_key = ${singletonKey}
         and state = 'created' and policy = 'stately'
       for share`;
    if (queued) return queued.id;
    const id = await send();
    if (id !== null) return id;
  }
  throw new JobNotInsertedError(name, singletonKey);
}

export function createJobClient(boss: PgBoss): JobClient {
  return {
    async enqueue(tx, name, job, opts) {
      const db = {
        async executeSql(text: string, values: unknown[] = []) {
          const rows = await tx.unsafe(text, values as never[]);
          return {
            rows: rows as unknown as Record<string, unknown>[],
            rowCount: rows.count ?? rows.length,
          };
        },
      };
      const singletonKey = opts?.singletonKey;
      const stately = queuePolicy(name) === "stately";
      // A keyless job on a stately queue would share ONE slot (pg-boss keys it on '') with every tenant's, so
      // tenant B's request could collapse into tenant A's job and never run. Refused, not defaulted.
      if (stately && singletonKey === undefined)
        throw new Error(
          `${name} is enqueued on a stately queue and needs a singletonKey (the resource it is for)`,
        );
      const send = () =>
        boss.send(name, job as unknown as object, {
          db,
          ...(singletonKey === undefined ? {} : { singletonKey }),
          // The 24-hour throttle slot stays on a keyed STANDARD job only (0D's behaviour, SAH-005's pinned
          // case). On a stately queue it is exactly the defect this client once had: the slot counts a job in
          // every state but cancelled, so a completed job refused every later request for the day.
          ...(singletonKey === undefined || stately ? {} : { singletonSeconds: 86_400 }),
          ...(opts?.startAfterSeconds === undefined ? {} : { startAfter: opts.startAfterSeconds }),
          retryLimit: opts?.retryLimit ?? 3,
          retryDelay: opts?.retryDelaySeconds ?? 60,
          retryBackoff: true,
          ...(opts?.expireInSeconds === undefined ? {} : { expireInSeconds: opts.expireInSeconds }),
        });
      const id = await send();
      if (id !== null) return id;
      if (!stately || singletonKey === undefined) throw new JobNotInsertedError(name, singletonKey);
      return collapseIntoQueued(tx, name, singletonKey, send);
    },
  };
}

export const JOB_NAMES: readonly JobName[] = Object.keys(JOBS) as JobName[];

/**
 * The API process's pg-boss: constructed to SEND only. The worker process owns every worker, the cron fan-out
 * and pg-boss's maintenance, so this instance runs none of them (`supervise: false`, `schedule: false`), never
 * migrates (`migrate: false` — the tables are installed by the deploy step as app_migrator, contracts §4.2.6),
 * and keeps a small pool, because every `send` goes through the CALLER's transaction (`createJobClient`'s `db`
 * executor) and the pool serves only `start()`'s own checks.
 *
 * **It is born with an `error` listener** (code review 2026-09-29). PgBoss is an EventEmitter and emits `error`
 * for a failure no call is awaiting — an idle pool connection the server dropped, a failed internal query — and
 * an EventEmitter `error` with no listener THROWS: in a serving process that is an uncaught exception, and the
 * API dies because Postgres recycled a connection. `onError` receives it instead. Constructing a PgBoss
 * connects to nothing, which is what lets this be tested without a database.
 */
export function createEnqueueBoss(
  connectionString: string,
  onError: (error: unknown) => void,
): PgBoss {
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    migrate: false,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on("error", onError);
  return boss;
}

/** Where an enqueue client's pg-boss `error` goes when the caller names no handler: stderr, never unhandled. */
const writeBossError = (error: unknown): void => {
  process.stderr.write(`pg-boss (enqueue client): ${String(error)}\n`);
};

/**
 * The API process's job client over `createEnqueueBoss`. `onError` is where pg-boss's `error` events go (the
 * API passes its logger). The caller keeps `stop()` and calls it on shutdown: it closes the pool.
 */
export async function startEnqueueClient(
  connectionString: string,
  options: { onError?: (error: unknown) => void } = {},
): Promise<{ jobs: JobClient; stop(): Promise<void> }> {
  const boss = createEnqueueBoss(connectionString, options.onError ?? writeBossError);
  await boss.start();
  return {
    jobs: createJobClient(boss),
    async stop() {
      await boss.stop({ graceful: true });
    },
  };
}
