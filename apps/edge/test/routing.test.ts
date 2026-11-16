import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { SHARED_ORIGIN_KEY } from "../src/rate-limit";
import { handleFetch, handleScheduled, type RouterDeps } from "../src/router";

/** btoa, not Buffer — see the note in jwt-precheck.test.ts. */
const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ISSUER = "https://proj.supabase.co/auth/v1";
const good = `Bearer ${b64({ alg: "RS256" })}.${b64({ iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 60 })}.sig`;
/** Passes the pre-check and is signed by nobody: `sig` is a literal. Any `sub` a caller likes. */
const forged = (sub: string) =>
  `Bearer ${b64({ alg: "RS256" })}.${b64({ iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 60, sub })}.sig`;
// IPv6 documentation addresses: SAH-082 forbids IPv4 literals in source (see rate-limit.test.ts).
// Two origins in DIFFERENT /64s — an IPv6 client is keyed on its prefix, so two addresses inside one /64
// would (rightly) share a bucket and prove nothing about origin separation.
const ORIGIN_A = "2001:db8:1::a";
const ORIGIN_B = "2001:db8:2::b";
const KEY_A = "2001:db8:1:0::/64";
const KEY_B = "2001:db8:2:0::/64";

/**
 * The router takes its two container calls as functions, so this suite never imports `@cloudflare/containers`
 * (whose `Container` extends `DurableObject` and resolves `cloudflare:workers`, which Node does not have).
 * `src/index.ts` is the only module that binds these to `getContainer(...)`, and nothing tests it.
 */
function harness(options: { readonly overLimit?: boolean } = {}) {
  const forward = vi.fn(
    async (_request: Request) => new Response("from the container", { status: 200 }),
  );
  const ping = vi.fn(async () => new Response("ok", { status: 200 }));
  const deps: RouterDeps = { forward, ping };
  // Spies, not bare stubs: the limiter's *key* is the thing under test in the Finding 6 cases below,
  // and `feedGet` proves a refused request never reaches R2.
  const limit = vi.fn(async (_options: { key: string }) => ({ success: !options.overLimit }));
  const feedGet = vi.fn(async (_key: string) => null);
  const env = {
    API: {},
    WORKER: {},
    UPDATE_FEED: { get: feedGet },
    ATTACHMENTS: {},
    RATE_LIMIT: { limit },
    APP_ENV: "dev",
    SUPABASE_JWT_ISSUER: ISSUER,
  } as unknown as Env;
  const keys = () => limit.mock.calls.map(([call]) => call.key);
  return { env, deps, forward, ping, limit, feedGet, keys };
}

