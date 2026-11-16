import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import type { Sql } from "postgres";
import { createJobClient, JobNotInsertedError, JOBS, type JobClient } from "../../src/jobs/enqueue";
import {
  enqueueSyncBatch,
  type QueuedSyncBatch,
  type QueuedSyncJob,
} from "../../src/sync/batch-queue";
import type { TicketBatchInput } from "../../src/sync/apply";
import { SyncError } from "../../src/sync/enrolment";
import { installBoss, stopBoss } from "../boss";
import { seedTenant, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

// The batch is never applied here, so its terminal needs no row: only its identity is compared.
const batchOf = (terminalId: string, batchId: string): TicketBatchInput => ({
  terminalId,
  batchId,
  tickets: [],
  shifts: [],
  tillEvents: [],
});
const envelope = (s: Seed, payload: QueuedSyncBatch) => ({
  tenantId: s.tenant,
  requestId: payload.batch.batchId,
  payload,
});

/**
 * PR 12 review: a re-send of an over-size batch (§4.10.4's recovery) with the same `batchId` and a fresh
 * Idempotency-Key. `pos.sync.apply` is a `standard` queue, so its keyed send holds a 24-hour slot that pg-boss's
 * `job_i4` keeps for a job in any state but `cancelled`; the bare `enqueue` throws `JobNotInsertedError` for
 * the second send all day, and the route answered it with a 500. These run against a real pg-boss.
 */
describe("enqueueSyncBatch — a re-sent over-size batch gets its job and that job's state back (§4.10.4, PR 12 review)", () => {
  const NAME = "pos.sync.apply";
  let db: Db;
  let boss: PgBoss;
  let jobs: JobClient;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    b = await seedTenant(db, "Beta");
    boss = await installBoss(db, Object.keys(JOBS));
    jobs = createJobClient(boss);
  }, 240_000);
  // `boss.fetch` claims whichever job of the queue is next, so each case starts from an empty queue.
  afterEach(async () => {
    await db.admin`delete from pgboss.job where name = ${NAME}`;
  });
  afterAll(async () => {
    await stopBoss(boss);
    await db.stop();
  });

  const send = (
    s: Seed,
    payload: QueuedSyncBatch,
    client: JobClient = jobs,
  ): Promise<QueuedSyncJob> =>
    withTenant(db.rw, s.tenant, s.system, (tx) =>
      enqueueSyncBatch(tx, client, envelope(s, payload)),
    );
  const rows = (batchId: string) =>
    db.admin<{ id: string; state: string }[]>`
      select id::text as id, state::text as state from pgboss.job
       where name = ${NAME} and singleton_key = ${batchId} order by created_on`;
  const fresh = async (): Promise<QueuedSyncBatch> => {
    const terminalId = await uuidv7(db.admin);
    return { terminalId, batch: batchOf(terminalId, await uuidv7(db.admin)) };
  };

  it("the bare enqueue refuses the re-send with JobNotInsertedError — the 500 the route answered", async () => {
    const queued = await fresh();
    const { jobId: first } = await send(a, queued);
    await expect(
      withTenant(db.rw, a.tenant, a.system, (tx) =>
        jobs.enqueue(tx, NAME, envelope(a, queued), { singletonKey: queued.batch.batchId }),
      ),
    ).rejects.toBeInstanceOf(JobNotInsertedError);
    expect(await rows(queued.batch.batchId)).toEqual([{ id: first, state: "created" }]);
  });

  it("the same batch sent twice, in two transactions, answers the first job's id and inserts one job", async () => {
    const queued = await fresh();
    const first = await send(a, queued);
    expect(first.state).toBe("queued");
    expect(await send(a, queued)).toEqual(first);
    expect(await rows(queued.batch.batchId)).toEqual([{ id: first.jobId, state: "created" }]);
  });

  it("a key order the client changed is still the same batch (jsonb equality)", async () => {
    const queued = await fresh();
    const first = await send(a, queued);
    const { tillEvents, shifts, tickets, batchId, terminalId } = queued.batch;
    const reordered = { tillEvents, shifts, tickets, batchId, terminalId };
    expect(await send(a, { terminalId: queued.terminalId, batch: reordered })).toEqual(first);
    expect(await rows(queued.batch.batchId)).toHaveLength(1);
  });

  it("still the first job once it is RUNNING, or waiting between attempts: both are still queued", async () => {
    const queued = await fresh();
    const { jobId: first } = await send(a, queued);
    const [claimed] = await boss.fetch(NAME);
    expect(claimed?.id).toBe(first);
    expect(await send(a, queued)).toEqual({ jobId: first, state: "queued" });
    await boss.fail(NAME, first);
    expect(await rows(queued.batch.batchId)).toEqual([{ id: first, state: "retry" }]);
    expect(await send(a, queued)).toEqual({ jobId: first, state: "queued" });
  });

  // The slot outlives the job for the UTC day, so a re-send after the job has finished still finds it and
  // still inserts nothing; what changes is the state, which the route must not report as `queued` (the
  // reviewer's any-state finding: a failed job was once answered 202 "queued" with Retry-After until midnight).
  it("names the first job as COMPLETED once it has run, and inserts nothing", async () => {
    const queued = await fresh();
    const { jobId: first } = await send(a, queued);
    const [claimed] = await boss.fetch(NAME);
    expect(claimed?.id).toBe(first);
    await boss.complete(NAME, first);
    expect(await send(a, queued)).toEqual({ jobId: first, state: "completed" });
    expect(await rows(queued.batch.batchId)).toEqual([{ id: first, state: "completed" }]);
  });

  it("names the first job as FAILED once its retries are spent, and inserts nothing", async () => {
    const queued = await fresh();
    const { jobId: first } = await send(a, queued);
    // Its retries spent without waiting out pg-boss's back-off: no attempts remain, so this failure is final.
    await db.admin`update pgboss.job set retry_limit = 0 where id = ${first}::uuid`;
    await boss.fail(NAME, first);
    expect(await send(a, queued)).toEqual({ jobId: first, state: "failed" });
    expect(await rows(queued.batch.batchId)).toEqual([{ id: first, state: "failed" }]);
  });

  it("the transaction stays usable after the refused insert, and a rollback leaves the first job alone", async () => {
    const queued = await fresh();
    const { jobId: first } = await send(a, queued);
    const inside = await withTenant(db.rw, a.tenant, a.system, async (tx: Sql) => {
      const { jobId: id } = await enqueueSyncBatch(tx, jobs, envelope(a, queued));
      const [row] = await tx<{ one: number }[]>`select 1 as one`;
      return { id, one: row!.one };
    });
    expect(inside).toEqual({ id: first, one: 1 });
    await expect(
      withTenant(db.rw, a.tenant, a.system, async (tx) => {
        await enqueueSyncBatch(tx, jobs, envelope(a, queued));
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");
    expect(await rows(queued.batch.batchId)).toEqual([{ id: first, state: "created" }]);
  });

  it("the same batchId from another TERMINAL is refused ERR_VALIDATION_FAILED, and no job is added", async () => {
    const queued = await fresh();
    await send(a, queued);
    const other = await uuidv7(db.admin);
    const error = await send(a, {
      terminalId: other,
      batch: batchOf(other, queued.batch.batchId),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe("ERR_VALIDATION_FAILED");
    expect(await rows(queued.batch.batchId)).toHaveLength(1);
  });

  it("the same batchId from another TENANT is refused, so its job id never crosses the tenant", async () => {
    const queued = await fresh();
    const { jobId: first } = await send(a, queued);
    const error = await send(b, queued).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe("ERR_VALIDATION_FAILED");
    expect((error as SyncError).detail).not.toContain(first);
    expect(await rows(queued.batch.batchId)).toHaveLength(1);
  });

  it("another tenant's job id and state never even reach this process: the holder row comes back blank", async () => {
    // The reviewer's finding: the comparison was in SQL but the id was selected whatever it said, so tenant
    // A's job id sat in tenant B's request. Every row the helper's own queries return is recorded here (the
    // enqueue's insert goes through `tx.unsafe`, which the proxy passes through untouched).
    const queued = await fresh();
    const { jobId: first } = await send(a, queued);
    const seen: unknown[][] = [];
    const error = await withTenant(db.rw, b.tenant, b.system, (tx: Sql) => {
      const recording = new Proxy(tx, {
        apply(target, self, args) {
          const query = Reflect.apply(target, self, args) as Promise<unknown[]>;
          return query.then((result) => {
            seen.push([...result]);
            return result;
          });
        },
      });
      return enqueueSyncBatch(recording, jobs, envelope(b, queued));
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect(seen).toEqual([[{ id: null, state: null, same: false }]]);
    expect(JSON.stringify(seen)).not.toContain(first);
  });

  it("a DIFFERENT batch under the same batchId is refused: no job carries its messages", async () => {
    const queued = await fresh();
    await send(a, queued);
    const changed = { ...queued.batch, tillEvents: [{ ref: "extra" }] };
    const error = await send(a, { terminalId: queued.terminalId, batch: changed }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe("ERR_VALIDATION_FAILED");
    expect(await rows(queued.batch.batchId)).toHaveLength(1);
  });

  it("re-throws a JobNotInsertedError no job explains, and every other error, unchanged", async () => {
    const queued = await fresh();
    const unexplained = new JobNotInsertedError(NAME, queued.batch.batchId);
    await expect(
      send(a, queued, {
        enqueue: () => Promise.reject(unexplained),
      }),
    ).rejects.toBe(unexplained);
    const other = new Error("pool closed");
    await expect(send(a, queued, { enqueue: () => Promise.reject(other) })).rejects.toBe(other);
  });
});
