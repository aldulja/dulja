import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseProfile, type EInvoiceProfile } from "@dulja/domain";
import { createRequestAuthorization } from "../../src/einvoice/authorization";
import { createMyInvoisTransport } from "../../src/einvoice/myinvois";
import { TransientTransmissionError } from "../../src/einvoice/http-transmitter";
import { registerTransmitter, resetTransmitters } from "../../src/einvoice/registry";
import {
  pollTransmission,
  recordPending,
  submitTransmission,
} from "../../src/einvoice/transmission";
import { verifyProfile } from "../../src/einvoice/verify";
import { syntheticCanonicalise } from "../../src/einvoice/synthetic";
import { withTenant } from "../../src/with-tenant";
import { seedTenant, type Seed } from "../fixtures";
import { startDb, uuidv7, type Db } from "../harness";
import { enableEinvoice, postedStubDocument, snapshotFixture } from "../support/einvoice-stub";

const CREDS = { clientId: "client-a", secretRef: "EINVOICE_CLIENT_SECRET" };
const ENV = { EINVOICE_CLIENT_SECRET: "secret-for-local-server" };
const DRAFT = JSON.parse(
  readFileSync(
    new URL("../../../../docs/owner/od-15/myinvois-sandbox-profile.draft.json", import.meta.url),
    "utf8",
  ),
) as EInvoiceProfile;
const SUB = "SUBMISSION01234567890123456";
const DOC = "DOCUMENT000123456789012345";
const LONG = "LONG012345678901234567890123456789";
// Transport fixture only: not a complete statutory UBL document or an authority-valid invoice.
const bytes = '{"Invoice":[{"ID":[{"_":"INV-1"}]}]}';
const encoder = () => ({ format: "JSON" as const, bytes });
const accepted = (code: string) => ({
  submissionUID: SUB,
  acceptedDocuments: [{ invoiceCodeNumber: code, uuid: DOC }],
  rejectedDocuments: [],
});
const valid = {
  submissionUid: SUB,
  overallStatus: "valid",
  documentSummary: [{ uuid: DOC, status: "Valid", longId: LONG }],
};
interface Call {
  url: string;
  method: string;
  authorization: string;
  body: string;
}
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});
async function server(
  reply: (call: Call, index: number) => { status?: number; body: unknown; delay?: number },
) {
  const calls: Call[] = [];
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const call = {
        url: req.url!,
        method: req.method!,
        authorization: String(req.headers.authorization ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      };
      calls.push(call);
      const answer = reply(call, calls.length);
      const send = () => {
        res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      };
      if (answer.delay) setTimeout(send, answer.delay);
      else send();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  stops.push(
    () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  );
  const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  return {
    calls,
    baseUrl,
    profile: parseProfile({
      ...DRAFT,
      baseUrl,
      auth: { ...DRAFT.auth, tokenUrl: `${baseUrl}/connect/token` },
    }),
  };
}
const token = (access_token = "local-access-token", expires_in = 3600) => ({
  access_token,
  token_type: "Bearer",
  expires_in,
});
const transport = (profile: EInvoiceProfile, baseUrl: string) =>
  createMyInvoisTransport({
    profile,
    portalBaseUrl: baseUrl,
    canonicalise: syntheticCanonicalise,
    encodeDocument: encoder,
    env: ENV,
  });

describe("public MyInvois protocol — local transport only", () => {
  it("validates the profile draft without activating it", () => {
    expect(parseProfile(DRAFT).auth.kind).toBe("oauth2_client_credentials");
  });
  it("single-flights token acquisition and reuses tokens", async () => {
    const s = await server(() => ({ body: token(), delay: 20 }));
    const auth = createRequestAuthorization({ profile: s.profile, env: ENV });
    const [a, b] = await Promise.all([auth.get(CREDS), auth.get(CREDS)]);
    await auth.get(CREDS);
    expect(a.headerValue).toBe(b.headerValue);
    expect(s.calls).toHaveLength(1);
    expect(new URLSearchParams(s.calls[0]!.body).get("client_secret")).toBe(
      ENV.EINVOICE_CLIENT_SECRET,
    );
    expect(new URLSearchParams(s.calls[0]!.body).get("grant_type")).toBe("client_credentials");
    expect(s.calls[0]!.authorization).toBe("");
  });
  it("refreshes from remote expiry, isolates clients, and observes secret rotation", async () => {
    const s = await server((_, i) => ({ body: token(`token-${i}`, 10) }));
    let time = 0;
    const env = { ...ENV };
    const auth = createRequestAuthorization({ profile: s.profile, env, now: () => time });
    const first = await auth.get(CREDS);
    time = 8999;
    expect((await auth.get(CREDS)).headerValue).toBe(first.headerValue);
    time = 9000;
    expect((await auth.get(CREDS)).headerValue).not.toBe(first.headerValue);
    await auth.get({ ...CREDS, clientId: "other" });
    env.EINVOICE_CLIENT_SECRET = "rotated-secret";
    await auth.get(CREDS);
    expect(s.calls).toHaveLength(4);
  });
  it("does not cancel the shared login when one caller times out", async () => {
    const s = await server(() => ({ body: token(), delay: 40 }));
    const auth = createRequestAuthorization({ profile: s.profile, env: ENV });
    const expired = auth.get(CREDS, AbortSignal.timeout(10));
    const live = auth.get(CREDS);
    await expect(expired).rejects.toThrow();
    await expect(live).resolves.toHaveProperty("headerValue", "Bearer local-access-token");
    expect(s.calls).toHaveLength(1);
  });
  it("does not cache failed login or disclose its response body", async () => {
    const s = await server((_, i) =>
      i === 1
        ? { status: 401, body: { error_description: ENV.EINVOICE_CLIENT_SECRET } }
        : { body: token() },
    );
    const auth = createRequestAuthorization({ profile: s.profile, env: ENV });
    await expect(auth.get(CREDS)).rejects.toThrow("HTTP 401");
    await expect(auth.get(CREDS)).resolves.toHaveProperty("headerValue");
    expect(s.calls).toHaveLength(2);
  });
  it.each([
    {},
    { access_token: "", token_type: "Bearer", expires_in: 3600 },
    { access_token: "x", token_type: "Basic", expires_in: 3600 },
    token("x", 0),
  ])("refuses invalid login metadata: %j", async (body) => {
    const s = await server(() => ({ body }));
    await expect(
      createRequestAuthorization({ profile: s.profile, env: ENV }).get(CREDS),
    ).rejects.toThrow("invalid token metadata");
  });
  it.each([429, 503])("retries token HTTP %i failures", async (status) => {
    const s = await server(() => ({ status, body: {} }));
    await expect(
      createRequestAuthorization({ profile: s.profile, env: ENV }).get(CREDS),
    ).rejects.toBeInstanceOf(TransientTransmissionError);
  });
  it("hashes exact document bytes and polls/cancels from a persisted reference after restart", async () => {
    const s = await server((call) => {
      if (call.url === "/connect/token") return { body: token() };
      if (call.method === "POST")
        return { status: 202, body: accepted(JSON.parse(call.body).documents[0].codeNumber) };
      if (call.method === "PUT") return { body: { uuid: DOC, status: "Cancelled" } };
      return { body: valid };
    });
    const t = transport(s.profile, s.baseUrl);
    const doc = t.canonicalise(snapshotFixture());
    const receipt = await t.submit(doc, CREDS);
    expect(receipt.status).toBe("submitted");
    const sent = JSON.parse(s.calls[1]!.body).documents[0];
    expect(Buffer.from(sent.document, "base64").toString("utf8")).toBe(bytes);
    expect(sent.documentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(doc.hash).toBe(sent.documentHash);
    const restarted = transport(s.profile, s.baseUrl);
    const polled = await restarted.poll(receipt.externalId, CREDS);
    expect(polled.status).toBe("accepted");
    expect(s.calls.at(-1)!.url).toBe(`/api/v1.0/documentsubmissions/${SUB}`);
    expect(restarted.qrPayload(doc, { externalId: receipt.externalId, raw: polled.raw })).toBe(
      `${s.baseUrl}/${DOC}/share/${LONG}`,
    );
    expect((await restarted.cancel(receipt.externalId, "Wrong buyer details", CREDS)).status).toBe(
      "cancelled",
    );
    expect(s.calls.at(-1)!.url).toBe(`/api/v1.0/documents/state/${DOC}/state`);
    expect(JSON.parse(s.calls.at(-1)!.body)).toEqual({
      status: "cancelled",
      reason: "Wrong buyer details",
    });
  });
  it("correlates invoice code and UUID rather than using the first returned row", async () => {
    const s = await server((call) =>
      call.url === "/connect/token"
        ? { body: token() }
        : call.method === "POST"
          ? {
              body: {
                ...accepted(JSON.parse(call.body).documents[0].codeNumber),
                acceptedDocuments: [
                  { invoiceCodeNumber: "different", uuid: "OTHER" },
                  ...accepted(JSON.parse(call.body).documents[0].codeNumber).acceptedDocuments,
                ],
              },
            }
          : {
              body: {
                ...valid,
                documentSummary: [{ uuid: "OTHER", status: "Invalid" }, ...valid.documentSummary],
              },
            },
    );
    const t = transport(s.profile, s.baseUrl);
    const ref = (await t.submit(t.canonicalise(snapshotFixture()), CREDS)).externalId;
    expect((await t.poll(ref, CREDS)).status).toBe("accepted");
  });
  it("refreshes a rejected token once and redacts secrets and both token values", async () => {
    let logins = 0;
    let sends = 0;
    const s = await server((call) =>
      call.url === "/connect/token"
        ? { body: token(`access-${++logins}`) }
        : ++sends === 1
          ? { status: 401, body: {} }
          : {
              body: {
                ...accepted(JSON.parse(call.body).documents[0].codeNumber),
                message: `access-1 access-2 ${ENV.EINVOICE_CLIENT_SECRET}`,
              },
            },
    );
    const t = transport(s.profile, s.baseUrl);
    const result = await t.submit(t.canonicalise(snapshotFixture()), CREDS);
    expect(result.status).toBe("submitted");
    expect(logins).toBe(2);
    expect(sends).toBe(2);
    for (const secret of ["access-1", "access-2", ENV.EINVOICE_CLIENT_SECRET])
      expect(JSON.stringify(result.raw)).not.toContain(secret);
  });
  it("never accepts a success-shaped body on HTTP 401", async () => {
    const s = await server((call) =>
      call.url === "/connect/token"
        ? { body: token() }
        : { status: 401, body: accepted(JSON.parse(call.body).documents[0].codeNumber) },
    );
    const t = transport(s.profile, s.baseUrl);
    expect((await t.submit(t.canonicalise(snapshotFixture()), CREDS)).status).toBe("error");
  });
  it("refuses credential-bearing IDs even when base64 would hide them", async () => {
    const s = await server((call) =>
      call.url === "/connect/token"
        ? { body: token("TOKENLEAK") }
        : {
            body: {
              ...accepted(JSON.parse(call.body).documents[0].codeNumber),
              submissionUID: "TOKENLEAK",
            },
          },
    );
    const t = transport(s.profile, s.baseUrl);
    await expect(t.submit(t.canonicalise(snapshotFixture()), CREDS)).rejects.toThrow(
      "credential material",
    );
  });
  it("refuses QR generation without a matching valid receipt and long ID", async () => {
    const s = await server((call) =>
      call.url === "/connect/token"
        ? { body: token() }
        : { body: accepted(JSON.parse(call.body).documents[0].codeNumber) },
    );
    const t = transport(s.profile, s.baseUrl);
    const doc = t.canonicalise(snapshotFixture());
    const r = await t.submit(doc, CREDS);
    expect(() =>
      t.qrPayload(doc, { externalId: r.externalId, raw: { uuid: DOC, status: "Valid" } }),
    ).toThrow("invalid identifier");
    expect(() =>
      t.qrPayload(doc, {
        externalId: r.externalId,
        raw: { uuid: "OTHER", status: "Valid", longId: LONG },
      }),
    ).toThrow("matching document");
  });
  it("refuses oversized documents before requesting a token", async () => {
    const s = await server(() => ({ body: token() }));
    const t = createMyInvoisTransport({
      profile: s.profile,
      portalBaseUrl: s.baseUrl,
      canonicalise: syntheticCanonicalise,
      encodeDocument: () => ({ format: "JSON", bytes: "x".repeat(300001) }),
      env: ENV,
    });
    expect(() => t.canonicalise(snapshotFixture())).toThrow("document limit");
    expect(s.calls).toHaveLength(0);
  });
  it("rejects malformed references before network access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const t = createMyInvoisTransport({
      profile: DRAFT,
      portalBaseUrl: "https://preprod.myinvois.hasil.gov.my",
      canonicalise: syntheticCanonicalise,
      encodeDocument: encoder,
      env: ENV,
      fetchImpl,
    });
    await expect(t.poll("invalid", CREDS)).rejects.toThrow("malformed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("verification reports authentication refusal, not a false green", async () => {
    const s = await server((call) =>
      call.url === "/connect/token" ? { body: token() } : { status: 403, body: {} },
    );
    const r = await verifyProfile("myinvois", {
      profile: s.profile,
      env: ENV,
      clientId: CREDS.clientId,
    });
    expect(r.credentials).toContain("403");
    expect(r.reachable).toBe("ok");
  });
  it("verifies OAuth through the same four checks and requires a client ID", async () => {
    const s = await server((call) =>
      call.url === "/connect/token" ? { body: token() } : { status: 404, body: {} },
    );
    expect(
      await verifyProfile("myinvois", { profile: s.profile, env: ENV, clientId: CREDS.clientId }),
    ).toEqual({ profile: "ok", schema: "ok", credentials: "present", reachable: "ok" });
    expect(
      (await verifyProfile("myinvois", { profile: s.profile, env: ENV })).credentials,
    ).toContain("client identifier");
  });
  it("validates injected profiles", async () => {
    expect(
      (await verifyProfile("synthetic", { profile: { ...DRAFT, timeoutMs: 0 }, env: ENV })).schema,
    ).not.toBe("ok");
  });
});

