import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalSyncRequest,
  serializeSyncBody,
  sha256Hex,
  signSyncHeaders,
  SYNC_SIGNATURE_HEADER,
  SYNC_TERMINAL_ID_HEADER,
  SYNC_TIMESTAMP_HEADER,
} from "../src/index";

describe("shared request signing — exact UTF-8 wire bytes", () => {
  it("defaults the signing instant when no clock is supplied", () => {
    const before = Date.now();
    const headers = signSyncHeaders(
      { method: "GET", path: "/", terminalId: "t" },
      () => new Uint8Array(),
    );
    expect(Date.parse(headers[SYNC_TIMESTAMP_HEADER]!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(headers[SYNC_TIMESTAMP_HEADER]!)).toBeLessThanOrEqual(Date.now());
  });
  it("encodes arbitrary signer output with standard base64 padding", () => {
    for (let length = 0; length <= 130; length++) {
      const signature = Uint8Array.from({ length }, (_, i) => (i * 71) & 255);
      const headers = signSyncHeaders(
        { method: "GET", path: "/", terminalId: "t" },
        () => signature,
      );
      expect(headers[SYNC_SIGNATURE_HEADER], `signature length ${length}`).toBe(
        Buffer.from(signature).toString("base64"),
      );
    }
  });
  const corpus = [
    "",
    "abc",
    "مرحبا بالعالم",
    "💰🧾",
    "\ud800",
    "\udc00",
    ...[55, 56, 63, 64, 65, 127, 128, 129, 10000].map((length) => "a".repeat(length)),
    "مرحبا💰".repeat(300),
  ];
  it.each(corpus)("matches SHA-256's independent implementation for corpus case %#", (payload) => {
    expect(sha256Hex(payload)).toBe(createHash("sha256").update(payload, "utf8").digest("hex"));
  });
  it("has no Node, Buffer or WebCrypto dependency in the shared implementation", () => {
    const source = readFileSync(new URL("../src/signing.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:|\bBuffer\b|\bcrypto\b|\bsubtle\b/);
  });
  it("keeps the raw pathname and uppercases only the method", () => {
    expect(
      canonicalSyncRequest({
        method: "post",
        path: "/raw/%2F/مرحبا",
        timestamp: "at",
        body: "hash",
      }),
    ).toBe("POST\n/raw/%2F/مرحبا\nat\nhash");
  });
  it("serializes bigint revisions as exact decimal strings at any depth", () => {
    expect(serializeSyncBody({ revision: 9007199254740993n, nested: [9223372036854775807n] })).toBe(
      '{"revision":"9007199254740993","nested":["9223372036854775807"]}',
    );
    expect(serializeSyncBody(undefined)).toBe("");
  });
  it("calls the injected signer once with the canonical UTF-8 message", () => {
    const messages: Uint8Array[] = [];
    const at = new Date("2026-10-09T00:00:00.000Z");
    const body = { revision: 9007199254740993n, name: "مرحبا💰" };
    const headers = signSyncHeaders(
      { method: "post", path: "/v1/sync/tickets", body, at, terminalId: "terminal" },
      (message) => {
        messages.push(message);
        return new Uint8Array([0, 255, 128, 1, 2]);
      },
    );
    expect(messages).toHaveLength(1);
    expect(new TextDecoder().decode(messages[0])).toBe(
      `POST\n/v1/sync/tickets\n${at.toISOString()}\n${createHash("sha256").update(serializeSyncBody(body)).digest("hex")}`,
    );
    expect(headers).toEqual({
      [SYNC_TERMINAL_ID_HEADER]: "terminal",
      [SYNC_TIMESTAMP_HEADER]: at.toISOString(),
      [SYNC_SIGNATURE_HEADER]: "AP+AAQI=",
    });
  });
  it("uses a pre-serialized body verbatim and never re-runs mutable toJSON", () => {
    let calls = 0;
    const bodyText = serializeSyncBody({
      toJSON: () => ({ calls: ++calls, revision: 9007199254740993n }),
    });
    let signed = "";
    signSyncHeaders(
      { method: "POST", path: "/v1/sync/tickets", bodyText, at: new Date(0), terminalId: "t" },
      (message) => {
        signed = new TextDecoder().decode(message);
        return new Uint8Array();
      },
    );
    expect(calls).toBe(1);
    expect(signed.endsWith(createHash("sha256").update(bodyText).digest("hex"))).toBe(true);
  });
  it("refuses two competing body representations before calling the signer", () => {
    let calls = 0;
    expect(() =>
      signSyncHeaders(
        { method: "POST", path: "/", body: {}, bodyText: "{}", at: new Date(), terminalId: "t" },
        () => {
          calls++;
          return new Uint8Array();
        },
      ),
    ).toThrow(/body/);
    expect(calls).toBe(0);
  });
  it("hashes the empty body for an absent payload", () => {
    let signed = "";
    signSyncHeaders({ method: "GET", path: "/", at: new Date(0), terminalId: "t" }, (message) => {
      signed = new TextDecoder().decode(message);
      return new Uint8Array();
    });
    expect(
      signed.endsWith("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    ).toBe(true);
  });
});
