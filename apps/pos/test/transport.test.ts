// apps/pos/test/transport.test.ts
import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalSyncRequest,
  sha256Hex,
  SYNC_SIGNATURE_HEADER,
  SYNC_TERMINAL_ID_HEADER,
  SYNC_TIMESTAMP_HEADER,
  SyncQueuedError,
  type TicketBatch,
} from "@dulja/sync";
import { HttpSyncTransport, TransportOfflineError } from "../src/main/transport";
import type { DeviceIdentity } from "../src/main/device";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const device: DeviceIdentity = {
  terminalId: "019aaadb-0000-7000-8000-000000000001",
  publicKeyDer: publicKey.export({ type: "spki", format: "der" }),
  sign: (m) => edSign(null, Buffer.from(m), privateKey),
};
const emptyBatch: TicketBatch = {
  terminalId: "019aaadb-0000-7000-8000-000000000001",
  batchId: "019aaadb-0000-7000-8000-000000000002",
  tickets: [],
  shifts: [],
  tillEvents: [],
};

describe("HttpSyncTransport — the till's whole network surface", () => {
  it("never signs two requests in one millisecond, so the server's replay guard cannot confuse them", async () => {
    const stamps: string[] = [];
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example/",
      device,
      newIdempotencyKey: () => "idem-ms",
      fetch: async (input, init) => {
        stamps.push(new Request(input as string, init).headers.get(SYNC_TIMESTAMP_HEADER)!);
        return new Response(JSON.stringify({ changes: [], next_cursor: "MQ", has_more: false }), {
          status: 200,
        });
      },
    });
    vi.useFakeTimers({ now: new Date("2026-10-22T08:00:00.000Z"), toFake: ["Date"] });
    try {
      await Promise.all([t.pullCatalogue("MQ", 10), t.pullCatalogue("Mg", 10)]);
    } finally {
      vi.useRealTimers();
    }
    expect(stamps).toHaveLength(2);
    expect(new Set(stamps).size).toBe(2);
  });

  it("signs GET /v1/sync/catalogue over the PATHNAME, never the query string", async () => {
    let seen: Request | null = null;
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example/",
      device,
      newIdempotencyKey: () => "idem-1",
      fetch: async (input, init) => {
        seen = new Request(input as string, init);
        return new Response(JSON.stringify({ changes: [], next_cursor: "MQ", has_more: false }), {
          status: 200,
        });
      },
    });
    await t.pullCatalogue("MQ", 1000);
    const url = new URL(seen!.url);
    expect(url.pathname).toBe("/v1/sync/catalogue");
    expect(url.searchParams.get("since")).toBe("MQ");
    expect(url.searchParams.get("limit")).toBe("1000");
    const canonical = canonicalSyncRequest({
      method: "GET",
      path: "/v1/sync/catalogue",
      timestamp: seen!.headers.get(SYNC_TIMESTAMP_HEADER)!,
      body: sha256Hex(""),
    });
    expect(
      edVerify(
        null,
        Buffer.from(canonical, "utf8"),
        createPublicKey({ key: device.publicKeyDer, format: "der", type: "spki" }),
        Buffer.from(seen!.headers.get(SYNC_SIGNATURE_HEADER)!, "base64"),
      ),
    ).toBe(true);
    expect(seen!.headers.get(SYNC_TERMINAL_ID_HEADER)).toBe("019aaadb-0000-7000-8000-000000000001");
  });

  it("sends NO tenant or actor header, ever — identity is the signature (SAH-044, test 11)", async () => {
    let seen: Request | null = null;
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example",
      device,
      newIdempotencyKey: () => "idem-1",
      fetch: async (input, init) => {
        seen = new Request(input as string, init);
        return new Response("{}", { status: 200 });
      },
    });
    await t.pullCatalogue("", 10).catch(() => undefined);
    for (const forbidden of ["X-Tenant-Id", "X-Actor-Id", "Authorization", "Cookie"]) {
      expect(seen!.headers.get(forbidden), forbidden).toBeNull();
    }
  });

  it("POST /v1/sync/tickets signs the EXACT bytes it sends, and carries an Idempotency-Key", async () => {
    let seen: Request | null = null;
    let body = "";
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example",
      device,
      newIdempotencyKey: () => "idem-42",
      fetch: async (input, init) => {
        seen = new Request(input as string, init);
        body = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            batchId: "019aaadb-0000-7000-8000-000000000002",
            results: [],
            shiftResults: [],
            tillEventResults: [],
            catalogueCursor: "MQ",
          }),
          { status: 200 },
        );
      },
    });
    await t.pushTickets(emptyBatch);
    expect(seen!.headers.get("Idempotency-Key")).toBe("idem-42");
    expect(body).toBe(JSON.stringify(emptyBatch));
    const canonical = canonicalSyncRequest({
      method: "POST",
      path: "/v1/sync/tickets",
      timestamp: seen!.headers.get(SYNC_TIMESTAMP_HEADER)!,
      body: sha256Hex(body),
    });
    expect(
      edVerify(
        null,
        Buffer.from(canonical, "utf8"),
        createPublicKey({ key: device.publicKeyDer, format: "der", type: "spki" }),
        Buffer.from(seen!.headers.get(SYNC_SIGNATURE_HEADER)!, "base64"),
      ),
    ).toBe(true);
  });

  it("a 202 rejects with SyncQueuedError so drainOutbox acks nothing (§4.10.4, 6A amendment 12)", async () => {
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example",
      device,
      newIdempotencyKey: () => "k",
      fetch: async () =>
        new Response(
          JSON.stringify({
            batchId: "019aaadb-0000-7000-8000-000000000002",
            jobId: "j-1",
            status: "queued",
          }),
          { status: 202 },
        ),
    });
    await expect(t.pushTickets(emptyBatch)).rejects.toBeInstanceOf(SyncQueuedError);
  });

  it("a network failure is a TransportOfflineError and never a silent empty page", async () => {
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example",
      device,
      newIdempotencyKey: () => "k",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    // The distinction matters: `pullAll` must PROPAGATE so the cursor stays where the applied changes left
    // it. An empty page with has_more:false would be read as "finished", which is exactly what test 20
    // forbids — "Kill the down-sync mid-transfer; resume from the cursor".
    await expect(t.pullCatalogue("", 10)).rejects.toBeInstanceOf(TransportOfflineError);
    await expect(t.pushTickets(emptyBatch)).rejects.toBeInstanceOf(TransportOfflineError);
  });

  it("a problem+json response surfaces its ERR_ code rather than a status number", async () => {
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example",
      device,
      newIdempotencyKey: () => "k",
      fetch: async () =>
        new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Terminal revoked",
            status: 403,
            code: "ERR_TERMINAL_REVOKED",
            detail: "this terminal was revoked",
          }),
          { status: 403, headers: { "content-type": "application/problem+json" } },
        ),
    });
    await expect(t.pullCatalogue("", 10)).rejects.toThrow(/ERR_TERMINAL_REVOKED/);
  });

  it("decodes the catalogue page's revisions as bigint, not number", async () => {
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example",
      device,
      newIdempotencyKey: () => "k",
      fetch: async () =>
        new Response(
          // The wire is JSON; a revision past 2^53 MUST travel as a string or it is already lost before the
          // till sees it. 6A's contracts module serialises it as a string for exactly this reason.
          '{"changes":[{"stream":"item","op":"upsert","id":"019aaadb-0000-7000-8000-000000000003","revision":"9007199254740993","row":{}}],"next_cursor":"MQ","has_more":false}',
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const page = await t.pullCatalogue("", 10);
    expect(page.changes[0]!.revision).toBe(9007199254740993n);
  });
});