// The codec answers a receipt it cannot match with `error`; the transmission log decides what that
// means for the row. Driven through `transmission.ts` with this transport registered, because the
// codec alone cannot show the one fact that matters: the authority still holds the submission.
describe("a MyInvois receipt mismatch through the transmission log (ADR 0053, 2026-10-06)", () => {
  let db: Db;
  let seed: Seed;
  let ctx: { tenantId: string; actorId: string; requestId: string };

  beforeAll(async () => {
    db = await startDb();
    seed = await seedTenant(db, "myinvois-log");
    ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: await uuidv7(db.admin) };
    await enableEinvoice(db, seed, { transmitter: "myinvois" });
  }, 180_000);
  afterEach(() => {
    resetTransmitters();
  });
  afterAll(async () => {
    await db.stop();
  });

  it("keeps the row submitted, refuses a resubmission, and reconciles on the next poll", async () => {
    let polls = 0;
    const s = await server((call) => {
      if (call.url === "/connect/token") return { body: token() };
      if (call.method === "POST")
        return { status: 202, body: accepted(JSON.parse(call.body).documents[0].codeNumber) };
      // First poll: a 200 whose receipt names a different submission (myinvois.ts's codec outcome
      // "submission receipt does not match recorded submission"). Second: the real receipt.
      return ++polls === 1
        ? { body: { ...valid, submissionUid: "OTHERSUBMISSION000000000000" } }
        : { body: valid };
    });
    registerTransmitter("myinvois", transport(s.profile, s.baseUrl));
    const documentId = await postedStubDocument(db, seed);
    const id = await withTenant(db.rw, ctx, (tx) =>
      recordPending(tx, { documentId, companyId: seed.company, transmitter: "myinvois" }),
    );

    expect((await submitTransmission(db.rw, ctx, { transmissionId: id })).status).toBe("submitted");
    const mismatched = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(mismatched.status).toBe("submitted");
    expect(mismatched.lastError).toContain("does not match recorded submission");
    expect(mismatched.acceptedAt).toBeNull();
    expect(mismatched.qrPayload).toBeNull();
    expect(mismatched.claimedAt).toBeNull();

    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toMatchObject({
      code: "ERR_EINVOICE_STATUS_ILLEGAL",
    });
    const reconciled = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(reconciled.status).toBe("accepted");
    expect(reconciled.qrPayload).toBe(`${s.baseUrl}/${DOC}/share/${LONG}`);
    // One document submission reached the authority, however many polls and refusals there were.
    expect(s.calls.filter((c) => c.method === "POST" && c.url !== "/connect/token")).toHaveLength(
      1,
    );
  });

  it("a 202 whose acceptedDocuments the codec cannot correlate is `error` WITH the warning and the submissionUID, and the job does not resend it", async () => {
    // The authority took the submission in (202, a submissionUID) but names no row whose
    // invoiceCodeNumber is this document's, so the log has no document uuid to poll. It records
    // `error` — nothing to reconcile — but, unlike a 4xx, warns that the authority may hold the
    // document and keeps the submissionUID in front of the operator, who confirms before resubmitting.
    const s = await server((call) => {
      if (call.url === "/connect/token") return { body: token() };
      return {
        status: 202,
        body: {
          submissionUID: SUB,
          acceptedDocuments: [{ invoiceCodeNumber: "normalised-form", uuid: DOC }],
          rejectedDocuments: [],
        },
      };
    });
    registerTransmitter("myinvois", transport(s.profile, s.baseUrl));
    const documentId = await postedStubDocument(db, seed);
    const id = await withTenant(db.rw, ctx, (tx) =>
      recordPending(tx, { documentId, companyId: seed.company, transmitter: "myinvois" }),
    );

    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(row.status).toBe("error");
    expect(row.externalId).toBeNull();
    expect(row.lastError).toContain("http 202");
    expect(row.lastError).toContain("no unique matching document");
    expect(row.lastError).toContain("may already hold this document");
    expect(row.lastError).toContain(SUB);
    expect(row.claimedAt).toBeNull();
    expect(s.calls.filter((c) => c.method === "POST" && c.url !== "/connect/token")).toHaveLength(
      1,
    );
  });
});
