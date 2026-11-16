import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleFetch, type RouterDeps } from "../src/router";

/** btoa, not Buffer — see the note in jwt-precheck.test.ts. */
const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ISSUER = "https://proj.supabase.co/auth/v1";
const good = `Bearer ${b64({ alg: "RS256" })}.${b64({ iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 60 })}.sig`;
/** `backoffice.exe`'s renderer origin: `APP_ORIGIN` in apps/desktop/src/window-options.ts (asserted below). */
const BACKOFFICE = "dulja://app";
const MIB = 1024 * 1024;

function harness() {
  const forward = vi.fn(async (request: Request) => {
    // Drain the body the way the container would, so the edge's streaming limit has something to trip.
    if (request.body !== null) await new Response(request.body).arrayBuffer();
    return new Response("from the container", { status: 200 });
  });
  const deps: RouterDeps = { forward, ping: vi.fn(async () => new Response("ok")) };
  const limit = vi.fn(async (_options: { key: string }) => ({ success: true }));
  const env = {
    API: {},
    WORKER: {},
    UPDATE_FEED: { get: vi.fn(async () => null) },
    ATTACHMENTS: {},
    RATE_LIMIT: { limit },
    APP_ENV: "production",
    SUPABASE_JWT_ISSUER: ISSUER,
  } as unknown as Env;
  return { env, deps, forward, limit };
}

const preflight = (origin: string, path = "/v1/staff-context") =>
  new Request(`https://api.example${path}`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type, idempotency-key",
    },
  });

describe("apps/edge/src/cors — the back office's cross-origin calls (API-01, ADR 0092)", () => {
  it("the allow-listed origin is backoffice.exe's own renderer origin", () => {
    const options = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../desktop/src/window-options.ts"),
      "utf8",
    );
    expect(options).toContain('APP_SCHEME = "dulja"');
    expect(options).toContain("APP_ORIGIN = `${APP_SCHEME}://app`");
  });

  it("answers backoffice.exe's preflight before the JWT pre-check, and never reaches a container", async () => {
    const { env, deps, forward } = harness();
    const res = await handleFetch(preflight(BACKOFFICE), env, deps);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(BACKOFFICE);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, PUT, PATCH, DELETE");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
      "authorization, content-type, idempotency-key, traceparent",
    );
    expect(res.headers.get("Access-Control-Max-Age")).toBe("600");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(res.headers.get("Vary")).toContain("Origin");
    expect(forward).not.toHaveBeenCalled();
  });

  it("a preflight from any other origin gets no CORS grant — never `*`, never an echo", async () => {
    const { env, deps, forward } = harness();
    for (const origin of [
      "https://evil.example",
      "null",
      "dulja://evil",
      "http://localhost:5173",
    ]) {
      const res = await handleFetch(preflight(origin), env, deps);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.status).toBe(401);
    }
    expect(forward).not.toHaveBeenCalled();
  });

  it("an actual response to the allowed origin carries the grant and exposes X-Request-Id", async () => {
    const { env, deps } = harness();
    const res = await handleFetch(
      new Request("https://api.example/v1/companies", {
        headers: { Authorization: good, Origin: BACKOFFICE },
      }),
      env,
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(BACKOFFICE);
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe("x-request-id");
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("the edge's own refusals carry the grant too, so the screen can read the problem body", async () => {
    const { env, deps } = harness();
    const res = await handleFetch(
      new Request("https://api.example/v1/companies", { headers: { Origin: BACKOFFICE } }),
      env,
      deps,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(BACKOFFICE);
  });

  it("an actual response to any other origin carries no grant", async () => {
    const { env, deps } = harness();
    const res = await handleFetch(
      new Request("https://api.example/v1/companies", {
        headers: { Authorization: good, Origin: "https://evil.example" },
      }),
      env,
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("apps/edge/src/body-limit — request bodies are bounded at the edge (API-11, ADR 0092)", () => {
  const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
    new Request(`https://api.example${path}`, {
      method: "POST",
      headers: { Authorization: good, "Content-Type": "application/json", ...headers },
      body,
      // Node's undici needs this for a stream body; a Worker ignores it.
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);

  it("refuses a declared Content-Length over 1 MiB with a 413 problem, before any container", async () => {
    const { env, deps, forward } = harness();
    const res = await handleFetch(
      post("/v1/companies/c/documents", "x", { "Content-Length": String(MIB + 1) }),
      env,
      deps,
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    const body = (await res.json()) as { code: string; status: number };
    expect(body).toMatchObject({ code: "ERR_PAYLOAD_TOO_LARGE", status: 413 });
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated public enrolment body over the limit too", async () => {
    const { env, deps, forward } = harness();
    const res = await handleFetch(
      new Request("https://api.example/v1/sync/enrol", {
        method: "POST",
        headers: { "Content-Length": String(100 * MIB) },
        body: "x",
      }),
      env,
      deps,
    );
    expect(res.status).toBe(413);
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses a chunked body (no Content-Length) once it streams past the limit", async () => {
    const { env, deps } = harness();
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await handleFetch(post("/v1/companies/c/documents", stream), env, deps);
    expect(res.status).toBe(413);
  });

  it("forwards a body at the limit", async () => {
    const { env, deps, forward } = harness();
    const res = await handleFetch(post("/v1/companies/c/documents", "x".repeat(MIB)), env, deps);
    expect(res.status).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
  });

  it("gives the attachment upload room for MAX_ATTACHMENT_BYTES (25 MiB) plus multipart framing", async () => {
    const { env, deps, forward } = harness();
    const ok = await handleFetch(
      post("/v1/companies/c/attachments", "x", { "Content-Length": String(26 * MIB) }),
      env,
      deps,
    );
    expect(ok.status).not.toBe(413);
    expect(forward).toHaveBeenCalledOnce();
    const over = await handleFetch(
      post("/v1/companies/c/attachments", "x", { "Content-Length": String(27 * MIB + 1) }),
      env,
      deps,
    );
    expect(over.status).toBe(413);
  });

  it("gives the bank-statement import room for its 4,000,000-character CSV", async () => {
    const { env, deps } = harness();
    const ok = await handleFetch(
      post("/v1/companies/c/bank-statements", "x", { "Content-Length": String(16 * MIB) }),
      env,
      deps,
    );
    expect(ok.status).not.toBe(413);
    const over = await handleFetch(
      post("/v1/companies/c/bank-statements", "x", { "Content-Length": String(16 * MIB + 1) }),
      env,
      deps,
    );
    expect(over.status).toBe(413);
  });

  it("gives the till's sync batches 8 MiB", async () => {
    const { env, deps } = harness();
    const ok = await handleFetch(
      post("/v1/sync/push", "x", { "Content-Length": String(8 * MIB) }),
      env,
      deps,
    );
    expect(ok.status).not.toBe(413);
    const over = await handleFetch(
      post("/v1/sync/push", "x", { "Content-Length": String(8 * MIB + 1) }),
      env,
      deps,
    );
    expect(over.status).toBe(413);
  });
});