describe("apps/edge/src/router — routing (spec §3.2.1, §5.2)", () => {
  it("forwards /v1/* to the api container and echoes X-Request-Id", async () => {
    const { env, deps, forward } = harness();
    const res = await handleFetch(
      new Request("https://api.example/v1/companies", { headers: { Authorization: good } }),
      env,
      deps,
    );
    expect(res.status).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("RateLimit-Limit")).toBe("600");
  });

  it("mints a traceparent when the caller sent none, so the container and Postgres share one trace (spec:2245)", async () => {
    const { env, deps, forward } = harness();
    await handleFetch(
      new Request("https://api.example/v1/companies", { headers: { Authorization: good } }),
      env,
      deps,
    );
    const forwarded = forward.mock.calls[0]![0];
    expect(forwarded.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(forwarded.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("continues a well-formed caller traceparent and replaces a malformed or all-zero one", async () => {
    const { env, deps, forward } = harness();
    const valid = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    await handleFetch(
      new Request("https://api.example/v1/companies", {
        headers: { Authorization: good, traceparent: valid },
      }),
      env,
      deps,
    );
    expect(forward.mock.calls[0]![0].headers.get("traceparent")).toBe(valid);
    for (const offered of [
      "evil",
      "00-zz-zz-01",
      "00-00000000000000000000000000000000-b7ad6b7169203331-01",
    ]) {
      const { env: e2, deps: d2, forward: f2 } = harness();
      await handleFetch(
        new Request("https://api.example/v1/companies", {
          headers: { Authorization: good, traceparent: offered },
        }),
        e2,
        d2,
      );
      const sent = f2.mock.calls[0]![0].headers.get("traceparent")!;
      expect(sent).not.toBe(offered);
      expect(sent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    }
  });

  it("refuses /v1/* with no token at the edge — 401, and the container is never called", async () => {
    const { env, deps, forward } = harness();
    const res = await handleFetch(new Request("https://api.example/v1/companies"), env, deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    // `res.json<T>()`: workers-types declares `Body.json<T = unknown>()`; `instance` is the request path (§4.2.4).
    const body = await res.json<{ code: string; instance: string }>();
    expect(body.code).toBe("ERR_AUTH_TOKEN_INVALID");
    expect(body.instance).toBe("/v1/companies");
    expect(forward).not.toHaveBeenCalled();
  });

  it("strips client-supplied identity headers before forwarding — the edge never asserts identity (SAH-026)", async () => {
    const { env, deps, forward } = harness();
    await handleFetch(
      new Request("https://api.example/v1/companies", {
        headers: { Authorization: good, "X-Tenant-Id": "0192-forged", "X-Actor-Id": "0192-forged" },
      }),
      env,
      deps,
    );
    const forwarded = forward.mock.calls[0]![0];
    expect(forwarded.headers.get("X-Tenant-Id")).toBeNull();
    expect(forwarded.headers.get("X-Actor-Id")).toBeNull();
    expect(forwarded.headers.get("Authorization")).toBe(good);
  });

  it("/healthz reaches the api container unauthenticated (§5.0 row 0.5)", async () => {
    const { env, deps, forward } = harness();
    expect((await handleFetch(new Request("https://api.example/healthz"), env, deps)).status).toBe(
      200,
    );
    expect(forward).toHaveBeenCalledOnce();
  });

  it("/updates/* is served from R2 and never reaches a container — the feed is a PATH, not a host", async () => {
    const { env, deps, forward } = harness();
    expect(
      (await handleFetch(new Request("https://api.example/updates/latest.yml"), env, deps)).status,
    ).toBe(404);
    expect(forward).not.toHaveBeenCalled();
  });

  it("anything else is 404 — the Worker is not a website", async () => {
    const { env, deps } = harness();
    expect((await handleFetch(new Request("https://api.example/"), env, deps)).status).toBe(404);
  });

  it("the scheduled handler pings the worker container, never the api one (spec:1157)", async () => {
    const { env, deps, forward, ping } = harness();
    await handleScheduled(env, deps);
    expect(ping).toHaveBeenCalledOnce();
    expect(forward).not.toHaveBeenCalled();
  });
});

const api = (headers: Record<string, string>) =>
  new Request("https://api.example/v1/companies", { headers });

describe("apps/edge/src/router — the limiter key is never attacker-controlled", () => {
  it("two forged tokens differing only in `sub` share ONE bucket", async () => {
    const { env, deps, keys } = harness();
    await handleFetch(
      api({ "CF-Connecting-IP": ORIGIN_A, Authorization: forged("019250a0-one") }),
      env,
      deps,
    );
    await handleFetch(
      api({ "CF-Connecting-IP": ORIGIN_A, Authorization: forged("019250a0-two") }),
      env,
      deps,
    );
    // The old key was `subjectHint(...)`, so this pair opened two buckets and 600/60s bought 1200.
    expect(keys()).toEqual([KEY_A, KEY_A]);
  });

  it("claiming a victim's `sub` from another origin spends the claimant's budget, not the victim's", async () => {
    const { env, deps, keys } = harness();
    const victim = "019250a0-victim";
    await handleFetch(
      api({ "CF-Connecting-IP": ORIGIN_A, Authorization: forged(victim) }),
      env,
      deps,
    );
    await handleFetch(
      api({ "CF-Connecting-IP": ORIGIN_B, Authorization: forged(victim) }),
      env,
      deps,
    );
    expect(keys()).toEqual([KEY_A, KEY_B]);
    expect(keys().some((key) => key.includes(victim))).toBe(false);
  });

  it("no CF-Connecting-IP falls back to one SHARED bucket — closed, not unlimited", async () => {
    const { env, deps, keys } = harness();
    await handleFetch(api({ Authorization: forged("019250a0-one") }), env, deps);
    await handleFetch(api({ Authorization: forged("019250a0-two") }), env, deps);
    expect(keys()).toEqual([SHARED_ORIGIN_KEY, SHARED_ORIGIN_KEY]);
  });

  it("an unauthenticated /updates/* read passes through the limiter on the same origin key", async () => {
    const { env, deps, keys } = harness();
    const res = await handleFetch(
      new Request("https://api.example/updates/latest.yml", {
        headers: { "CF-Connecting-IP": ORIGIN_A },
      }),
      env,
      deps,
    );
    expect(keys()).toEqual([KEY_A]);
    expect(res.status).toBe(404);
  });

  it("the two branches that answer without a container still report the budget they spent (spec:2204)", async () => {
    // Hoisting the limiter made `/updates/*` and the 404 fallthrough consume a bucket they used to skip.
    // A path that spends budget and reports none leaves a caller — the desktop updater above all — blind
    // until it is refused, so both carry the same RateLimit-* values the forwarded and 401 paths do.
    const { env, deps } = harness();
    const feed = await handleFetch(
      new Request("https://api.example/updates/latest.yml", {
        headers: { "CF-Connecting-IP": ORIGIN_A },
      }),
      env,
      deps,
    );
    expect(feed.headers.get("RateLimit-Limit")).toBe("600");
    expect(feed.headers.get("RateLimit-Reset")).toBe("60");
    const missing = await handleFetch(
      new Request("https://api.example/", { headers: { "CF-Connecting-IP": ORIGIN_A } }),
      env,
      deps,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("RateLimit-Limit")).toBe("600");
  });

  it("a refused /updates/* request is 429 and never reads R2 — no egress amplification", async () => {
    const { env, deps, feedGet } = harness({ overLimit: true });
    const res = await handleFetch(
      new Request("https://api.example/updates/latest.yml", {
        headers: { "CF-Connecting-IP": ORIGIN_A },
      }),
      env,
      deps,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect((await res.json<{ code: string }>()).code).toBe("ERR_RATE_LIMITED");
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(feedGet).not.toHaveBeenCalled();
  });

  it("a refused /v1/* request is 429 before the pre-check, and the container is never called", async () => {
    // Honest about its own weight: this one passes against the old router too (`good` carries no `sub`, so the
    // old key fell through to "anon" and refused just the same). It is a structural guard on the order of the
    // two gates, not evidence about the key — the five cases above it are what discriminate.
    const { env, deps, forward } = harness({ overLimit: true });
    const res = await handleFetch(api({ Authorization: good }), env, deps);
    expect(res.status).toBe(429);
    expect(forward).not.toHaveBeenCalled();
  });
});

/** A terminal JWT as the API mints it (ADR 0055): HS256, issuer `urn:dulja:terminal` — never a Supabase issuer. */
const terminalToken = `Bearer ${b64({ alg: "HS256" })}.${b64({
  iss: "urn:dulja:terminal",
  sub: "terminal:01925000-0000-7000-8000-000000000001",
  exp: Math.floor(Date.now() / 1000) + 900,
})}.sig`;
const signedHeaders = {
  "X-Terminal-Id": "01925000-0000-7000-8000-000000000001",
  "X-Terminal-Timestamp": new Date().toISOString(),
  "X-Terminal-Signature": "c2lnbmF0dXJl",
};

describe("apps/edge/src/router — the till's /v1/sync/* surface (contracts §4.10.3; PR 12 review)", () => {
  // Every case here was a 401 ERR_AUTH_TOKEN_INVALID before the fix: the Supabase pre-check ran on all of
  // `/v1/*`, so a deployed till could neither enrol nor sync through the Worker. The API's `terminalAuth` is the
  // control for these calls; what the edge owes them is the rate limit and the same header hygiene.
  it("the public enrolment reaches the api container with no token at all", async () => {
    const { env, deps, forward } = harness();
    // No body: Node's Request needs `duplex` to forward a stream body, which the Workers runtime does not.
    const res = await handleFetch(
      new Request("https://api.example/v1/sync/enrol", { method: "POST" }),
      env,
      deps,
    );
    expect(res.status).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
    expect(forward.mock.calls[0]![0].method).toBe("POST");
    expect(res.headers.get("RateLimit-Limit")).toBe("600");
  });

  it("a signed sync call is forwarded with its X-Terminal-* headers intact and forged identity stripped", async () => {
    const { env, deps, forward } = harness();
    const res = await handleFetch(
      new Request("https://api.example/v1/sync/catalogue?since=0", {
        headers: { ...signedHeaders, "X-Tenant-Id": "0192-forged" },
      }),
      env,
      deps,
    );
    expect(res.status).toBe(200);
    const forwarded = forward.mock.calls[0]![0];
    for (const [name, value] of Object.entries(signedHeaders))
      expect(forwarded.headers.get(name)).toBe(value);
    expect(forwarded.headers.get("X-Tenant-Id")).toBeNull();
    expect(new URL(forwarded.url).pathname).toBe("/v1/sync/catalogue");
  });

  it("a terminal JWT, whose issuer is not Supabase's, is forwarded rather than refused for its issuer", async () => {
    const { env, deps, forward } = harness();
    const res = await handleFetch(
      new Request("https://api.example/v1/sync/tickets", {
        method: "POST",
        headers: { Authorization: terminalToken },
      }),
      env,
      deps,
    );
    expect(res.status).toBe(200);
    expect(forward.mock.calls[0]![0].headers.get("Authorization")).toBe(terminalToken);
  });

  it("the same terminal JWT anywhere else under /v1/* is still refused at the edge", async () => {
    const { env, deps, forward } = harness();
    for (const path of ["/v1/companies", "/v1/sync", "/v1/syncx/enrol", "/v1/sync/../companies"]) {
      const res = await handleFetch(
        new Request(`https://api.example${path}`, { headers: { Authorization: terminalToken } }),
        env,
        deps,
      );
      expect(res.status, path).toBe(401);
      expect((await res.json<{ code: string }>()).code).toBe("ERR_AUTH_TOKEN_INVALID");
    }
    expect(forward).not.toHaveBeenCalled();
  });

  it("the till's surface is still rate-limited at the edge, on the network-origin key", async () => {
    const { env, deps, forward, keys } = harness({ overLimit: true });
    const res = await handleFetch(
      new Request("https://api.example/v1/sync/enrol", {
        method: "POST",
        headers: { "CF-Connecting-IP": ORIGIN_A },
      }),
      env,
      deps,
    );
    expect(res.status).toBe(429);
    expect(keys()).toEqual([KEY_A]);
    expect(forward).not.toHaveBeenCalled();
  });
});
