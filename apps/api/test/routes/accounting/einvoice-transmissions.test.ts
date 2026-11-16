import {
  CLAIM_WINDOW_SECONDS,
  registerTransmitter,
  createSyntheticTransmitter,
  submitTransmission,
  UNADDRESSED_ACKNOWLEDGEMENT_PREFIX,
  withTenant,
} from "@dulja/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startStubServer, type StubServer } from "@dulja/db/test/einvoice-stub";
import {
  einvoiceFixture,
  type EinvoiceFixture,
} from "../../../../../tests/invariants/support/einvoice";
import { startApi, type StartedApi } from "../../support/app";
import type { Problem } from "@dulja/contracts";

let api: StartedApi;
let s: Seed;
let f: EinvoiceFixture;
let stub: StubServer;
let transmissionId: string;
let documentId: string;

/** The worker's context — the system principal — for a service call made the way a job makes it. */
const systemCtx = async () => ({
  tenantId: s.tenant,
  actorId: s.system,
  requestId: await uuidv7(api.db.admin),
});

/** Stamps `claimed_at` `secondsAgo` seconds in the past, through the audited path a claim writes by. */
const setClaimedAt = async (id: string, secondsAgo: number): Promise<void> => {
  await withTenant(api.db.rw, await systemCtx(), async (tx) => {
    await tx`update app.einvoice_transmission
                set claimed_at = now() - make_interval(secs => ${secondsAgo})
              where id = ${id}`;
  });
};

/** Rejects when `work` has not settled within `ms`, so a request that hangs fails the test instead. */
async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  api = await startApi();
  // The synthetic transmitter's profile points at loopback. The stub's vocabulary is the synthetic
  // profile's own statusMap (`queued` -> submitted, `cleared` -> accepted, `withdrawn` -> cancelled),
  // NOT the six local labels: `StubReply.status` is an HTTP status code. Submit answers `queued` and
  // poll answers `cleared`, which is what `driveToAccepted` (submit then poll) needs, and it leaves
  // the cancel cases an `accepted` row to withdraw.
  stub = await startStubServer({
    submit: { state: "queued", receiptId: "STUB-1" },
    poll: { state: "cleared" },
    cancel: { state: "withdrawn" },
  });
  registerTransmitter(
    "synthetic",
    createSyntheticTransmitter({
      profile: stub.profile,
      env: { EINVOICE_CLIENT_SECRET: "test-secret" },
    }),
  );
  f = await einvoiceFixture(api.db, (s = await seedTenantV2(api.db, "einvoice-api")));
  // §4.17 freezes `seedTenantV2(db, name)` — the name is REQUIRED — and
  // `grantCodes(db, s, opts?: { codes?; principalId?; roleCode?; branchIds? })` — an OPTIONS OBJECT,
  // never a bare array. Task 6 of this plan uses both correct forms.
  await grantCodes(api.db, s, {
    codes: ["accounting.tax.file", "admin.company.manage", "accounting.tax.manage"],
  });
  await api.loadPrincipals();
  ({ documentId, transmissionId } = await f.postOptedInDocument());
}, 240_000);

afterAll(async () => {
  await stub.stop();
  await api.stop();
});

