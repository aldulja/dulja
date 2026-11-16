import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHttpTransmitter,
  TransientTransmissionError,
} from "../../src/einvoice/http-transmitter";
import {
  createSyntheticTransmitter,
  sha256Hex,
  syntheticCanonicalise,
  syntheticQrPayload,
} from "../../src/einvoice/synthetic";
import { EInvoiceError } from "../../src/einvoice/errors";
import { snapshotFixture, startStubServer, type StubServer } from "../support/einvoice-stub";

const CREDS = { clientId: "client-a", secretRef: "EINVOICE_CLIENT_SECRET" } as const;
/** Passed as the transmitter's `env` option, never through `process.env`: `call()` resolves the
 *  secret before it invokes `fetchImpl`, so a `fetch` wrapper is the wrong seam for it. */
const ENV = { EINVOICE_CLIENT_SECRET: "s3cr3t" };

let server: StubServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("syntheticCanonicalise — deterministic, and never re-derives an amount", () => {
  it("produces the same hash twice over the same snapshot", () => {
    const snap = snapshotFixture();
    const a = syntheticCanonicalise(snap);
    const b = syntheticCanonicalise(snap);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes every amount from the snapshot's Money as a 4-dp string", () => {
    const doc = syntheticCanonicalise(snapshotFixture());
    const lines = doc.lines as { amount: { amount: string; currency: string } }[];
    expect(lines[0]!.amount).toEqual({ amount: "100.0000", currency: "MYR" });
    expect(JSON.stringify(doc)).not.toMatch(/:\s*-?\d+\.\d+[,}]/); // no bare float anywhere
  });

  it("changes the hash when a line amount changes, and only then", () => {
    const base = syntheticCanonicalise(snapshotFixture());
    const sameAgain = syntheticCanonicalise(snapshotFixture({ notes: "irrelevant" }));
    const different = syntheticCanonicalise(snapshotFixture({ lineAmount: "100.0001" }));
    expect(sameAgain.hash).toBe(base.hash);
    expect(different.hash).not.toBe(base.hash);
  });

  it("qrPayload is a stable function of the document hash and the receipt id", () => {
    const doc = syntheticCanonicalise(snapshotFixture());
    expect(syntheticQrPayload(doc, { externalId: "R1" })).toBe(
      syntheticQrPayload(doc, { externalId: "R1" }),
    );
    expect(syntheticQrPayload(doc, { externalId: "R1" })).not.toBe(
      syntheticQrPayload(doc, { externalId: "R2" }),
    );
  });

  it("sha256Hex agrees with a known digest", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("createHttpTransmitter — submit", () => {
  it("sends the canonical body, the auth header and the client-id header, and maps the status", async () => {
    server = await startStubServer({ submit: { state: "queued", receiptId: "R-1" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const doc = t.canonicalise(snapshotFixture());

    const res = await t.submit(doc, CREDS);
    expect(res.status).toBe("submitted");
    expect(res.externalId).toBe("R-1");

    const [call] = server.calls;
    expect(call!.method).toBe("POST");
    expect(call!.path).toBe("/stub/documents");
    expect(call!.headers.authorization).toBe("Bearer s3cr3t");
    expect(call!.headers["x-stub-client-id"]).toBe("client-a");
    expect(call!.headers["content-type"]).toBe("application/json");
    // The body is canonicalJson of the EInvoiceDocument — byte-identical to a second canonicalise.
    expect(call!.body).toBe(server.canonicalOf(doc));
  });

  it("maps an accepted status and returns the raw body REDACTED for the log", async () => {
    server = await startStubServer({
      submit: { state: "cleared", receiptId: "R-2", token: "leaky" },
    });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const res = await t.submit(t.canonicalise(snapshotFixture()), CREDS);
    expect(res.status).toBe("accepted");
    expect(JSON.stringify(res.raw)).not.toContain("leaky");
  });

  it("redacts credential echoes from ordinary response fields and unknown statuses", async () => {
    server = await startStubServer({
      submit: { json: { state: "s3cr3t", receiptId: "R-echo", message: "Bearer s3cr3t" } },
    });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const result = await t.submit(t.canonicalise(snapshotFixture()), CREDS);
    expect(JSON.stringify(result.raw)).not.toContain("s3cr3t");
    expect(t.lastCall?.unmapped).toBe("[redacted]");
  });

  it("returns status diagnostics with each concurrent call", async () => {
    server = await startStubServer({
      submit: [
        { json: { state: "review_one", receiptId: "R-one" }, delayMs: 50 },
        { json: { state: "review_two", receiptId: "R-two" } },
      ],
    });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const results = await Promise.all([
      t.submit(t.canonicalise(snapshotFixture()), CREDS),
      t.submit(t.canonicalise(snapshotFixture()), CREDS),
    ]);
    expect(results.map((r) => [r.externalId, r.unmapped]).toSorted()).toEqual([
      ["R-one", "review_one"],
      ["R-two", "review_two"],
    ]);
  });

  it("redacts credentials from fetch failures before they can be persisted", async () => {
    server = await startStubServer({});
    const t = createHttpTransmitter({
      profile: server.profile,
      canonicalise: syntheticCanonicalise,
      qrPayload: syntheticQrPayload,
      env: ENV,
      fetchImpl: async () => {
        throw new Error("Bearer s3cr3t failed");
      },
    });
    await expect(t.submit(t.canonicalise(snapshotFixture()), CREDS)).rejects.toThrow(
      "Bearer [redacted] failed",
    );
  });

  it("maps a refusal to rejected and does NOT throw — a rejection is an outcome, not a fault", async () => {
    server = await startStubServer({
      submit: { status: 422, json: { state: "refused", receiptId: "R-3", reason: "stub refusal" } },
    });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const res = await t.submit(t.canonicalise(snapshotFixture()), CREDS);
    expect(res.status).toBe("rejected");
    expect(res.externalId).toBe("R-3");
  });

  it("maps an UNKNOWN remote label to error rather than to accepted (SAH-020)", async () => {
    server = await startStubServer({ submit: { state: "in_review", receiptId: "R-4" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const res = await t.submit(t.canonicalise(snapshotFixture()), CREDS);
    expect(res.status).toBe("error");
  });

  it("throws TransientTransmissionError on a 5xx and on a network failure, and NOT on a 4xx", async () => {
    server = await startStubServer({ submit: { status: 503, json: { state: "queued" } } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    await expect(t.submit(t.canonicalise(snapshotFixture()), CREDS)).rejects.toThrow(
      TransientTransmissionError,
    );

    const dead = createSyntheticTransmitter({
      profile: { ...server.profile, baseUrl: "http://127.0.0.1:1" },
      env: ENV,
    });
    await expect(dead.submit(dead.canonicalise(snapshotFixture()), CREDS)).rejects.toThrow(
      TransientTransmissionError,
    );
  });

  it("throws TransientTransmissionError when the call exceeds timeoutMs", async () => {
    server = await startStubServer({ submit: { delayMs: 200, state: "queued", receiptId: "R-5" } });
    // The profile's own floor is 1000 ms (the schema's `timeoutMs` minimum), so the abort is forced
    // from the fetch side rather than by writing an out-of-schema profile: `abortingFetch(50)` fires
    // inside the stub's own 200 ms delay, `fetch` rejects with an AbortError, and `call()`'s catch
    // turns any such rejection into TransientTransmissionError(0, …). This is the ONE test in the
    // slice that injects `fetchImpl` at all.
    const impatient = createHttpTransmitter({
      profile: { ...server.profile, timeoutMs: 1000 },
      canonicalise: syntheticCanonicalise,
      qrPayload: syntheticQrPayload,
      env: ENV,
      fetchImpl: server.abortingFetch(50),
    });
    await expect(
      impatient.submit(impatient.canonicalise(snapshotFixture()), CREDS),
    ).rejects.toThrow(TransientTransmissionError);
  });

  it("keeps the deadline active while reading a stalled response body", async () => {
    server = await startStubServer({});
    const stalled = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"state":');
    });
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
    const address = stalled.address();
    if (typeof address !== "object" || address === null)
      throw new Error("missing loopback address");
    const t = createSyntheticTransmitter({
      profile: { ...server.profile, baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 },
      env: ENV,
    });
    try {
      await expect(t.submit(t.canonicalise(snapshotFixture()), CREDS)).rejects.toThrow(
        TransientTransmissionError,
      );
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        stalled.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("refuses an external identifier containing credential material", async () => {
    server = await startStubServer({ submit: { state: "queued", receiptId: "echo-s3cr3t" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    await expect(t.submit(t.canonicalise(snapshotFixture()), CREDS)).rejects.toThrow(
      "refusing to persist",
    );
  });

  it("raises ERR_EINVOICE_TRANSMITTER_UNAVAILABLE when the secret is unset — before any request", async () => {
    server = await startStubServer({ submit: { state: "queued", receiptId: "R-6" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: {} });
    await expect(t.submit(t.canonicalise(snapshotFixture()), CREDS)).rejects.toThrow(EInvoiceError);
    expect(server.calls).toHaveLength(0);
  });

  it("raises when submit responds with no externalId at a submitted status — the log must be addressable", async () => {
    server = await startStubServer({ submit: { state: "queued" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    await expect(t.submit(t.canonicalise(snapshotFixture()), CREDS)).rejects.toThrow(
      /returned no external id/,
    );
  });
});

describe("createHttpTransmitter — poll and cancel", () => {
  it("interpolates and percent-encodes the external id into the path", async () => {
    server = await startStubServer({ poll: { state: "cleared" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const res = await t.poll("R/1", CREDS);
    expect(res.status).toBe("accepted");
    expect(server.calls[0]!.path).toBe("/stub/documents/R%2F1");
    expect(server.calls[0]!.method).toBe("GET");
    expect(server.calls[0]!.body).toBe("");
  });

  it("sends the cancellation body as canonical JSON of { externalId, reason }", async () => {
    server = await startStubServer({ cancel: { state: "withdrawn" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const res = await t.cancel("R-1", "keyed twice", CREDS);
    expect(res.status).toBe("cancelled");
    expect(server.calls[0]!.path).toBe("/stub/documents/R-1/cancel");
    expect(server.calls[0]!.body).toBe('{"externalId":"R-1","reason":"keyed twice"}');
  });
});
