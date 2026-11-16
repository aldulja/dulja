import { grantCodes } from "../fixtures";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import {
  admitOperatorSubmit,
  cancelTransmission,
  CLAIM_WINDOW_SECONDS,
  type EinvoiceTransmissionRow,
  getTransmission,
  listTransmissions,
  pollTransmission,
  recordPending,
  submitTransmission,
  UNADDRESSED_ACKNOWLEDGEMENT_PREFIX,
} from "../../src/einvoice/transmission";
import { EInvoiceError, TransientTransmissionError } from "../../src/einvoice/errors";
import {
  registerDefaultTransmitters,
  registerTransmitter,
  resetTransmitters,
} from "../../src/einvoice/registry";
import { createSyntheticTransmitter } from "../../src/einvoice/synthetic";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { draftDocument, seedTenant, type Seed } from "../fixtures";
import {
  postedStubDocument,
  enableEinvoice,
  startStubServer,
  type StubServer,
} from "../support/einvoice-stub";

const ENV = { EINVOICE_CLIENT_SECRET: "s3cr3t" };

/** Every call of the transmitter it wraps waits here until the test releases it, in arrival order. */
function callGate() {
  const releases: (() => void)[] = [];
  let wake: (() => void) | null = null;
  return {
    async pass(): Promise<void> {
      await new Promise<void>((release) => {
        releases.push(release);
        wake?.();
      });
    },
    async arrived(count: number): Promise<void> {
      while (releases.length < count) await new Promise<void>((resolve) => (wake = resolve));
    },
    release(index: number): void {
      releases[index]!();
    },
  };
}

/** The error line the service writes for a superseded call — the only trace of its outcome. */
function stderrLines() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

/**
 * `pool`, with the claim's UPDATE (the `attempts + 1` statement) of the first claim made through it
 * held until `release()` — after that claim's read, in its open transaction. The same seam as
 * replay-concurrency.test.ts's `instrumented`: every transaction `pool.begin` opens shows each
 * statement's text to the hook before it runs.
 */
function pausedAtClaimUpdate(pool: Sql) {
  let reached!: () => void;
  let release!: () => void;
  const atUpdate = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  const wrapTx = (tx: Sql): Sql =>
    new Proxy(tx, {
      apply(target, thisArg, args: unknown[]) {
        const [strings] = args;
        if (
          !paused &&
          Array.isArray(strings) &&
          "raw" in strings &&
          (strings as readonly string[]).join("?").includes("attempts + 1")
        ) {
          paused = true;
          reached();
          return released.then(() => Reflect.apply(target, thisArg, args) as unknown);
        }
        return Reflect.apply(target, thisArg, args) as unknown;
      },
    });
  const sql = new Proxy(pool, {
    get(target, prop) {
      if (prop === "begin") {
        return (...args: unknown[]) => {
          const callback = args.at(-1) as (tx: Sql) => Promise<unknown>;
          return (target.begin as (...a: unknown[]) => Promise<unknown>)(
            ...args.slice(0, -1),
            (tx: Sql) => callback(wrapTx(tx)),
          );
        };
      }
      return Reflect.get(target, prop, target) as unknown;
    },
  });
  return { sql, atUpdate, release };
}