describe("GET /v1/companies/{companyId}/einvoice-transmissions (5B T8)", () => {
  it("lists the company's transmissions newest first, in the ListEnvelope shape", async () => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/einvoice-transmissions`,
      as: s.human,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; documentId: string; status: string }[];
      next_cursor: string | null;
    };
    expect(body.items.map((i) => i.id)).toContain(transmissionId);
    expect(body.items[0]).toMatchObject({
      documentId,
      status: "pending",
      transmitter: "synthetic",
    });
    expect(body.next_cursor).toBeNull();
  });

  it("filters by status with the literal filter key, and pages by cursor", async () => {
    const one = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/einvoice-transmissions?filter[status][eq]=pending&limit=1`,
      as: s.human,
    });
    expect(one.status).toBe(200);
    const page = (await one.json()) as { items: unknown[]; next_cursor: string | null };
    expect(page.items).toHaveLength(1);
    // A second page is requested with the cursor the first returned; whether it is empty or not,
    // the round trip must not 400 — that is the whole of the codec assertion.
    if (page.next_cursor !== null) {
      const two = await api.request({
        method: "GET",
        path: `/v1/companies/${s.company}/einvoice-transmissions?limit=1&cursor=${page.next_cursor}`,
        as: s.human,
      });
      expect(two.status).toBe(200);
    }
  });

  it("refuses an undeclared query parameter with ERR_VALIDATION_FAILED (the .strict() case)", async () => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/einvoice-transmissions?transmitter=synthetic`,
      as: s.human,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("refuses a caller without accounting.tax.file with 403 ERR_RBAC_FORBIDDEN", async () => {
    const stranger = await seedTenantV2(api.db, "einvoice-stranger"); // same container, its own tenant, no grants
    await api.loadPrincipals();
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${stranger.company}/einvoice-transmissions`,
      as: stranger.human,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("puts claimedAt on the wire: null with no call in flight, the claim's instant while one is", async () => {
    // An operator cannot otherwise see that a call to the authority is in flight: the status of a
    // first submission still reads `pending` throughout (PR 11 review).
    const { transmissionId: id } = await f.postOptedInDocument();
    const read = async () =>
      (await (
        await api.request({
          method: "GET",
          path: `/v1/companies/${s.company}/einvoice-transmissions/${id}`,
          as: s.human,
        })
      ).json()) as { status: string; claimedAt: string | null };
    expect(await read()).toMatchObject({ status: "pending", claimedAt: null });
    await setClaimedAt(id, 0); // what a claim leaves while its call is in flight
    const claimed = await read();
    expect(claimed.status).toBe("pending");
    expect(claimed.claimedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("answers 404 for another tenant's transmission id rather than 403 (existence is not leaked)", async () => {
    const other = await seedTenantV2(api.db, "einvoice-other");
    const otherF = await einvoiceFixture(api.db, other);
    const { transmissionId: theirs } = await otherF.postOptedInDocument();
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${theirs}`,
      as: s.human,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Problem).code).toBe("ERR_NOT_FOUND");
  });
});

describe("POST …/einvoice-transmissions/{id}/submit (5B T8)", () => {
  it("answers 202 with the row and a job id, and enqueues exactly one accounting.tax.submit", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${transmissionId}/submit`,
      as: s.human,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      transmission: { id: string; status: string };
      jobId: string;
    };
    expect(body.transmission.id).toBe(transmissionId);
    expect(body.transmission.status).toBe("pending"); // the JOB moves it; the route does not
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a submit from a settled status with 409 ERR_EINVOICE_STATUS_ILLEGAL", async () => {
    // Drive the row to `accepted` through the service, exactly as the job would.
    const { transmissionId: second } = await f.postOptedInDocument();
    await f.driveToAccepted(second);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${second}/submit`,
      as: s.human,
    });
    expect(res.status).toBe(409);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_EINVOICE_STATUS_ILLEGAL");
    expect(problem.detail).toContain("accepted");
    expect(problem.detail).toContain("pending, error, rejected");
  });

  it("requires an Idempotency-Key", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${transmissionId}/submit`,
      as: s.human,
      idempotencyKey: null,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("refuses with 409 while a call to the authority is in flight — claimed_at younger than CLAIM_WINDOW_SECONDS, as the claim does", async () => {
    // While the posting job's submit is in flight the row still reads `pending`. A Submit pressed then
    // queued a second job behind the first, which ran on whatever the first recorded — including the
    // warning `error` it must never resend (PR 11 review).
    const { transmissionId: id } = await f.postOptedInDocument();
    const path = `/v1/companies/${s.company}/einvoice-transmissions/${id}/submit`;
    await setClaimedAt(id, 0);
    const refused = await api.request({ method: "POST", path, as: s.human });
    expect(refused.status).toBe(409);
    const problem = (await refused.json()) as Problem;
    expect(problem.code).toBe("ERR_EINVOICE_STATUS_ILLEGAL");
    expect(problem.detail).toBe(
      `transmission ${id} has a call in flight (claimed within ${CLAIM_WINDOW_SECONDS}s)`,
    );
    // A claim older than the window is a dead one, which the claim itself would take over.
    await setClaimedAt(id, CLAIM_WINDOW_SECONDS + 1);
    const admitted = await api.request({ method: "POST", path, as: s.human });
    expect(admitted.status).toBe(202);
  });

  it("an operator's submit of a warned `error` row records the request in the enqueueing transaction, audited under the operator", async () => {
    // ADR 0053's amendment: a 2xx submit the log records `error` is terminal for AUTOMATION — the
    // worker leaves a row led by UNADDRESSED_ACKNOWLEDGEMENT_PREFIX alone. This route is the
    // deliberate resubmission: it replaces the prefix with the operator's request, keeping the
    // diagnostic, so the job it enqueues proceeds (apps/worker's test drives that job).
    const { transmissionId: id } = await f.postOptedInDocument();
    const unaddressable = await startStubServer({ submit: { state: "queued" } }); // 2xx, no receiptId
    try {
      registerTransmitter(
        "synthetic",
        createSyntheticTransmitter({
          profile: unaddressable.profile,
          env: { EINVOICE_CLIENT_SECRET: "test-secret" },
        }),
      );
      await submitTransmission(api.db.rw, await systemCtx(), { transmissionId: id }); // the job's call
    } finally {
      registerTransmitter(
        "synthetic",
        createSyntheticTransmitter({
          profile: stub.profile,
          env: { EINVOICE_CLIENT_SECRET: "test-secret" },
        }),
      );
      await unaddressable.stop();
    }
    const [warned] = await api.db.admin<
      { status: string; last_error: string }[]
    >`select status, last_error from app.einvoice_transmission where id = ${id}`;
    expect(warned!.status).toBe("error");
    expect(warned!.last_error.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX)).toBe(true);

    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${id}/submit`,
      as: s.human,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      transmission: { status: string; lastError: string | null };
    };
    expect(body.transmission.status).toBe("error"); // the JOB moves it; the route does not
    expect(body.transmission.lastError).toBe(
      `resubmission requested by an operator; ${warned!.last_error.slice(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX.length)}`,
    );
    expect(body.transmission.lastError).toContain("returned no external id");

    const [audited] = await api.db.admin<
      { action: string; actor_id: string; last_error: string | null }[]
    >`select action, actor_id::text, after->>'last_error' as last_error
        from app.audit_log
       where table_name = 'einvoice_transmission' and row_id = ${id}
       order by seq desc
       limit 1`;
    expect(audited).toEqual({
      action: "update",
      actor_id: s.human,
      last_error: body.transmission.lastError,
    });
  });

  it("replays a repeated Idempotency-Key, returning the stored JSON response", async () => {
    // `uuidv7` is Plan 0A's helper and takes a `Sql` (§4.1: `uuidv7(sql: Sql): Promise<string>`);
    // it is never called with no argument.
    const key = await uuidv7(api.db.admin);
    const path = `/v1/companies/${s.company}/einvoice-transmissions/${transmissionId}/submit`;
    const first = await api.request({ method: "POST", path, as: s.human, idempotencyKey: key });
    const second = await api.request({ method: "POST", path, as: s.human, idempotencyKey: key });
    expect(second.status).toBe(first.status);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
  });
});

describe("POST …/einvoice-transmissions/{id}/cancel (5B T8)", () => {
  it("cancels an accepted transmission and returns the cancelled row", async () => {
    const { transmissionId: third } = await f.postOptedInDocument();
    await f.driveToAccepted(third);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${third}/cancel`,
      as: s.human,
      body: { reason: "duplicate issue — operator withdrew" },
    });
    expect(res.status).toBe(200);
    const row = (await res.json()) as { status: string; cancelledAt: string | null };
    expect(row.status).toBe("cancelled");
    expect(row.cancelledAt).not.toBeNull();
  });

  it("refuses a cancel from `pending` with 409 ERR_EINVOICE_STATUS_ILLEGAL", async () => {
    const { transmissionId: fourth } = await f.postOptedInDocument();
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${fourth}/cancel`,
      as: s.human,
      body: { reason: "too early" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_EINVOICE_STATUS_ILLEGAL");
  });

  it("refuses an empty reason with ERR_VALIDATION_FAILED", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${transmissionId}/cancel`,
      as: s.human,
      body: { reason: "" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });
});

describe("POST …/einvoice-transmissions/{id}/poll (ADR 0053, 2026-10-06)", () => {
  /** A fresh row at `submitted` — the job's submit phase, called directly (the stub answers `queued`). */
  const submitted = async (): Promise<string> => {
    const { transmissionId: id } = await f.postOptedInDocument();
    await submitTransmission(api.db.rw, await systemCtx(), { transmissionId: id });
    return id;
  };
  const poll = (id: string, company = s.company, as = s.human) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${company}/einvoice-transmissions/${id}/poll`,
      as,
    });

  it("reconciles a submitted row with the authority and returns it", async () => {
    const id = await submitted();
    const res = await poll(id);
    expect(res.status).toBe(200);
    const row = (await res.json()) as { id: string; status: string; acceptedAt: string | null };
    expect(row).toMatchObject({ id, status: "accepted" });
    expect(row.acceptedAt).not.toBeNull();
  });

  it("is not bound by the worker's POLL_LIMIT: a row automatic polling gave up on is still reachable", async () => {
    const id = await submitted();
    // What apps/worker's recordPollLimit leaves behind at POLL_LIMIT (12). Written directly because
    // an application may not import another application (AGENTS.md), and the number is the worker's.
    await withTenant(api.db.rw, await systemCtx(), async (tx) => {
      await tx`update app.einvoice_transmission
                  set attempts = 12, last_error = 'poll limit reached after 12 attempts'
                where id = ${id}`;
    });
    const res = await poll(id);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string; attempts: number }).toMatchObject({
      status: "accepted",
      attempts: 13,
    });
  });

  it("refuses a row that is not submitted with 409 ERR_EINVOICE_STATUS_ILLEGAL", async () => {
    const { transmissionId: id } = await f.postOptedInDocument(); // pending
    const res = await poll(id);
    expect(res.status).toBe(409);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_EINVOICE_STATUS_ILLEGAL");
    expect(problem.detail).toContain("is pending; poll has allowed states submitted");
  });

  it("answers 404 for another tenant's transmission id (existence is not leaked)", async () => {
    const other = await seedTenantV2(api.db, "einvoice-poll-other");
    const otherF = await einvoiceFixture(api.db, other);
    const { transmissionId: theirs } = await otherF.postOptedInDocument();
    const res = await poll(theirs);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Problem).code).toBe("ERR_NOT_FOUND");
  });

  it("refuses a caller without accounting.tax.file with 403 ERR_RBAC_FORBIDDEN", async () => {
    const stranger = await seedTenantV2(api.db, "einvoice-poll-stranger");
    await api.loadPrincipals();
    const res = await poll(transmissionId, stranger.company, stranger.human);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("an authority fault (5xx) answers 500 and is recorded against the key; the row is left pollable and a FRESH key reaches the authority", async () => {
    // Documented rather than remapped: §4.2.4's registry has no 503 code and 5B's list of codes is
    // closed. The fault is on the row (claim released, `last_error` "transient …"), and the
    // idempotency middleware replays whatever the handler answered, so a retry needs a new key.
    const id = await submitted();
    const flaky = await startStubServer({ poll: { status: 503, json: { state: "queued" } } });
    const key = await uuidv7(api.db.admin);
    const path = `/v1/companies/${s.company}/einvoice-transmissions/${id}/poll`;
    try {
      registerTransmitter(
        "synthetic",
        createSyntheticTransmitter({
          profile: flaky.profile,
          env: { EINVOICE_CLIENT_SECRET: "test-secret" },
        }),
      );
      const faulted = await api.request({ method: "POST", path, as: s.human, idempotencyKey: key });
      expect(faulted.status).toBe(500);
      expect(((await faulted.json()) as Problem).code).toBe("ERR_INTERNAL");
      expect(flaky.calls).toHaveLength(1);
    } finally {
      registerTransmitter(
        "synthetic",
        createSyntheticTransmitter({
          profile: stub.profile,
          env: { EINVOICE_CLIENT_SECRET: "test-secret" },
        }),
      );
      await flaky.stop();
    }
    const [row] = await api.db.admin<
      { status: string; claimed_at: Date | null; last_error: string | null }[]
    >`select status, claimed_at, last_error from app.einvoice_transmission where id = ${id}`;
    expect(row!.status).toBe("submitted");
    expect(row!.claimed_at).toBeNull();
    expect(row!.last_error).toContain("transient");

    const replayed = await api.request({ method: "POST", path, as: s.human, idempotencyKey: key });
    expect(replayed.status).toBe(500);
    expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
    const fresh = await api.request({ method: "POST", path, as: s.human });
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { status: string }).status).toBe("accepted");
  });

  it("requires an Idempotency-Key", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${transmissionId}/poll`,
      as: s.human,
      idempotencyKey: null,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("more concurrent polls and cancels than the pool has connections all complete, and the API still answers", async () => {
    // startApi builds the app on createDb's default pool of 4, as apps/api/src/index.ts does. The
    // idempotency middleware's request-spanning transaction used to hold one pooled connection for
    // the whole request while the service's claim and record each needed ANOTHER from the same pool:
    // four concurrent calls held all four connections and waited for a fifth for ever, and every
    // other request queued behind them. Four polls alone fill the pool; the cancels share the path.
    // `deadline` turns that hang into a failure.
    // The ENCODED spellings reach the same handlers, because Hono routes on the percent-decoded path,
    // and must be SELF_TRANSACTED too (PR 11 review): the list matched the URL's own spelling, so each
    // of these ran inside the request-spanning transaction, and four of them — the pool's size — wedge
    // it exactly as four plain polls did. One would not: three free connections serve everything else.
    const polled: string[] = [];
    const cancelled: string[] = [];
    for (let i = 0; i < 4; i += 1) polled.push(await submitted());
    for (let i = 0; i < 3; i += 1) {
      const { transmissionId: id } = await f.postOptedInDocument();
      await f.driveToAccepted(id);
      cancelled.push(id);
    }
    const encodedPolls = [
      (id: string) => `/v1/companies/${s.company}/einvoice-transmissions/${id}/%70oll`,
      (id: string) => `/v1/companies/${s.company}/einvoice-transmissions/${id}/po%6Cl`,
      (id: string) => `/v1/companies/${s.company}/einvoice%2Dtransmissions/${id}/poll`,
    ];
    const encodedPolled: string[] = [];
    for (let i = 0; i < encodedPolls.length; i += 1) encodedPolled.push(await submitted());
    const { transmissionId: encodedCancelled } = await f.postOptedInDocument();
    await f.driveToAccepted(encodedCancelled);
    const answers = await deadline(
      Promise.all([
        ...polled.map((id) => poll(id)),
        ...cancelled.map((id) =>
          api.request({
            method: "POST",
            path: `/v1/companies/${s.company}/einvoice-transmissions/${id}/cancel`,
            as: s.human,
            body: { reason: "concurrent withdrawal" },
          }),
        ),
        ...encodedPolled.map((id, i) =>
          api.request({ method: "POST", path: encodedPolls[i]!(id), as: s.human }),
        ),
        api.request({
          method: "POST",
          path: `/v1/companies/${s.company}/einvoice-transmissions/${encodedCancelled}/cance%6C`,
          as: s.human,
          body: { reason: "concurrent withdrawal, encoded" },
        }),
      ]),
      20_000,
    );
    expect(answers.map((r) => r.status)).toEqual(Array.from({ length: 11 }, () => 200));
    const encodedRows = (await Promise.all(answers.slice(7).map((r) => r.json()))) as {
      id: string;
      status: string;
    }[];
    expect(encodedRows).toEqual([
      ...encodedPolled.map((id) => expect.objectContaining({ id, status: "accepted" })),
      expect.objectContaining({ id: encodedCancelled, status: "cancelled" }),
    ]);
    const after = await deadline(
      api.request({
        method: "GET",
        path: `/v1/companies/${s.company}/einvoice-transmissions?limit=1`,
        as: s.human,
      }),
      5_000,
    );
    expect(after.status).toBe(200);
  }, 60_000);

  it("replays a repeated Idempotency-Key with the stored answer, not a second call to the authority", async () => {
    // The poll runs outside the request-spanning transaction now, and its response is recorded after
    // it; a replay must still return that stored answer rather than poll again.
    const id = await submitted();
    const key = await uuidv7(api.db.admin);
    const path = `/v1/companies/${s.company}/einvoice-transmissions/${id}/poll`;
    const before = stub.calls.length;
    const first = await api.request({ method: "POST", path, as: s.human, idempotencyKey: key });
    const second = await api.request({ method: "POST", path, as: s.human, idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    expect(stub.calls.length - before).toBe(1);
  });

  it("fingerprints the routed path: `poll` and `%70oll` under one key are one request, replayed rather than refused as reuse", async () => {
    // Both spellings reach the same handler with the same parameters, so they are the same request.
    // A fingerprint of the URL's own spelling refused an honest retry whose client or proxy
    // re-encoded a segment with ERR_IDEMPOTENCY_KEY_REUSED (PR 11 review).
    const id = await submitted();
    const key = await uuidv7(api.db.admin);
    const before = stub.calls.length;
    const first = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${id}/poll`,
      as: s.human,
      idempotencyKey: key,
    });
    const encoded = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${id}/%70oll`,
      as: s.human,
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    expect(encoded.status).toBe(200);
    expect(encoded.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await encoded.json()).toEqual(await first.json());
    expect(stub.calls.length - before).toBe(1);
  });
});

describe("the company e-invoice settings and the filed transition (5B T8)", () => {
  it("reads and writes the three settings columns, and the secret VALUE never appears", async () => {
    const put = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/einvoice-settings`,
      as: s.human,
      body: {
        transmitter: "synthetic",
        clientId: "stub-client",
        credentialRef: "EINVOICE_CLIENT_SECRET",
      },
    });
    expect(put.status).toBe(200);
    const get = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/einvoice-settings`,
      as: s.human,
    });
    expect(await get.json()).toEqual({
      transmitter: "synthetic",
      clientId: "stub-client",
      credentialRef: "EINVOICE_CLIENT_SECRET",
    });
    // The column holds the NAME of the secret. No route in this slice returns a value, and this is
    // the assertion that says so: the response body has exactly three keys.
    expect(
      Object.keys(
        (await (
          await api.request({
            method: "GET",
            path: `/v1/companies/${s.company}/einvoice-settings`,
            as: s.human,
          })
        ).json()) as object,
      ).toSorted(),
    ).toEqual(["clientId", "credentialRef", "transmitter"]);
  });

  it("refuses a credentialRef that is not a declared secret name", async () => {
    const res = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/einvoice-settings`,
      as: s.human,
      body: { transmitter: "synthetic", clientId: "c", credentialRef: "DATABASE_URL" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("refuses a partial settings write (two of three) — the CHECK made explicit at the edge", async () => {
    const res = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/einvoice-settings`,
      as: s.human,
      body: { transmitter: "myinvois", clientId: "c", credentialRef: null },
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.some((e) => e.message.includes("all three or none"))).toBe(true);
  });

  it("accepts `myinvois` before Task 9 has run — the refusal is at submit, not at configuration", async () => {
    const other = await seedTenantV2(api.db, "einvoice-myinvois");
    await grantCodes(api.db, other, { codes: ["admin.company.manage"] });
    await api.loadPrincipals();
    const res = await api.request({
      method: "PUT",
      path: `/v1/companies/${other.company}/einvoice-settings`,
      as: other.human,
      body: { transmitter: "myinvois", clientId: "c", credentialRef: "EINVOICE_CLIENT_SECRET" },
    });
    expect(res.status).toBe(200);
  });

  it("files a generated tax return under accounting.tax.file, and refuses a draft", async () => {
    const { taxReturnId, draftReturnId } = await f.twoTaxReturns();
    const ok = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/tax-returns/${taxReturnId}/file`,
      as: s.human,
      body: {},
    });
    expect(ok.status).toBe(200);
    // The response is 5A's `TaxReturnDetail`, whose entity key is `taxReturn` — NOT `row` — and
    // which also carries `boxes`, `payload`, `tieOut` and `currency` (5a's contracts file). A handler
    // that answered `{ row, … }` would fail 5A's own schema at the OpenAPI boundary.
    const filed = (await ok.json()) as {
      taxReturn: { status: string; filedAt: string | null };
      boxes: unknown[];
      payload: string | null;
      tieOut: unknown[];
      currency: string;
    };
    expect(filed.taxReturn.status).toBe("filed");
    expect(filed.taxReturn.filedAt).not.toBeNull();
    expect(Object.keys(filed).toSorted()).toEqual([
      "boxes",
      "currency",
      "payload",
      "taxReturn",
      "tieOut",
    ]);

    const bad = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/tax-returns/${draftReturnId}/file`,
      as: s.human,
      body: {},
    });
    expect(bad.status).toBe(409);
    const problem = (await bad.json()) as Problem;
    expect(problem.code).toBe("ERR_DOC_STATUS_ILLEGAL");
    expect(problem.detail).toContain("draft");
  });
});
