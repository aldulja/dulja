import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@dulja/contracts";
import {
  admitOperatorSubmit,
  getTransmission,
  recordPending,
  registerTransmitter,
  resetTransmitters,
  createSyntheticTransmitter,
  submitTransmission,
  UNADDRESSED_ACKNOWLEDGEMENT_PREFIX,
  withTenant as prodWithTenant,
} from "@dulja/db";
import { seedTenant, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import {
  postedStubDocument,
  enableEinvoice,
  startStubServer,
  type StubServer,
} from "@dulja/db/test/einvoice-stub";
import {
  accountingTaxSubmit,
  POLL_LIMIT,
  pollDelaySeconds,
} from "../../src/handlers/accounting-tax-submit";
import { setJobs } from "../../src/jobs";
import { log, setLogger } from "../../src/log";

const ENV = { EINVOICE_CLIENT_SECRET: "s3cr3t" };

interface Recorded {
  name: string;
  payload: unknown;
  opts: unknown;
}

function recordingJobs(): { client: Parameters<typeof setJobs>[0]; enqueued: Recorded[] } {
  const enqueued: Recorded[] = [];
  const client = {
    async enqueue(_tx: unknown, name: string, job: { payload: unknown }, opts: unknown) {
      enqueued.push({ name, payload: job.payload, opts });
      return `job-${enqueued.length}`;
    },
  } as unknown as Parameters<typeof setJobs>[0];
  return { client, enqueued };
}

describe("accounting.tax.submit — the handler (contracts amendment 2)", () => {
  let db: Db;
  let s: Seed;
  let server: StubServer | null = null;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenant(db, "einvoice-job");
    await enableEinvoice(db, s);
  }, 180_000);

  afterEach(async () => {
    await server?.stop();
    server = null;
    resetTransmitters();
  });
  afterAll(async () => {
    await db.stop();
  });

  const arm = async (script: Parameters<typeof startStubServer>[0]) => {
    server = await startStubServer(script);
    registerTransmitter(
      "synthetic",
      createSyntheticTransmitter({
        profile: server.profile,
        env: ENV,
      }),
    );
  };

  const pending = async (): Promise<string> => {
    const documentId = await postedStubDocument(db, s);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    return prodWithTenant(db.rw, ctx, (tx) =>
      recordPending(tx, { documentId, companyId: s.company, transmitter: "synthetic" }),
    );
  };

  const run = async (transmissionId: string, phase: "submit" | "poll"): Promise<void> => {
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    await accountingTaxSubmit(
      db.rw,
      { tenantId: s.tenant, requestId: ctx.requestId, payload: { transmissionId, phase } },
      ctx,
    );
  };

  it("pollDelaySeconds is exponential from 60 and capped at one hour", () => {
    expect(pollDelaySeconds(0)).toBe(60);
    expect(pollDelaySeconds(1)).toBe(120);
    expect(pollDelaySeconds(5)).toBe(1920);
    expect(pollDelaySeconds(99)).toBe(3600);
  });

  it("submit that returns `submitted` re-enqueues the POLL phase with a distinct singleton key", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-30" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();

    await run(id, "submit");

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.name).toBe("accounting.tax.submit");
    expect(enqueued[0]!.payload).toEqual({ transmissionId: id, phase: "poll" });
    // A distinct singleton key: the submit job may still be active under `id`, and pg-boss would
    // drop a second insert under the same key.
    expect(enqueued[0]!.opts).toMatchObject({ singletonKey: `${id}:poll`, startAfterSeconds: 60 });
  });

  it("submit that returns `accepted` enqueues NOTHING — the transmission is finished", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-31" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    expect(enqueued).toHaveLength(0);
  });

  it("submit that returns `rejected` enqueues nothing and does NOT throw (a refusal is an outcome)", async () => {
    await arm({
      submit: {
        status: 422,
        json: { state: "refused", receiptId: "R-32", reason: "stub refusal" },
      },
    });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await expect(run(id, "submit")).resolves.toBeUndefined();
    expect(enqueued).toHaveLength(0);
  });

  it("a 5xx THROWS so pg-boss retries, and the row keeps its status", async () => {
    await arm({ submit: { status: 503, json: { state: "queued" } } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await expect(run(id, "submit")).rejects.toThrow(/503/);
    expect(enqueued).toHaveLength(0);
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
  });

  it("the pg-boss retry after a transient fault REACHES the authority — the claim ended with the call", async () => {
    // This is the assertion that `retryLimit: 8` (§4.9.3) is alive rather than decorative.
    // `retryDelaySeconds` is 60 and `CLAIM_WINDOW_SECONDS` is 120, so the first retry always arrives
    // INSIDE the claim window. If `recordFault` left `claimed_at` stamped, `claim()` would raise
    // ERR_EINVOICE_STATUS_ILLEGAL, the handler's catch would read it as "no longer actionable",
    // pg-boss would mark the job complete and the row would be abandoned at `pending` for ever.
    // The handler is re-run directly rather than through pg-boss: the thing under test is the claim.
    await arm({
      submit: [
        { status: 503, json: { state: "queued" } },
        { state: "queued", receiptId: "R-38" },
      ],
    });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();

    await expect(run(id, "submit")).rejects.toThrow(/503/);
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const faulted = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(faulted.status).toBe("pending");
    expect(faulted.attempts).toBe(1);
    expect(faulted.lastError).toContain("transient");
    expect(faulted.claimedAt, "recordFault must end the claim (ADR 0053)").toBeNull();
    expect(
      faulted.polledAt,
      "the call completed, unsuccessfully — polled_at records that",
    ).not.toBeNull();
    expect(enqueued).toHaveLength(0);

    // The retry, immediately — no 120-second wait, which is the whole point of the two columns.
    await run(id, "submit");
    const after = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(after.status).toBe("submitted");
    expect(after.externalId).toBe("R-38");
    expect(after.attempts).toBe(2);
    expect(after.claimedAt).toBeNull();
    expect(enqueued.map((e) => (e.payload as { phase: string }).phase)).toEqual(["poll"]);
  });

  it("poll that is still open re-enqueues with a longer delay each time", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-33" }, poll: { state: "queued" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    await run(id, "poll");
    await run(id, "poll");
    const delays = enqueued
      .filter((e) => (e.payload as { phase: string }).phase === "poll")
      .map((e) => (e.opts as { startAfterSeconds: number }).startAfterSeconds);
    expect(delays).toHaveLength(3);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
    expect(delays[2]!).toBeGreaterThan(delays[1]!);
  });

  it("poll STOPS re-enqueueing after POLL_LIMIT and records why, without throwing", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-34" }, poll: { state: "queued" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    // Extra deliveries beyond the budget must neither call the remote nor increment attempts.
    for (let i = 0; i < POLL_LIMIT + 1; i += 1) await run(id, "poll");
    const polls = enqueued.filter((e) => (e.payload as { phase: string }).phase === "poll");
    expect(polls.length).toBeLessThan(POLL_LIMIT + 2);
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("submitted");
    expect(row.lastError).toContain("poll limit");
    // …and names the operator verb that is not bound by the limit (ADR 0053, 2026-10-06).
    expect(row.lastError).toContain(`/v1/companies/${s.company}/einvoice-transmissions/${id}/poll`);
    expect(row.attempts).toBe(POLL_LIMIT);
    expect(server!.calls).toHaveLength(POLL_LIMIT);
  });

  it("a poll answered with an UNMAPPED label keeps the row submitted and re-enqueues the next poll", async () => {
    // The re-enqueue reads `status === "submitted"`. Before the 2026-10-06 amendment the poll wrote
    // `error`, the chain stopped after one call, and the row became resubmittable while the
    // authority held it.
    await arm({ submit: { state: "queued", receiptId: "R-39" }, poll: { state: "in_review" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    await run(id, "poll");
    const polls = enqueued.filter((e) => (e.payload as { phase: string }).phase === "poll");
    expect(polls).toHaveLength(2);
    expect(polls[1]!.opts).toMatchObject({ singletonKey: `${id}:poll` });
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("submitted");
    expect(row.lastError).toContain("in_review");
    expect(row.acceptedAt).toBeNull();
  });

  it("a submit ACKNOWLEDGED under an unmapped label enqueues the poll phase — the row is submitted, not error", async () => {
    await arm({ submit: { state: "in_review", receiptId: "R-40" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload).toEqual({ transmissionId: id, phase: "poll" });
    expect(enqueued[0]!.opts).toMatchObject({ singletonKey: `${id}:poll` });
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("submitted");
    expect(row.externalId).toBe("R-40");
    expect(row.lastError).toContain("in_review");
  });

  it("a 2xx submit whose acknowledgement cannot be read COMPLETES the job — pg-boss must not POST it again", async () => {
    // Throwing would hand the job to pg-boss's retryLimit 8, and every retry re-sends the document.
    await arm({ submit: { state: "queued" } }); // 2xx, no receiptId: no addressable external id
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await expect(run(id, "submit")).resolves.toBeUndefined();
    expect(enqueued).toHaveLength(0);
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("error");
    expect(row.lastError).toContain("returned no external id");
    expect(server!.calls).toHaveLength(1);
  });

  it("that warning `error` is terminal for automation: a later submit job sends nothing until an operator's submit records the request", async () => {
    // The posting job J1 is in flight while the row still reads `pending`, so the operator route
    // enqueued J2 under the same singletonKey (stately admits one queued behind one active). J1
    // records the warning and completes; J2 then claimed the `error` row — SUBMITTABLE_FROM — and
    // RESENT the document the authority may already hold (PR 11 review).
    await arm({
      submit: [{ state: "queued" }, { state: "queued", receiptId: "R-after-operator" }],
    });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit"); // J1: 2xx, no external id — the warning
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const warned = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(warned.status).toBe("error");
    expect(warned.lastError!.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX)).toBe(true);

    await expect(run(id, "submit")).resolves.toBeUndefined(); // J2: a no-op, like a settled row
    expect(server!.calls).toHaveLength(1);
    const untouched = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(untouched).toEqual(warned); // not claimed, not counted, not rewritten
    expect(enqueued).toHaveLength(0);

    // The operator's submit route, in the transaction that enqueues J3: the deliberate resubmission.
    const operator = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    await prodWithTenant(db.rw, operator, (tx) => admitOperatorSubmit(tx, id));
    await run(id, "submit"); // J3 proceeds
    expect(server!.calls).toHaveLength(2);
    const resubmitted = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(resubmitted.status).toBe("submitted");
    expect(resubmitted.externalId).toBe("R-after-operator");
    expect(resubmitted.attempts).toBe(2);
    expect(enqueued.map((e) => (e.payload as { phase: string }).phase)).toEqual(["poll"]);
  });

  it("a warning that lands between this job's pre-read and its claim still stops it — the claim refuses, and nothing is resent", async () => {
    // The pre-read guard above reads the row in one transaction and submitTransmission claims it in
    // another. Another submit's call recording the warning in between — two submit calls at once,
    // which the stately queue's one active job per key rules out today short of a pg-boss expiry —
    // found the claim admitting `error` (SUBMITTABLE_FROM) and the document was sent again (PR 11
    // review, second pass). The handler's FIRST transaction is the pre-read and its SECOND the claim,
    // so the other call runs between them.
    await arm({
      submit: [{ state: "queued" }, { state: "queued", receiptId: "R-raced" }],
    });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    let transactions = 0;
    const interleaved = new Proxy(db.rw, {
      get(target, prop, receiver) {
        if (prop !== "begin") return Reflect.get(target, prop, receiver) as unknown;
        return async (...args: unknown[]) => {
          transactions += 1;
          // The other submit, on the real pool: 2xx, no external id — it records the warning.
          if (transactions === 2) await submitTransmission(db.rw, ctx, { transmissionId: id });
          return (target.begin as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });

    await expect(
      accountingTaxSubmit(
        interleaved,
        {
          tenantId: s.tenant,
          requestId: ctx.requestId,
          payload: { transmissionId: id, phase: "submit" },
        },
        ctx,
      ),
    ).resolves.toBeUndefined(); // ERR_EINVOICE_STATUS_ILLEGAL on the submit phase: a no-op
    expect(transactions).toBeGreaterThanOrEqual(2); // the other call did run between the two
    expect(server!.calls).toHaveLength(1); // the other call's; this job sent nothing
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("error");
    expect(row.attempts).toBe(1);
    expect(row.claimedAt).toBeNull();
    expect(row.lastError!.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX)).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it("a poll job refused because an operator's poll is IN FLIGHT schedules its successor — the chain does not stall", async () => {
    // The operator route claims the same `submitted` row. Treating that refusal as "settled" would
    // end automatic polling with no successor and no poll-limit message.
    await arm({ submit: { state: "queued", receiptId: "R-41" }, poll: { state: "cleared" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    // What the operator route's claim leaves while its call to the authority is in flight.
    await prodWithTenant(db.rw, ctx, async (tx) => {
      await tx`update app.einvoice_transmission set claimed_at = now() where id = ${id}`;
    });
    await expect(run(id, "poll")).resolves.toBeUndefined();
    expect(server!.calls).toHaveLength(1); // the refused job reached nothing remote
    const polls = enqueued.filter((e) => (e.payload as { phase: string }).phase === "poll");
    expect(polls).toHaveLength(2); // the submit's, and the refused poll's successor
    expect(polls[1]!.opts).toMatchObject({ singletonKey: `${id}:poll` });
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("submitted");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBeNull(); // no poll-limit marker written under someone else's claim
  });

  it("a submit REDELIVERED after its poll enqueue failed schedules that poll — the submitted row is not stranded", async () => {
    // submitTransmission commits `submitted` in its own transaction and the poll is enqueued in
    // another. If that enqueue fails (a dropped connection, a worker killed between the two), pg-boss
    // redelivers the SUBMIT job, whose claim `submitted` refuses. Read as "nothing to do", that left
    // a submitted row with no poll job and no poll-limit marker: automatic reconciliation never began.
    await arm({ submit: { state: "queued", receiptId: "R-43" }, poll: { state: "cleared" } });
    const { client, enqueued } = recordingJobs();
    const recordingEnqueue = client.enqueue.bind(client) as (...args: unknown[]) => Promise<string>;
    let failNext = true;
    setJobs({
      async enqueue(...args: unknown[]) {
        if (failNext) {
          failNext = false;
          throw new Error("connection terminated unexpectedly");
        }
        return recordingEnqueue(...args);
      },
    } as unknown as Parameters<typeof setJobs>[0]);
    const id = await pending();

    await expect(run(id, "submit")).rejects.toThrow("connection terminated unexpectedly");
    await expect(run(id, "submit")).resolves.toBeUndefined(); // pg-boss's redelivery

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload).toEqual({ transmissionId: id, phase: "poll" });
    expect(enqueued[0]!.opts).toMatchObject({ singletonKey: `${id}:poll`, startAfterSeconds: 60 });
    expect(server!.calls).toHaveLength(1); // the redelivery sent nothing to the authority
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("submitted");
    expect(row.attempts).toBe(1);
    expect(row.claimedAt).toBeNull();
  });

  it("a POLL job that finds e-invoicing turned off leaves a recoverable marker naming the operator poll route, and says so", async () => {
    // It used to log "leaving the row pending" for a row that is `submitted`, schedule no successor
    // and write nothing, so re-enabling e-invoicing resumed nothing and the row named no way forward
    // (PR 11 review). Polling stops — retrying would change nothing — but the row now says how to
    // reconcile it, as the poll-limit marker does, and the log says what happened to it.
    await arm({ submit: { state: "queued", receiptId: "R-off" }, poll: { state: "cleared" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    const lines: string[] = [];
    const previous = log();
    setLogger(createLogger({ sink: (line) => lines.push(line) }));
    try {
      // An admin turns e-invoicing off between the submit and its poll.
      await prodWithTenant(
        db.rw,
        { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
        async (tx) => {
          await tx`update app.company
                      set einvoice_transmitter = null, einvoice_client_id = null, einvoice_credential_ref = null
                    where id = ${s.company}`;
        },
      );
      await expect(run(id, "poll")).resolves.toBeUndefined();
      await expect(run(id, "poll")).resolves.toBeUndefined(); // a redelivery
    } finally {
      setLogger(previous);
      await enableEinvoice(db, s);
    }
    expect(server!.calls).toHaveLength(1); // the submit; neither poll reached the authority
    const polls = enqueued.filter((e) => (e.payload as { phase: string }).phase === "poll");
    expect(polls).toHaveLength(1); // the submit's own: nothing re-enqueued while e-invoicing is off
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("submitted");
    expect(row.claimedAt).toBeNull();
    expect(row.lastError).toMatch(/^automatic polling stopped: /);
    expect(row.lastError).toContain("no e-invoice transmitter configured");
    expect(row.lastError).toContain(
      `POST /v1/companies/${s.company}/einvoice-transmissions/${id}/poll`,
    );
    expect(row.lastError!.match(/automatic polling stopped/g)).toHaveLength(1); // never nested
    const said = lines.map((line) => JSON.parse(line) as { msg: string; phase?: string });
    const notEnabled = said.filter((l) => l.msg.startsWith("e-invoicing is no longer enabled"));
    expect(notEnabled).toHaveLength(2);
    for (const l of notEnabled) {
      expect(l.phase).toBe("poll");
      expect(l.msg).not.toContain("pending");
      expect(l.msg).toContain("poll route");
    }
  });

  it("the poll-limit marker keeps the authority's last answer, and a repeated delivery does not nest it", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-42" }, poll: { state: "in_review" } });
    const { client } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    for (let i = 0; i < POLL_LIMIT + 1; i += 1) await run(id, "poll");
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("submitted");
    expect(row.attempts).toBe(POLL_LIMIT);
    expect(row.lastError).toMatch(/^poll limit reached/);
    expect(row.lastError).toContain("in_review"); // why the authority never resolved it
    expect(row.lastError!.match(/poll limit reached/g)).toHaveLength(1);
    expect(row.lastError!.match(/last answer/g)).toHaveLength(1);
  });

  it("transient poll retries stop before exceeding the durable call budget", async () => {
    await arm({
      submit: { state: "queued", receiptId: "R-budget" },
      poll: { status: 503, json: { state: "queued" } },
    });
    const { client } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    for (let attempt = 1; attempt < POLL_LIMIT; attempt += 1) {
      await expect(run(id, "poll")).rejects.toThrow(/503/);
    }
    await expect(run(id, "poll")).resolves.toBeUndefined();
    expect(server!.calls).toHaveLength(POLL_LIMIT);
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.attempts).toBe(POLL_LIMIT);
    expect(row.lastError).toContain("poll limit");
    expect(row.claimedAt).toBeNull();
  });

  it("poll that accepts enqueues nothing further", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-35" }, poll: { state: "cleared" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    const before = enqueued.length;
    await run(id, "poll");
    expect(enqueued).toHaveLength(before);
  });

  it("a transmission that is no longer in a legal state for its phase is a no-op, not a failure", async () => {
    // pg-boss delivers at least once, so the same poll job can arrive twice after the transmission
    // has already been accepted. Throwing would burn the retry budget on a settled row.
    await arm({ submit: { state: "cleared", receiptId: "R-36" }, poll: { state: "cleared" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    await expect(run(id, "poll")).resolves.toBeUndefined();
    expect(enqueued).toHaveLength(0);
  });

  it("a transmission id from another tenant touches nothing (test 12's job half)", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-37" } });
    const { client } = recordingJobs();
    setJobs(client);
    const id = await pending();
    const other = await seedTenant(db, "einvoice-job-victim");
    const ctx = {
      tenantId: other.tenant,
      actorId: other.system,
      requestId: await uuidv7(db.admin),
    };
    await expect(
      accountingTaxSubmit(
        db.rw,
        {
          tenantId: other.tenant,
          requestId: ctx.requestId,
          payload: { transmissionId: id, phase: "submit" },
        },
        ctx,
      ),
    ).resolves.toBeUndefined();
    const mine = await prodWithTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      (tx) => getTransmission(tx, id),
    );
    expect(mine.status).toBe("pending");
    expect(mine.attempts).toBe(0);
  });
});
