// apps/api/test/routes/sync/tickets.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// FIVE levels: apps/api/test/routes/sync/ → four would resolve to `apps/`. Same as the other two sync route tests.
import {
  buildTicket,
  enrolTerminal,
  posFixture,
  syncRequest,
  uuidv7Sync,
  type PosFixture,
} from "../../../../../tests/invariants/support/pos";
import { startApi, type StartedApi } from "../../support/app";
import type { Problem } from "@dulja/contracts";
import { createJobClient, JOB_NAMES, type JobClient } from "@dulja/db";
import { installBoss, stopBoss } from "@dulja/db/test";
import type { BatchResult } from "@dulja/sync";

const ledgerCount = async (a: StartedApi): Promise<number> =>
  (await a.db.admin<{ n: number }[]>`select count(*)::int as n from app.ledger_entry`)[0]!.n;
const documentCount = async (a: StartedApi): Promise<number> =>
  (await a.db.admin<{ n: number }[]>`select count(*)::int as n from app.document`)[0]!.n;

describe("POST /v1/sync/tickets — re-sending a batch changes nothing (the Phase 6 DoD, server half)", () => {
  let api: StartedApi;
  let f: PosFixture;
  // A REAL pg-boss, not startApi's stub (which answers every pos.sync.apply with a fresh id): the over-size
  // re-send below is decided by pg-boss's own singleton slot. It is installed on the API's database once that
  // exists, before any request, and the client handed to the API delegates to it.
  let boss: Awaited<ReturnType<typeof installBoss>> | undefined;
  let real: JobClient | undefined;
  const jobs: JobClient = {
    enqueue: (tx, name, job, options) => {
      if (!real) throw new Error("pg-boss is not installed yet");
      return real.enqueue(tx, name, job, options);
    },
  };
  beforeAll(async () => {
    api = await startApi({ jobs });
    boss = await installBoss(api.db, JOB_NAMES);
    real = createJobClient(boss);
    f = await posFixture(api, "Tickets");
  }, 240_000);
  afterAll(async () => {
    if (boss) await stopBoss(boss);
    await api.stop();
  });

  it("applies a batch and answers a BatchResult with a catalogue cursor", async () => {
    const batch = {
      terminalId: f.terminal.terminalId,
      batchId: uuidv7Sync(),
      tickets: [buildTicket(f, { sku: "SKU-A" }), buildTicket(f, { sku: "SKU-B" })],
      shifts: [],
      tillEvents: [],
    };
    const res = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: batch,
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as BatchResult;
    expect(out.results.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect(out.catalogueCursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("THE DoD: the same batch sent three times posts once — by key replay, then by client_ref dedup", async () => {
    const batch = {
      terminalId: f.terminal.terminalId,
      batchId: uuidv7Sync(),
      tickets: [buildTicket(f, { sku: "SKU-A" })],
      shifts: [],
      tillEvents: [],
    };
    const key = crypto.randomUUID();

    const first = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: batch,
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    const ledgerAfterFirst = await ledgerCount(api);
    const docsAfterFirst = await documentCount(api);

    // Layer 1 — the SAME key: the stored response is replayed and the handler never runs (§4.2.9).
    const second = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: batch,
      idempotencyKey: key,
    });
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.clone().json());

    // Layer 2 — a DIFFERENT key, which is what a reinstalled till does: client_ref dedup answers `duplicate`.
    const third = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: batch,
      idempotencyKey: crypto.randomUUID(),
    });
    const out = (await third.json()) as BatchResult;
    expect(out.results.map((r) => r.status)).toEqual(["duplicate"]);

    expect(await ledgerCount(api), "no second ledger entry").toBe(ledgerAfterFirst);
    expect(await documentCount(api), "no second document").toBe(docsAfterFirst);
  });

  it("a batch over 200 tickets is 202 with a job id and Retry-After, and no statusUrl", async () => {
    const tickets = Array.from({ length: 201 }, () =>
      buildTicket(f, { sku: "SKU-A", quantity: "0.001000" }),
    );
    const res = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: {
        terminalId: f.terminal.terminalId,
        batchId: uuidv7Sync(),
        tickets,
        shifts: [],
        tillEvents: [],
      },
    });
    expect(res.status).toBe(202);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(["batchId", "jobId", "status"]);
  });

  it("an over-size batch re-sent with a fresh key is 202 again with the SAME job while it is queued, and never a second job (PR 12 review)", async () => {
    // §4.10.4's recovery is "re-send the same batch". pos.sync.apply is a standard queue, so its keyed send
    // holds pg-boss's 24-hour slot, and the re-send's bare enqueue threw JobNotInsertedError: a 500 for the
    // rest of the UTC day, even after the queued job had finished.
    const batch = {
      terminalId: f.terminal.terminalId,
      batchId: uuidv7Sync(),
      tickets: Array.from({ length: 201 }, () =>
        buildTicket(f, { sku: "SKU-A", quantity: "0.001000" }),
      ),
      shifts: [],
      tillEvents: [],
    };
    const send = (body: typeof batch) =>
      syncRequest(api, f.terminal, {
        method: "POST",
        path: "/v1/sync/tickets",
        body,
        idempotencyKey: crypto.randomUUID(),
      });
    const queuedJobs = async (): Promise<string[]> =>
      (
        await api.db.admin<{ id: string }[]>`
          select id::text as id from pgboss.job
           where name = 'pos.sync.apply' and singleton_key = ${batch.batchId}`
      ).map((r) => r.id);

    const first = await send(batch);
    expect(first.status).toBe(202);
    const { jobId } = (await first.json()) as { jobId: string };
    expect(await queuedJobs()).toEqual([jobId]);

    const second = await send(batch);
    expect(second.status, await second.clone().text()).toBe(202);
    expect(second.headers.get("Idempotency-Replayed")).toBeNull();
    expect(second.headers.get("Retry-After")).toBe("5");
    expect(await second.json()).toEqual({ batchId: batch.batchId, jobId, status: "queued" });
    expect(await queuedJobs(), "no second job").toEqual([jobId]);

    // Once the job has run it is no longer "queued", and a 202 with Retry-After would keep the client polling
    // until the slot lapses at UTC midnight with no answer ever coming. The re-send is refused, naming the
    // job, how it ended and what gets per-ticket answers, and still queues nothing. This file's queued jobs
    // are never executed, so each one fetched is completed as it stands.
    const claimed = await boss!.fetch("pos.sync.apply", { batchSize: 100 });
    expect(claimed.map((j) => j.id)).toContain(jobId);
    await boss!.complete(
      "pos.sync.apply",
      claimed.map((j) => j.id),
    );
    const third = await send(batch);
    expect(third.status, await third.clone().text()).toBe(400);
    expect(third.headers.get("Retry-After")).toBeNull();
    const done = (await third.json()) as Problem;
    expect(done.code).toBe("ERR_VALIDATION_FAILED");
    expect(done.detail).toContain(`job ${jobId}, which has completed`);
    expect(done.detail).toContain("batches of at most 200");
    expect(await queuedJobs()).toEqual([jobId]);

    // A DIFFERENT batch under that batchId is refused, not answered with a job that does not carry it.
    const changed = {
      ...batch,
      tickets: [...batch.tickets, buildTicket(f, { sku: "SKU-A", quantity: "0.001000" })],
    };
    const refused = await send(changed);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
    expect(await queuedJobs()).toEqual([jobId]);
  });

  it('an over-size batch whose job FAILED after its retries is not answered 202 "queued" (PR 12 review)', async () => {
    // The reviewer's case: the job fails for good (a database outage across its retries), and every re-send
    // was answered 202 "queued" with Retry-After until UTC midnight while none of its tickets was applied.
    const batch = {
      terminalId: f.terminal.terminalId,
      batchId: uuidv7Sync(),
      tickets: Array.from({ length: 201 }, () =>
        buildTicket(f, { sku: "SKU-A", quantity: "0.001000" }),
      ),
      shifts: [],
      tillEvents: [],
    };
    const send = () =>
      syncRequest(api, f.terminal, {
        method: "POST",
        path: "/v1/sync/tickets",
        body: batch,
        idempotencyKey: crypto.randomUUID(),
      });
    const first = await send();
    expect(first.status).toBe(202);
    const { jobId } = (await first.json()) as { jobId: string };

    // A failure with attempts left is a retry, still queued: the re-send is 202 with the same job.
    await boss!.fail("pos.sync.apply", jobId);
    const waiting = await send();
    expect(waiting.status, await waiting.clone().text()).toBe(202);
    expect(await waiting.json()).toEqual({ batchId: batch.batchId, jobId, status: "queued" });

    // Its retries spent without waiting out the back-off: this failure is final.
    await api.db.admin`update pgboss.job set retry_limit = 0 where id = ${jobId}::uuid`;
    await boss!.fail("pos.sync.apply", jobId);
    const failed = await send();
    expect(failed.status, await failed.clone().text()).toBe(400);
    expect(failed.headers.get("Retry-After")).toBeNull();
    const problem = (await failed.json()) as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toContain(`job ${jobId}, which failed after its retries`);
    expect(problem.detail).toContain("batches of at most 200");
    const held = await api.db.admin<{ id: string; state: string }[]>`
      select id::text as id, state::text as state from pgboss.job
       where name = 'pos.sync.apply' and singleton_key = ${batch.batchId}`;
    expect(held, "no second job").toEqual([{ id: jobId, state: "failed" }]);
  });

  it("the missing Idempotency-Key is refused like every other unsafe route (§4.2.9's two layers)", async () => {
    const res = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: {
        terminalId: f.terminal.terminalId,
        batchId: uuidv7Sync(),
        tickets: [],
        shifts: [],
        tillEvents: [],
      },
      idempotencyKey: null,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("a batch whose terminalId is not the SIGNING terminal is refused (a till cannot sell as another till)", async () => {
    const other = await enrolTerminal(api, f.s, { as: f.s.human, code: "KL77" });
    const res = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: {
        terminalId: other.terminalId,
        batchId: uuidv7Sync(),
        tickets: [buildTicket(f, { sku: "SKU-A" })],
        shifts: [],
        tillEvents: [],
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });
});