describe("the transmission log's state machine (ADR 0053)", () => {
  let db: Db;
  let s: Seed;
  let ctx: { tenantId: string; actorId: string; requestId: string };
  let server: StubServer | null = null;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenant(db, "einvoice-log");
    await grantCodes(db, s); // 6C: explicit company-wide branch visibility; no permission codes.
    ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
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
    return server;
  };

  it("passes the accepted call's redacted receipt to QR creation and persists its result", async () => {
    server = await startStubServer({
      submit: { state: "queued", receiptId: "receipt-qr" },
      poll: { json: { state: "cleared", longId: "persisted-long-id" } },
    });
    const base = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    registerTransmitter("synthetic", {
      ...base,
      qrPayload(_doc, receipt) {
        const body = (receipt.raw as { body: { longId: string } }).body;
        return `validation:${receipt.externalId}:${body.longId}`;
      },
    });
    const documentId = await postedStubDocument(db, s);
    const created = await prodWithTenant(db.rw, ctx, (tx) =>
      recordPending(tx, { documentId, companyId: s.company, transmitter: "synthetic" }),
    );
    await submitTransmission(db.rw, ctx, { transmissionId: created });
    const result = await pollTransmission(db.rw, ctx, { transmissionId: created });
    expect(result.qrPayload).toBe("validation:receipt-qr:persisted-long-id");
    expect((await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, created))).qrPayload).toBe(
      result.qrPayload,
    );
  });

  const pending = async (): Promise<string> => {
    const documentId = await postedStubDocument(db, s);
    return prodWithTenant(db.rw, ctx, (tx) =>
      recordPending(tx, { documentId, companyId: s.company, transmitter: "synthetic" }),
    );
  };

  it("recordPending writes a row at pending with attempts 0 and no external id", async () => {
    const id = await pending();
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.externalId).toBeNull();
    expect(row.requestSha256).toBeNull();
    expect(row.profileVersion).toBeNull();
    expect(row.polledAt).toBeNull();
    expect(row.claimedAt).toBeNull(); // no call has been claimed, let alone made
  });

  it("re-recording a document preserves its original transmitter", async () => {
    const id = await pending();
    const before = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    const same = await prodWithTenant(db.rw, ctx, (tx) =>
      recordPending(tx, {
        documentId: before.documentId,
        companyId: s.company,
        transmitter: "myinvois",
      }),
    );
    expect(same).toBe(id);
    expect((await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id))).transmitter).toBe(
      "synthetic",
    );
  });

  it("refuses a changed company transmitter before any remote call", async () => {
    const stub = await arm({ submit: { state: "queued", receiptId: "R-changed" } });
    const id = await pending();
    await prodWithTenant(
      db.rw,
      ctx,
      (tx) => tx`update app.company set einvoice_transmitter = 'myinvois' where id = ${s.company}`,
    );
    try {
      await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toMatchObject({
        code: "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
      });
      expect(stub.calls).toHaveLength(0);
      const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
      expect(row.claimedAt).toBeNull();
      expect(row.transmitter).toBe("synthetic");
    } finally {
      await enableEinvoice(db, s);
    }
  });

  it("poll refuses a row whose pinned profile version is no longer registered, naming it, before contacting the remote service", async () => {
    const stub = await arm({
      submit: { state: "queued", receiptId: "R-version" },
      poll: { state: "cleared" },
    });
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });
    // Only v2 is registered now. Registering v2 BESIDE v1 is the version bump the registry serves
    // (the temp-directory cases below); this is the deployment that dropped the row's version.
    resetTransmitters();
    registerTransmitter(
      "synthetic",
      createSyntheticTransmitter({ profile: { ...stub.profile, version: 2 }, env: ENV }),
    );
    await expect(pollTransmission(db.rw, ctx, { transmissionId: id })).rejects.toMatchObject({
      code: "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
      detail: expect.stringContaining("synthetic profile version 1 is not registered"),
    });
    expect(stub.calls).toHaveLength(1);
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.profileVersion).toBe(1);
    expect(row.claimedAt).toBeNull();
  });

  // ADR 0053, "Also open": the registry built one transmitter per code from the highest profile
  // file, so once `synthetic.v2.json` shipped every submitted or accepted row of v1 could be neither
  // polled nor cancelled. Each case boots the registry the way an entrypoint does — from a profile
  // directory — with v1 and v2 pointed at two different stub servers, so the call each row makes
  // shows which version served it.
  describe("a profile version bump (registerDefaultTransmitters over a temp directory)", () => {
    const servers: StubServer[] = [];
    const dirs: string[] = [];
    afterEach(async () => {
      for (const stub of servers.splice(0)) await stub.stop();
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    const profileDir = () => {
      const dir = mkdtempSync(join(tmpdir(), "dulja-einvoice-versions-"));
      dirs.push(dir);
      return dir;
    };
    /** A stub server, and the committed profile at `version` pointed at it, written into `dir`. */
    const serveVersion = async (
      dir: string,
      version: number,
      script: Parameters<typeof startStubServer>[0],
    ): Promise<StubServer> => {
      const stub = await startStubServer(script);
      servers.push(stub);
      writeFileSync(
        join(dir, `synthetic.v${version}.json`),
        JSON.stringify({ ...stub.profile, version }),
      );
      return stub;
    };
    const boot = (dir: string) => {
      const report = registerDefaultTransmitters("dev", { profileDir: dir, env: ENV });
      expect(report.skipped).toEqual([]);
    };

    it("a row submitted under v1 polls and cancels through v1 after v2 is registered; a new row submits under v2", async () => {
      const dir = profileDir();
      const v1 = await serveVersion(dir, 1, {
        submit: { state: "queued", receiptId: "R-v1" },
        poll: { state: "cleared" },
        cancel: { state: "withdrawn" },
      });
      boot(dir);
      const old = await pending();
      expect((await submitTransmission(db.rw, ctx, { transmissionId: old })).profileVersion).toBe(
        1,
      );

      const v2 = await serveVersion(dir, 2, { submit: { state: "queued", receiptId: "R-v2" } });
      boot(dir); // the next deployment: v2 ships beside v1

      const polled = await pollTransmission(db.rw, ctx, { transmissionId: old });
      expect(polled.status).toBe("accepted");
      expect(polled.profileVersion).toBe(1);
      const cancelled = await cancelTransmission(db.rw, ctx, {
        transmissionId: old,
        reason: "keyed twice",
      });
      expect(cancelled.status).toBe("cancelled");
      expect(v1.calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
      expect(v2.calls).toHaveLength(0);

      const fresh = await pending();
      const submitted = await submitTransmission(db.rw, ctx, { transmissionId: fresh });
      expect(submitted.profileVersion).toBe(2);
      expect(submitted.externalId).toBe("R-v2");
      expect(v2.calls).toHaveLength(1);
      expect(v1.calls).toHaveLength(3);
    });

    it("a missing pinned version refuses poll and cancel with ERR_EINVOICE_TRANSMITTER_UNAVAILABLE naming it — nothing sent, the claim released", async () => {
      const first = profileDir();
      const v1 = await serveVersion(first, 1, {
        submit: [
          { state: "queued", receiptId: "R-pinned-a" },
          { state: "cleared", receiptId: "R-pinned-b" },
        ],
      });
      boot(first);
      const submitted = await pending();
      const accepted = await pending();
      await submitTransmission(db.rw, ctx, { transmissionId: submitted });
      expect((await submitTransmission(db.rw, ctx, { transmissionId: accepted })).status).toBe(
        "accepted",
      );

      const second = profileDir(); // a deployment that ships v2 and no longer ships v1
      const v2 = await serveVersion(second, 2, { poll: { state: "cleared" } });
      boot(second);
      for (const [id, call] of [
        [submitted, () => pollTransmission(db.rw, ctx, { transmissionId: submitted })],
        [accepted, () => cancelTransmission(db.rw, ctx, { transmissionId: accepted, reason: "x" })],
      ] as const) {
        await expect(call()).rejects.toMatchObject({
          code: "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
          detail: expect.stringContaining("synthetic profile version 1 is not registered"),
        });
        const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
        expect(row.profileVersion).toBe(1);
        expect(row.claimedAt).toBeNull();
        expect(row.lastError).toContain("version 1");
      }
      expect(v1.calls).toHaveLength(2); // the two submits, and nothing after
      expect(v2.calls).toHaveLength(0);
    });
  });

  it("submit records external id, hash, profile version, attempts and submitted_at", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-10" } });
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(row.status).toBe("submitted");
    expect(row.externalId).toBe("R-10");
    expect(row.attempts).toBe(1);
    expect(row.profileVersion).toBe(1);
    expect(row.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.submittedAt).not.toBeNull();
    expect(row.polledAt).not.toBeNull(); // the call COMPLETED at this instant
    expect(row.claimedAt).toBeNull(); // and its claim ended with it (ADR 0053), which is what
    // lets the next `it` poll straight afterwards
    expect(row.acceptedAt).toBeNull();
  });

  it("submit that clears in one call sets accepted_at and the QR payload", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-11" } });
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(row.status).toBe("accepted");
    expect(row.acceptedAt).not.toBeNull();
    expect(row.qrPayload).toMatch(/^dulja-synthetic:[0-9a-f]{64}:[0-9a-f]{64}$/);
  });

  it("poll moves submitted → accepted and writes the QR payload and polled_at", async () => {
    await arm({
      submit: { state: "queued", receiptId: "R-12" },
      poll: [{ state: "queued" }, { state: "cleared" }],
    });
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });

    const stillOpen = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(stillOpen.status).toBe("submitted");
    expect(stillOpen.qrPayload).toBeNull();

    const done = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(done.status).toBe("accepted");
    expect(done.qrPayload).not.toBeNull();
    expect(done.attempts).toBe(3);
  });

  it("cancel moves accepted → cancelled and keeps accepted_at", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-13" }, cancel: { state: "withdrawn" } });
    const id = await pending();
    const accepted = await submitTransmission(db.rw, ctx, { transmissionId: id });
    const cancelled = await cancelTransmission(db.rw, ctx, {
      transmissionId: id,
      reason: "keyed twice",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.acceptedAt).toBe(accepted.acceptedAt);
  });

  it("records an authentication-refused poll diagnostic instead of accepting its success-shaped body, and keeps the row submitted", async () => {
    // ADR 0053, amendment 2026-10-06: a POLL never demotes. The 403's success-shaped body is still
    // not believed — no accepted_at, no QR — but `error` is resubmittable, and the authority already
    // holds this document under R-poll-auth: `error` here is how the same invoice is sent twice.
    await arm({
      submit: { state: "queued", receiptId: "R-poll-auth" },
      poll: [{ state: "cleared", status: 403 }, { state: "cleared" }],
    });
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });
    const refused = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(refused.status).toBe("submitted");
    expect(refused.externalId).toBe("R-poll-auth");
    expect(refused.acceptedAt).toBeNull();
    expect(refused.qrPayload).toBeNull();
    expect(refused.claimedAt).toBeNull();
    expect(refused.lastError).toContain('"httpStatus":403');

    // Still pollable, so reconciliation reaches the authority's real answer on the next call.
    const accepted = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(accepted.status).toBe("accepted");
    expect(accepted.acceptedAt).not.toBeNull();
    expect(accepted.qrPayload).not.toBeNull();
    expect(accepted.lastError).toBeNull();
  });

  it("an UNMAPPED poll label keeps the row submitted with the label in last_error, and polling continues", async () => {
    const stub = await arm({
      submit: { state: "queued", receiptId: "R-poll-unmapped" },
      poll: [{ state: "in_review" }, { state: "cleared" }],
    });
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });
    const open = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(open.status).toBe("submitted");
    expect(open.lastError).toContain("in_review"); // SAH-020: the label is visible…
    expect(open.acceptedAt).toBeNull(); // …and nothing is treated as accepted
    expect(open.qrPayload).toBeNull();
    expect(open.claimedAt).toBeNull();
    expect(open.attempts).toBe(2);

    // The authority holds R-poll-unmapped, so the document is not sent again…
    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toMatchObject({
      code: "ERR_EINVOICE_STATUS_ILLEGAL",
    });
    // …and the next poll settles it.
    expect((await pollTransmission(db.rw, ctx, { transmissionId: id })).status).toBe("accepted");
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a NON-2xx poll is never definitive: a 403 carrying the profile's refusal label keeps the row submitted", async () => {
    // http-transmitter forces only a success-shaped label on a non-2xx to `error`; `refused` maps to
    // `rejected` and passes through, because a 4xx SUBMIT refusal is an outcome (ADR 0053 §2). On a
    // POLL the authority already holds the document, so `rejected` (resubmittable) from an answer
    // that was itself refused is how one invoice is sent twice.
    const stub = await arm({
      submit: [
        { state: "queued", receiptId: "R-poll-403" },
        { state: "queued", receiptId: "R-poll-403-again" },
      ],
      poll: [{ status: 403, json: { state: "refused" } }, { state: "cleared" }],
    });
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });
    const refused = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(refused.status).toBe("submitted");
    expect(refused.externalId).toBe("R-poll-403");
    expect(refused.lastError).toContain('"httpStatus":403');
    expect(refused.acceptedAt).toBeNull();
    expect(refused.claimedAt).toBeNull();

    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toMatchObject({
      code: "ERR_EINVOICE_STATUS_ILLEGAL",
    });
    expect((await pollTransmission(db.rw, ctx, { transmissionId: id })).status).toBe("accepted");
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a NON-2xx poll with no status label records its HTTP status, not just `<absent>`", async () => {
    // The authority answering that it does not know the id is the amendment's own open case; the
    // operator must be able to tell it from a 200 with a missing field.
    await arm({
      submit: { state: "queued", receiptId: "R-poll-404" },
      poll: { status: 404, json: { reason: "not found" } },
    });
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });
    const unknown = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(unknown.status).toBe("submitted");
    expect(unknown.lastError).toContain('"httpStatus":404');
    expect(unknown.lastError).toContain("not found");
  });

  it("records a cancellation reported while polling and releases its claim", async () => {
    const stub = await arm({
      submit: { state: "queued", receiptId: "R-remote-cancel" },
      poll: { state: "withdrawn" },
    });
    registerTransmitter(
      "synthetic",
      createSyntheticTransmitter({
        env: ENV,
        profile: {
          ...stub.profile,
          calls: {
            ...stub.profile.calls,
            poll: { ...stub.profile.calls.poll, statusMap: { withdrawn: "cancelled" } },
          },
        },
      }),
    );
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });
    const cancelled = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.claimedAt).toBeNull();
    expect(cancelled.acceptedAt).toBeNull();
  });

  it.each([
    { state: "unrecognized", status: 200 },
    { state: "withdrawn", status: 403 },
  ])(
    "a cancellation refusal ($status/$state) retains acceptance and permits recovery",
    async (refusal) => {
      await arm({
        submit: { state: "cleared", receiptId: "R-refused-cancel" },
        cancel: [refusal, { state: "withdrawn" }],
      });
      const id = await pending();
      const accepted = await submitTransmission(db.rw, ctx, { transmissionId: id });
      const refused = await cancelTransmission(db.rw, ctx, {
        transmissionId: id,
        reason: "duplicate",
      });
      expect(refused.status).toBe("accepted");
      expect(refused.acceptedAt).toBe(accepted.acceptedAt);
      expect(refused.qrPayload).toBe(accepted.qrPayload);
      expect(refused.cancelledAt).toBeNull();
      expect(refused.claimedAt).toBeNull();
      expect(refused.lastError).toBeTruthy();
      const recovered = await cancelTransmission(db.rw, ctx, {
        transmissionId: id,
        reason: "duplicate",
      });
      expect(recovered.status).toBe("cancelled");
      expect(recovered.cancelledAt).not.toBeNull();
    },
  );

  it("a poll QR failure releases the claim for recovery", async () => {
    const stub = await arm({
      submit: { state: "queued", receiptId: "R-qr-fault" },
      poll: { state: "cleared" },
    });
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });
    registerTransmitter("synthetic", {
      ...createSyntheticTransmitter({ profile: stub.profile, env: ENV }),
      qrPayload() {
        throw new Error("QR generation failed");
      },
    });
    await expect(pollTransmission(db.rw, ctx, { transmissionId: id })).rejects.toThrow(
      "QR generation failed",
    );
    const faulted = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(faulted.status).toBe("submitted");
    expect(faulted.claimedAt).toBeNull();
    expect(faulted.polledAt).not.toBeNull();
    expect(faulted.lastError).toContain("QR generation failed");
    registerTransmitter(
      "synthetic",
      createSyntheticTransmitter({ profile: stub.profile, env: ENV }),
    );
    expect((await pollTransmission(db.rw, ctx, { transmissionId: id })).status).toBe("accepted");
  });

  it("a submit QR failure after the authority ACCEPTED records submitted under its id — the recovery is a poll, never a second submission", async () => {
    // The authority answered 2xx `accepted` with an external id: it holds the document. A thrown QR
    // failure used to leave the row `pending` with no id, and pg-boss's retry POSTed it again.
    const stub = await arm({
      submit: { state: "cleared", receiptId: "R-qr-submit" },
      poll: { state: "cleared" },
    });
    const id = await pending();
    registerTransmitter("synthetic", {
      ...createSyntheticTransmitter({ profile: stub.profile, env: ENV }),
      qrPayload() {
        throw new Error("QR generation failed");
      },
    });
    const held = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(held.status).toBe("submitted");
    expect(held.externalId).toBe("R-qr-submit");
    expect(held.acceptedAt).toBeNull();
    expect(held.qrPayload).toBeNull();
    expect(held.claimedAt).toBeNull();
    expect(held.polledAt).not.toBeNull();
    expect(held.lastError).toContain("QR generation failed");

    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toMatchObject({
      code: "ERR_EINVOICE_STATUS_ILLEGAL",
    });
    registerTransmitter(
      "synthetic",
      createSyntheticTransmitter({ profile: stub.profile, env: ENV }),
    );
    const accepted = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(accepted.status).toBe("accepted");
    expect(accepted.qrPayload).not.toBeNull();
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a 4xx refusal is an OUTCOME: status rejected, no throw, and resubmit is legal", async () => {
    await arm({
      submit: [
        { status: 422, json: { state: "refused", receiptId: "R-14", reason: "stub refusal" } },
        { state: "cleared", receiptId: "R-14" },
      ],
    });
    const id = await pending();
    const rejected = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(rejected.status).toBe("rejected");
    expect(rejected.lastError).toContain("stub refusal");

    const retried = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(retried.status).toBe("accepted");
    expect(retried.attempts).toBe(2);
  });

  it("a 5xx is a FAULT: the call throws for pg-boss, the row keeps its status and counts the attempt", async () => {
    await arm({ submit: { status: 503, json: { state: "queued" } } });
    const id = await pending();
    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toThrow(/503/);
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("503");
  });

  it("an UNMAPPED remote label on an ACKNOWLEDGED submit is recorded submitted, never resubmittable (SAH-020)", async () => {
    // A 2xx that returned an external id is the authority acknowledging intake. ADR 0053's 2026-10-06
    // amendment records it `submitted` (pollable) rather than `error` (resubmittable): the label is
    // still visible and nothing is treated as accepted, but the document is never sent twice.
    const stub = await arm({ submit: { state: "in_review", receiptId: "R-15" } });
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(row.status).toBe("submitted");
    expect(row.externalId).toBe("R-15");
    expect(row.lastError).toContain("in_review");
    expect(row.acceptedAt).toBeNull();
    expect(row.qrPayload).toBeNull();

    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toMatchObject({
      code: "ERR_EINVOICE_STATUS_ILLEGAL",
    });
    expect(stub.calls).toHaveLength(1); // the refusal was local: no second submission went out
  });

  it("an UNACKNOWLEDGED submit (4xx, unmapped label, no external id) lands in error and IS resubmittable", async () => {
    const stub = await arm({
      submit: [
        { status: 422, json: { state: "in_review" } },
        { state: "queued", receiptId: "R-unacked" },
      ],
    });
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(row.status).toBe("error");
    expect(row.externalId).toBeNull();
    expect(row.lastError).toContain("in_review");
    // The authority REFUSED this one (a 4xx): it holds nothing, so there is nothing to warn about.
    expect(row.lastError).not.toContain("may already hold");
    expect(row.lastError!.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX)).toBe(false);

    const retried = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(retried.status).toBe("submitted");
    expect(retried.externalId).toBe("R-unacked");
    expect(retried.attempts).toBe(2);
    expect(stub.calls).toHaveLength(2);
  });

  it("a 2xx submit recorded `error` (unmapped label, no external id) warns that the authority may already hold the document", async () => {
    // The log cannot address it — no external id, so no poll — and records `error`. But the authority
    // answered 2xx: unlike a 4xx it may have taken the document in. The job ends without resending,
    // and `last_error` carries the same warning, and the redacted answer, as an acknowledgement the
    // transmitter could not read — the operator confirms with the authority before resubmitting.
    const stub = await arm({ submit: { state: "in_review", reason: "intake-ref-77" } });
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(row.status).toBe("error");
    expect(row.externalId).toBeNull();
    expect(row.lastError).toContain("http 200");
    expect(row.lastError).toContain("in_review");
    expect(row.lastError).toContain("may already hold this document");
    // It LEADS with the one exported prefix the worker and the operator route read (PR 11 review).
    expect(row.lastError!.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX)).toBe(true);
    expect(row.lastError).toContain("intake-ref-77"); // the answer itself, which is not on the wire otherwise
    expect(row.claimedAt).toBeNull();
    expect(row.acceptedAt).toBeNull();
    expect(stub.calls).toHaveLength(1);
  });

  it("a submit refused on authentication stays error even though its success-shaped body carries an id", async () => {
    // The HTTP status, not the presence of an id, is what says the authority acknowledged intake:
    // http-transmitter forces a success-shaped label on a non-2xx to `error`, and that must stay
    // resubmittable — the authority refused the request, it holds nothing.
    await arm({
      submit: [
        { status: 403, json: { state: "queued", receiptId: "R-auth-refused" } },
        { state: "queued", receiptId: "R-auth-retry" },
      ],
    });
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(row.status).toBe("error");
    expect(row.lastError).toContain('"httpStatus":403');
    expect(row.acceptedAt).toBeNull();

    const retried = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(retried.status).toBe("submitted");
    expect(retried.externalId).toBe("R-auth-retry");
  });

  it.each([
    {
      label: "an id carrying credential material",
      reply: { receiptId: "echo-s3cr3t" },
      says: "refusing to persist",
    },
    { label: "no external id at all", reply: {}, says: "returned no external id" },
  ])(
    "a 2xx submit whose acknowledgement cannot be read ($label) is an OUTCOME, `error`, and does not throw",
    async ({ reply, says }) => {
      // A response the authority sent with a 2xx is not a transport fault: throwing it made pg-boss
      // retry the job, and every retry POSTed the document again. It is recorded `error` — the
      // amendment's "no usable external id" case — and the job ends; resubmission is an operator's.
      const stub = await arm({ submit: { state: "queued", ...reply } });
      const id = await pending();
      const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
      expect(row.status).toBe("error");
      expect(row.externalId).toBeNull();
      expect(row.lastError).toContain(says);
      expect(row.lastError).toContain("http 200");
      expect(row.lastError).toContain("may already hold this document");
      expect(row.lastError!.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX)).toBe(true);
      expect(row.lastError).not.toContain("s3cr3t");
      expect(JSON.stringify(row.response)).not.toContain("s3cr3t");
      expect(row.claimedAt).toBeNull();
      expect(row.acceptedAt).toBeNull();
      expect(stub.calls).toHaveLength(1);
    },
  );

  it("a 2xx submit acknowledged with an id under a label mapped to `pending` is recorded submitted, not resubmittable", async () => {
    // `pending` means "never sent" in the log; the authority's own `pending` with an id means it
    // holds the document. Recorded as such, the worker would neither poll it nor stop a resubmit.
    const stub = await startStubServer({ submit: { state: "held", receiptId: "R-held" } });
    server = stub;
    registerTransmitter(
      "synthetic",
      createSyntheticTransmitter({
        env: ENV,
        profile: {
          ...stub.profile,
          calls: {
            ...stub.profile.calls,
            submit: {
              ...stub.profile.calls.submit,
              statusMap: { ...stub.profile.calls.submit.statusMap, held: "pending" },
            },
          },
        },
      }),
    );
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(row.status).toBe("submitted");
    expect(row.externalId).toBe("R-held");
    expect(row.lastError).toContain("held");
    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toMatchObject({
      code: "ERR_EINVOICE_STATUS_ILLEGAL",
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("binds every verb to the caller's company when one is given — checked inside the claim, before the status", async () => {
    // AGENTS.md: RLS bounds the tenant and nothing else, so a route whose gate cleared a company must
    // pass it down. A row of another company is ERR_NOT_FOUND even where its status would also be
    // illegal for the verb — the company is checked first, so a sibling learns neither existence
    // nor status — and nothing is claimed or sent.
    const stub = await arm({
      submit: { state: "queued", receiptId: "R-company" },
      poll: { state: "cleared" },
      cancel: { state: "withdrawn" },
    });
    const id = await pending();
    const elsewhere = await uuidv7(db.admin);
    const refusedFor = async (status: string) => {
      for (const call of [
        () => submitTransmission(db.rw, ctx, { transmissionId: id, companyId: elsewhere }),
        () => pollTransmission(db.rw, ctx, { transmissionId: id, companyId: elsewhere }),
        () =>
          cancelTransmission(db.rw, ctx, { transmissionId: id, companyId: elsewhere, reason: "x" }),
      ]) {
        // The same detail a missing id gets: the sibling learns nothing it could not learn by
        // guessing an id that does not exist.
        await expect(call()).rejects.toMatchObject({
          code: "ERR_NOT_FOUND",
          detail: `transmission ${id} does not exist`,
        });
      }
      const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
      expect(row.status).toBe(status);
      expect(row.claimedAt).toBeNull();
      return row.attempts;
    };

    expect(await refusedFor("pending")).toBe(0);
    await submitTransmission(db.rw, ctx, { transmissionId: id, companyId: s.company });
    expect(await refusedFor("submitted")).toBe(1);
    await pollTransmission(db.rw, ctx, { transmissionId: id, companyId: s.company });
    expect(await refusedFor("accepted")).toBe(2);
    const cancelled = await cancelTransmission(db.rw, ctx, {
      transmissionId: id,
      companyId: s.company,
      reason: "keyed twice",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(stub.calls).toHaveLength(3); // one submit, one poll, one cancel — every refusal was local
  });

  it("refuses every illegal verb with ERR_EINVOICE_STATUS_ILLEGAL naming the legal set", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-16" }, cancel: { state: "withdrawn" } });
    const id = await pending();

    await expect(pollTransmission(db.rw, ctx, { transmissionId: id })).rejects.toThrow(
      /is pending; poll has allowed states submitted/,
    );

    await expect(
      cancelTransmission(db.rw, ctx, { transmissionId: id, reason: "x" }),
    ).rejects.toThrow(/is pending; cancel has allowed states accepted/);

    await submitTransmission(db.rw, ctx, { transmissionId: id });
    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toThrow(
      /is accepted; submit has allowed states pending, error, rejected/,
    );

    await cancelTransmission(db.rw, ctx, { transmissionId: id, reason: "x" });
    await expect(
      cancelTransmission(db.rw, ctx, { transmissionId: id, reason: "x" }),
    ).rejects.toThrow(/is cancelled; cancel has allowed states accepted/);
  });

  it("refuses a company with e-invoicing off — ERR_EINVOICE_NOT_ENABLED", async () => {
    const other = await seedTenant(db, "einvoice-off");
    await grantCodes(db, other); // 6C: explicit company-wide branch visibility; no permission codes.
    const otherCtx = {
      tenantId: other.tenant,
      actorId: other.human,
      requestId: await uuidv7(db.admin),
    };
    const documentId = await draftDocument(db, other);
    const id = await prodWithTenant(db.rw, otherCtx, (tx) =>
      recordPending(tx, { documentId, companyId: other.company, transmitter: "synthetic" }),
    );
    try {
      await submitTransmission(db.rw, otherCtx, { transmissionId: id });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as EInvoiceError).code).toBe("ERR_EINVOICE_NOT_ENABLED");
    }
  });

  it("refuses an unregistered transmitter — ERR_EINVOICE_TRANSMITTER_UNAVAILABLE (OD-15's default)", async () => {
    resetTransmitters(); // nothing registered
    const id = await pending();
    try {
      await submitTransmission(db.rw, ctx, { transmissionId: id });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as EInvoiceError).code).toBe("ERR_EINVOICE_TRANSMITTER_UNAVAILABLE");
      expect((e as EInvoiceError).message).toContain("synthetic is not registered");
    }
  });

  it("ENDS THE CLAIM when the refusal comes before the call, so the retry is not swallowed", async () => {
    // The one assertion that keeps `retryLimit: 8` alive for the case it exists for. `claim()` has
    // already stamped `claimed_at`; `transmitterFor` then throws. If that throw skipped
    // `recordFault`, the claim would stand for CLAIM_WINDOW_SECONDS (120) while pg-boss's first
    // retry arrives at retryDelaySeconds (60) — inside the window — and `claim()` would refuse it
    // with ERR_EINVOICE_STATUS_ILLEGAL, which Task 7's handler reads as "nothing to do". The row
    // would be abandoned at `pending`. It is also the state every `myinvois` company is in before
    // OD-15, which is the path this slice most needs to keep retryable.
    resetTransmitters(); // nothing registered
    const id = await pending();
    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toThrow(
      EInvoiceError,
    );

    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.claimedAt, "recordFault must end the claim (ADR 0053 §3)").toBeNull();
    expect(row.polledAt).not.toBeNull(); // the attempt completed, unsuccessfully
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("not registered");

    // And the immediate re-attempt is admitted rather than refused as "a call in flight".
    await arm({ submit: { state: "queued", receiptId: "R-21" } });
    const retried = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(retried.status).toBe("submitted");
    expect(retried.attempts).toBe(2);
  });

  it("refuses a transmission id another tenant owns with ERR_NOT_FOUND, never revealing it exists", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-17" } });
    const id = await pending();
    const other = await seedTenant(db, "einvoice-nosee");
    await grantCodes(db, other); // 6C: explicit company-wide branch visibility; no permission codes.
    const otherCtx = {
      tenantId: other.tenant,
      actorId: other.human,
      requestId: await uuidv7(db.admin),
    };
    try {
      await prodWithTenant(db.rw, otherCtx, (tx) => getTransmission(tx, id));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as EInvoiceError).code).toBe("ERR_NOT_FOUND");
    }
  });

  it("lists by company, newest first, filtered by status, keyset-paged by id", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-18" } });
    const a = await pending();
    const b = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: b });

    const all = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 100 }),
    );
    expect(all.map((r) => r.id)).toContain(a);
    expect(all.map((r) => r.id)).toContain(b);
    expect(all[0]!.id > all[1]!.id).toBe(true); // uuidv7 is time-ordered; newest first

    const submitted = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, status: "submitted", limit: 100 }),
    );
    expect(submitted.every((r) => r.status === "submitted")).toBe(true);

    const firstPage = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 1 }),
    );
    const secondPage = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 1, afterId: firstPage[0]!.id }),
    );
    expect(secondPage[0]!.id).not.toBe(firstPage[0]!.id);
    expect(secondPage[0]!.id < firstPage[0]!.id).toBe(true);
  });

  it("never stores a credential in `response`, even when the authority echoes one", async () => {
    await arm({
      submit: {
        json: {
          state: "cleared",
          receiptId: "R-19",
          accessToken: "leaky",
          nested: { clientSecret: "leaky" },
        },
      },
    });
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(JSON.stringify(row.response)).not.toContain("leaky");
    expect(JSON.stringify(row.response)).toContain("[redacted]");
  });

  it("every write is audited under the acting principal (test 13)", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-20" } });
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<{ action: string; actor_id: string }[]>`
        select action, actor_id::text
          from app.audit_log
         where table_name = 'einvoice_transmission' and row_id = ${id}
         order by seq`,
    );
    expect(rows.map((r) => r.action)).toEqual(["insert", "update", "update"]);
    expect(new Set(rows.map((r) => r.actor_id))).toEqual(new Set([s.human]));
  });

  it("admitOperatorSubmit records an operator's resubmission of a warned row: the prefix goes, the diagnostic stays, and the update is audited", async () => {
    // ADR 0053's amendment makes a 2xx submit the log records `error` terminal for AUTOMATION; the
    // operator's submit route is the deliberate resubmission. It rewrites `last_error` in the
    // transaction that enqueues, so the job it enqueues proceeds where every other one stops (PR 11).
    await arm({ submit: { state: "queued" } }); // 2xx, no receiptId: the unaddressable case
    const id = await pending();
    const warned = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(warned.status).toBe("error");
    expect(warned.lastError!.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX)).toBe(true);
    const diagnosticText = warned.lastError!.slice(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX.length);

    const admitted = await prodWithTenant(db.rw, ctx, (tx) => admitOperatorSubmit(tx, id));
    expect(admitted.status).toBe("error");
    expect(admitted.lastError!.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX)).toBe(false);
    expect(admitted.lastError).toMatch(/^resubmission requested by an operator; /);
    expect(admitted.lastError).not.toContain("may already hold"); // the prefix is not repeated
    expect(admitted.lastError!.endsWith(diagnosticText)).toBe(true);
    expect(admitted.lastError).toContain("http 200");
    expect(admitted.lastError).toContain("returned no external id");
    expect(admitted.attempts).toBe(1); // admission claims nothing and calls nothing
    expect(admitted.claimedAt).toBeNull();
    expect(server!.calls).toHaveLength(1);

    const [audited] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<{ action: string; actor_id: string; last_error: string | null }[]>`
        select action, actor_id::text, after->>'last_error' as last_error
          from app.audit_log
         where table_name = 'einvoice_transmission' and row_id = ${id}
         order by seq desc
         limit 1`,
    );
    expect(audited).toEqual({
      action: "update",
      actor_id: s.human,
      last_error: admitted.lastError,
    });

    // Admitting again changes nothing: the row carries no prefix to remove, so the text never nests.
    const again = await prodWithTenant(db.rw, ctx, (tx) => admitOperatorSubmit(tx, id));
    expect(again.lastError).toBe(admitted.lastError);
  });

  it("admitOperatorSubmit leaves every other row's last_error as it is — a 4xx `error`, a pending row", async () => {
    // A 4xx `error` carries no warning (the authority refused it and holds nothing), so automation
    // may resubmit it and the operator's request has nothing to record over.
    await arm({ submit: { status: 422, json: { state: "in_review" } } });
    const refused = await pending();
    const before = await submitTransmission(db.rw, ctx, { transmissionId: refused });
    expect(before.status).toBe("error");
    expect(before.lastError!.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX)).toBe(false);
    const after = await prodWithTenant(db.rw, ctx, (tx) => admitOperatorSubmit(tx, refused));
    expect(after.lastError).toBe(before.lastError);

    const untouched = await pending();
    const fresh = await prodWithTenant(db.rw, ctx, (tx) => admitOperatorSubmit(tx, untouched));
    expect(fresh.status).toBe("pending");
    expect(fresh.lastError).toBeNull();
  });

  it("admitOperatorSubmit refuses while a call is in flight — claimed_at younger than CLAIM_WINDOW_SECONDS, as claim() does", async () => {
    const id = await pending();
    await prodWithTenant(db.rw, ctx, async (tx) => {
      await tx`update app.einvoice_transmission set claimed_at = now() where id = ${id}`;
    });
    await expect(
      prodWithTenant(db.rw, ctx, (tx) => admitOperatorSubmit(tx, id)),
    ).rejects.toMatchObject({
      code: "ERR_EINVOICE_STATUS_ILLEGAL",
      detail: `transmission ${id} has a call in flight (claimed within ${CLAIM_WINDOW_SECONDS}s)`,
    });
    // A claim older than the window is a dead one, which claim() itself would take over.
    await prodWithTenant(db.rw, ctx, async (tx) => {
      await tx`update app.einvoice_transmission
                  set claimed_at = now() - make_interval(secs => ${CLAIM_WINDOW_SECONDS + 1})
                where id = ${id}`;
    });
    const admitted = await prodWithTenant(db.rw, ctx, (tx) => admitOperatorSubmit(tx, id));
    expect(admitted.status).toBe("pending");
  });

  it("the submit claim itself refuses a warned `error` row — nothing claimed, counted, sent or rewritten — until admitOperatorSubmit records the request", async () => {
    // The worker's pre-read is not the only gate (PR 11 review, second pass): it reads the row in one
    // transaction and submitTransmission claims it in another, and SUBMITTABLE_FROM admits `error`.
    // "Terminal for automation" is enforced in the transaction that takes the claim, like every other
    // status rule, so a caller that read the row before the warning landed still sends nothing.
    const stub = await arm({
      submit: [{ state: "queued" }, { state: "queued", receiptId: "R-after-admission" }],
    });
    const id = await pending();
    const warned = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(warned.status).toBe("error");
    expect(warned.lastError!.startsWith(UNADDRESSED_ACKNOWLEDGEMENT_PREFIX)).toBe(true);

    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toMatchObject({
      code: "ERR_EINVOICE_STATUS_ILLEGAL",
      detail: `transmission ${id} is error after a 2xx this log could not address, and the authority may already hold it; only an operator's submit resubmits it`,
    });
    expect(stub.calls).toHaveLength(1);
    const refused = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(refused).toEqual(warned); // not claimed, not counted, the warning not overwritten

    await prodWithTenant(db.rw, ctx, (tx) => admitOperatorSubmit(tx, id));
    const resubmitted = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(resubmitted.status).toBe("submitted");
    expect(resubmitted.externalId).toBe("R-after-admission");
    expect(resubmitted.attempts).toBe(2);
    expect(stub.calls).toHaveLength(2);
  });

  // ── a claim taken over mid-call (ADR 0053 §3, PR 11 review) ─────────────────────────────────
  //
  // claim() admits a second caller once `claimed_at` is older than CLAIM_WINDOW_SECONDS, and that
  // caller restamps `claimed_at` and increments `attempts`. A call still running under the first
  // claim must then record NOTHING when it ends — not its outcome, not its fault, and not the
  // `claimed_at = null` that would release the second claim while its call is in flight. Each case
  // holds both calls at a gate in front of the transmitter, forces the first claim older than the
  // window, lets the second claim take the row over, and only then lets the first call finish.

  const armGated = async (script: Parameters<typeof startStubServer>[0]) => {
    const stub = await arm(script);
    const base = createSyntheticTransmitter({ profile: stub.profile, env: ENV });
    const gate = callGate();
    const gated = () =>
      registerTransmitter("synthetic", {
        ...base,
        async submit(doc, credentials) {
          await gate.pass();
          return base.submit(doc, credentials);
        },
        async poll(externalId, credentials) {
          await gate.pass();
          return base.poll(externalId, credentials);
        },
        async cancel(externalId, reason, credentials) {
          await gate.pass();
          return base.cancel(externalId, reason, credentials);
        },
      });
    return { stub, gate, gated };
  };

  /** What claim() would see after CLAIM_WINDOW_SECONDS without anybody waiting that long. */
  const lapseClaim = (id: string) =>
    prodWithTenant(db.rw, ctx, async (tx) => {
      await tx`update app.einvoice_transmission
                  set claimed_at = claimed_at - make_interval(secs => ${CLAIM_WINDOW_SECONDS + 1})
                where id = ${id} and claimed_at is not null`;
    });

  const read = (id: string) => prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));

  it("a submit whose claim was taken over mid-call records nothing, and the second claim stands", async () => {
    const { stub, gate, gated } = await armGated({
      submit: [
        { state: "queued", receiptId: "R-first" },
        { state: "queued", receiptId: "R-second" },
      ],
    });
    gated();
    const id = await pending();
    const stderr = stderrLines();
    try {
      const first = submitTransmission(db.rw, ctx, { transmissionId: id });
      first.catch(() => undefined); // observed below, after the second claim is taken
      await gate.arrived(1);
      await lapseClaim(id);
      const second = submitTransmission(db.rw, ctx, { transmissionId: id });
      await gate.arrived(2);
      const taken = await read(id);
      expect(taken.attempts).toBe(2);
      expect(taken.claimedAt).not.toBeNull();

      gate.release(0); // the first call reaches the authority and gets its answer only now
      await expect(first).rejects.toMatchObject({
        code: "ERR_EINVOICE_STATUS_ILLEGAL",
        detail: expect.stringContaining(`transmission ${id}`),
      });
      // Nothing of the first call landed, and the second call's claim was not released under it.
      expect(await read(id)).toEqual(taken);
      expect(stderr.lines.join("")).toContain(id);
      expect(stderr.lines.join("")).toContain("R-first");

      gate.release(1);
      const recorded = await second;
      expect(recorded.status).toBe("submitted");
      expect(recorded.externalId).toBe("R-second");
      expect(recorded.attempts).toBe(2);
      expect(recorded.claimedAt).toBeNull();
      expect(stub.calls).toHaveLength(2);
    } finally {
      stderr.restore();
    }
  });

  it("a poll whose claim was taken over mid-call records nothing — not even an acceptance", async () => {
    const { stub, gate, gated } = await armGated({
      submit: { state: "queued", receiptId: "R-poll-takeover" },
      poll: [{ state: "cleared" }, { state: "queued" }],
    });
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });
    gated();
    const stderr = stderrLines();
    try {
      const first = pollTransmission(db.rw, ctx, { transmissionId: id });
      first.catch(() => undefined);
      await gate.arrived(1);
      await lapseClaim(id);
      const second = pollTransmission(db.rw, ctx, { transmissionId: id });
      await gate.arrived(2);
      const taken = await read(id);
      expect(taken.attempts).toBe(3);

      gate.release(0); // its answer is `cleared` — an acceptance this call no longer owns
      await expect(first).rejects.toMatchObject({ code: "ERR_EINVOICE_STATUS_ILLEGAL" });
      const after = await read(id);
      expect(after).toEqual(taken);
      expect(after.status).toBe("submitted");
      expect(after.acceptedAt).toBeNull();
      expect(after.qrPayload).toBeNull();
      expect(after.claimedAt).not.toBeNull();
      expect(stderr.lines.join("")).toContain(id);

      gate.release(1);
      const recorded = await second;
      expect(recorded.status).toBe("submitted"); // the second call's own answer, `queued`
      expect(recorded.claimedAt).toBeNull();
      expect(stub.calls).toHaveLength(3);
    } finally {
      stderr.restore();
    }
  });

  it("a cancel whose claim was taken over mid-call records nothing", async () => {
    const { stub, gate, gated } = await armGated({
      submit: { state: "cleared", receiptId: "R-cancel-takeover" },
      cancel: [{ state: "withdrawn" }, { state: "refused", reason: "not yet" }],
    });
    const id = await pending();
    const accepted = await submitTransmission(db.rw, ctx, { transmissionId: id });
    gated();
    const stderr = stderrLines();
    try {
      const first = cancelTransmission(db.rw, ctx, { transmissionId: id, reason: "first" });
      first.catch(() => undefined);
      await gate.arrived(1);
      await lapseClaim(id);
      const second = cancelTransmission(db.rw, ctx, { transmissionId: id, reason: "second" });
      await gate.arrived(2);
      const taken = await read(id);

      gate.release(0);
      await expect(first).rejects.toMatchObject({ code: "ERR_EINVOICE_STATUS_ILLEGAL" });
      const after = await read(id);
      expect(after).toEqual(taken);
      expect(after.status).toBe("accepted");
      expect(after.cancelledAt).toBeNull();
      expect(stderr.lines.join("")).toContain(id);

      gate.release(1);
      const recorded = await second;
      expect(recorded.status).toBe("accepted"); // the second cancellation was refused
      expect(recorded.acceptedAt).toBe(accepted.acceptedAt);
      expect(recorded.claimedAt).toBeNull();
      expect(stub.calls).toHaveLength(3);
    } finally {
      stderr.restore();
    }
  });

  it("a FAULT under a claim taken over records nothing, and never releases the second claim", async () => {
    const { stub, gate, gated } = await armGated({
      submit: [
        { status: 503, json: { state: "queued" } },
        { state: "queued", receiptId: "R-after" },
      ],
    });
    gated();
    const id = await pending();
    const stderr = stderrLines();
    try {
      const first = submitTransmission(db.rw, ctx, { transmissionId: id });
      first.catch(() => undefined);
      await gate.arrived(1);
      await lapseClaim(id);
      const second = submitTransmission(db.rw, ctx, { transmissionId: id });
      await gate.arrived(2);
      const taken = await read(id);

      gate.release(0);
      // The first call's own failure still reaches its caller — it did fail — but nothing of it is
      // written: no `last_error`, no `polled_at`, and above all no `claimed_at = null`.
      await expect(first).rejects.toBeInstanceOf(TransientTransmissionError);
      const after = await read(id);
      expect(after).toEqual(taken);
      expect(after.claimedAt).not.toBeNull();
      expect(after.lastError).toBeNull();
      expect(stderr.lines.join("")).toContain(id);
      expect(stderr.lines.join("")).toContain("503");

      gate.release(1);
      const recorded = await second;
      expect(recorded.status).toBe("submitted");
      expect(recorded.externalId).toBe("R-after");
      expect(recorded.claimedAt).toBeNull();
      expect(stub.calls).toHaveLength(2);
    } finally {
      stderr.restore();
    }
  });

  // ── a record that lands between a claim's read and its update (PR 11 review, third pass) ─────
  //
  // A record changes `status` and clears `claimed_at`, and never touches `attempts`. A claim that
  // read the row while another call was in flight, and ran its UPDATE after that call's record had
  // committed, still matched `attempts = <what it read>` and `claimed_at is null`: it claimed a row
  // its read no longer described, past a status check made on the old status, and called the
  // authority again — a submit resent a document the authority held under the first call's id, and
  // a second cancel overwrote the recorded cancellation's answer. The claim now reads the row under
  // the lock its update takes, so that record waits for the second claim, which finds the first
  // claim standing and refuses. Each case holds the first call at the transmitter, holds the second
  // claim between its read and its UPDATE, lets the first call finish, and lets the second claim go
  // on once that record has landed (unlocked) or is waiting to (locked).

  /**
   * `arm`, and a `gated()` that registers its transmitter with the FIRST call after it held until
   * `release()`. Every later call goes straight through, so a call that should never have been made
   * reaches the stub and is counted instead of hanging the test.
   */
  const armFirstCallHeld = async (script: Parameters<typeof startStubServer>[0]) => {
    const stub = await arm(script);
    const base = createSyntheticTransmitter({ profile: stub.profile, env: ENV });
    let reached!: () => void;
    let release!: () => void;
    const atTransmitter = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const hold = async (): Promise<void> => {
      if (held) return;
      held = true;
      reached();
      await released;
    };
    const gated = () =>
      registerTransmitter("synthetic", {
        ...base,
        async submit(doc, credentials) {
          await hold();
          return base.submit(doc, credentials);
        },
        async cancel(externalId, reason, credentials) {
          await hold();
          return base.cancel(externalId, reason, credentials);
        },
      });
    return { stub, gated, atTransmitter, release };
  };

  /** Resolves once `work` has settled, or once some backend of this database waits on a lock. */
  const settledOrWaiting = async (work: Promise<unknown>): Promise<void> => {
    let settled = false;
    work.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 400; i += 1) {
      if (settled) return;
      const [row] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`;
      if (row!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the first call's record neither landed nor waited on a lock");
  };

  /**
   * `call` twice: the first through the pool, held at the transmitter with its claim taken; the
   * second through a pool that holds its claim's UPDATE, after its read. The first call is let go,
   * and once its record has landed (or waits on a lock) the second claim is. Returns the first
   * call's row and the second call's outcome — its row, or the error it raised.
   */
  const recordBetweenReadAndUpdate = async (
    held: Awaited<ReturnType<typeof armFirstCallHeld>>,
    call: (sql: Sql) => Promise<EinvoiceTransmissionRow>,
  ): Promise<{ first: EinvoiceTransmissionRow; second: unknown }> => {
    const first = call(db.rw);
    first.catch(() => undefined); // observed below
    await held.atTransmitter; // the first call's claim is taken and its call is in flight
    const paused = pausedAtClaimUpdate(db.rw);
    const second = call(paused.sql).then(
      (row) => row as unknown,
      (error: unknown) => error,
    );
    await paused.atUpdate; // the second claim has read the row, the first claim standing
    held.release();
    await settledOrWaiting(first);
    paused.release();
    return { second: await second, first: await first };
  };

  it("a submit whose claim read the row before another submit's record landed is refused — the document is not sent twice", async () => {
    const held = await armFirstCallHeld({
      submit: [
        { state: "queued", receiptId: "R-first" },
        { state: "queued", receiptId: "R-second" },
      ],
    });
    held.gated();
    const id = await pending();

    const { first, second } = await recordBetweenReadAndUpdate(held, (sql) =>
      submitTransmission(sql, ctx, { transmissionId: id }),
    );

    expect(held.stub.calls).toHaveLength(1);
    expect(second).toBeInstanceOf(EInvoiceError);
    expect(second).toMatchObject({
      code: "ERR_EINVOICE_STATUS_ILLEGAL",
      detail: `transmission ${id} has a call in flight (claimed within ${CLAIM_WINDOW_SECONDS}s)`,
    });
    expect(first.status).toBe("submitted");
    expect(first.externalId).toBe("R-first");
    expect(first.attempts).toBe(1);
    expect(first.claimedAt).toBeNull();
    expect(await read(id)).toEqual(first);
  });

  it("a cancel whose claim read the row before another cancel's record landed is refused — the recorded cancellation stands", async () => {
    const held = await armFirstCallHeld({
      submit: { state: "cleared", receiptId: "R-cancel-race" },
      cancel: [{ state: "withdrawn" }, { state: "refused", reason: "already withdrawn" }],
    });
    const id = await pending();
    expect((await submitTransmission(db.rw, ctx, { transmissionId: id })).status).toBe("accepted");
    held.gated();

    const { first, second } = await recordBetweenReadAndUpdate(held, (sql) =>
      cancelTransmission(sql, ctx, { transmissionId: id, reason: "keyed twice" }),
    );

    expect(held.stub.calls.map((c) => c.method)).toEqual(["POST", "POST"]); // submit, one cancel
    expect(second).toBeInstanceOf(EInvoiceError);
    expect(second).toMatchObject({
      code: "ERR_EINVOICE_STATUS_ILLEGAL",
      detail: `transmission ${id} has a call in flight (claimed within ${CLAIM_WINDOW_SECONDS}s)`,
    });
    expect(first.status).toBe("cancelled");
    expect(first.lastError).toBe("cancelled: keyed twice");
    expect(first.claimedAt).toBeNull();
    expect(await read(id)).toEqual(first);
  });
});
