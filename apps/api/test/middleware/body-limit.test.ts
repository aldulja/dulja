import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createLogger } from "@dulja/contracts";
import { createApp } from "../../src/app";

/**
 * API-11 (ADR 0092): the API bounds request bodies itself, as defence in depth behind the edge's identical table
 * (apps/edge/src/body-limit.ts). The ceiling runs before authentication and idempotency, so an oversized body is
 * refused 413 without a database, a token or a hash — `db` is null here and nothing reaches it.
 */
const MIB = 1024 * 1024;
const app = () =>
  createApp({
    db: null as unknown as Sql,
    jobs: { enqueue: () => Promise.reject(new Error("no job client in this test")) },
    logger: createLogger({ sink: () => undefined }),
    authAdmin: {},
    verifier: () => {
      throw new Error("no verifier in this test");
    },
  } as never);

const stream = (bytes: number) => {
  let left = bytes;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left <= 0) return controller.close();
      const size = Math.min(left, 256 * 1024);
      left -= size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
};

describe("apps/api — request-body ceilings (API-11)", () => {
  it("refuses a declared body over 1 MiB with a 413 problem before authentication", async () => {
    const res = await app().request(
      "/v1/companies/0192f000-0000-7000-8000-000000000001/documents",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(MIB + 1) },
        body: "{}",
      },
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({ code: "ERR_PAYLOAD_TOO_LARGE", status: 413 });
  });

  it("refuses the public enrolment's oversized chunked body without touching the database", async () => {
    const res = await app().request("/v1/sync/enrol", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream(8 * MIB + 1),
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "ERR_PAYLOAD_TOO_LARGE" });
  });

  it("lets a body inside the ceiling through to authentication", async () => {
    const res = await app().request(
      "/v1/companies/0192f000-0000-7000-8000-000000000001/documents",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(MIB - 64) }),
      },
    );
    expect(res.status).toBe(401);
  });

  it("gives the attachment upload and the bank-statement import their own ceilings", async () => {
    const declared = async (path: string, bytes: number) =>
      (
        await app().request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": String(bytes) },
          body: "{}",
        })
      ).status;
    const company = "/v1/companies/0192f000-0000-7000-8000-000000000001";
    expect(await declared(`${company}/attachments`, 26 * MIB)).toBe(401);
    expect(await declared(`${company}/attachments`, 27 * MIB + 1)).toBe(413);
    expect(await declared(`${company}/bank-statements`, 16 * MIB)).toBe(401);
    expect(await declared(`${company}/bank-statements`, 16 * MIB + 1)).toBe(413);
  });
});
