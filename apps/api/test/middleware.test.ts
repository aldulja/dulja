import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Problem } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { seedTenant, uuidv7, type Seed } from "@dulja/db/test";
import {
  isReplayByRerun,
  isReplayByRerunPath,
  isSelfTransacted,
  isSelfTransactedPath,
  isTransactionAtFirstWritePath,
  REPLAY_BY_RERUN,
  SELF_TRANSACTED,
  TRANSACTION_AT_FIRST_WRITE,
} from "../src/middleware/idempotency";
import { assertRouteGates, requirePermission } from "../src/middleware/require-permission";
import { startApi, type StartedApi } from "./support/app";
import type { AppEnv } from "../src/context";

describe("idempotency and permission middleware", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;
  /** Both set by the atomicity case below, before it fires the request that parks. */
  let parkedArrived: (() => void) | null = null;
  let parkedRelease: Promise<void> | null = null;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    b = await seedTenant(api.db, "Beta");
    api.app.post("/v1/idempotency-probe", async (context) => {
      await context.var.withTenant(
        (tx) =>
          tx`insert into app.role (tenant_id, code, name_en) values (${a.tenant}, ${crypto.randomUUID().slice(0, 8)}, 'Probe')`,
      );
      return context.json({ ok: true }, 201);
    });
    api.app.post("/v1/idempotency-boom", () => {
      throw new Error("handler exploded");
    });
    // Parks between its write and the middleware's record of the response — the only point from which
    // one commit can be told from two.
    api.app.post("/v1/idempotency-parked", async (context) => {
      await context.var.withTenant(
        (tx) =>
          tx`insert into app.role (tenant_id, code, name_en) values (${a.tenant}, ${crypto.randomUUID().slice(0, 8)}, 'Parked')`,
      );
      parkedArrived?.();
      await parkedRelease;
      return context.json({ ok: true }, 201);
    });
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${roleId}, ${a.tenant}, 'company_admin', 'Company admin')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${roleId}, 'admin.company.manage')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${a.human}, ${roleId}, ${a.company})`;
    });
  });
  afterAll(async () => api.stop());

  const roleCount = async (): Promise<number> => {
    const [row] = await api.db.admin<
      { count: number }[]
    >`select count(*)::int as count from app.role where tenant_id = ${a.tenant}`;
    return row!.count;
  };

  const responseCode = async (key: string): Promise<number | null | undefined> => {
    const [row] = await api.db.admin<{ response_code: number | null }[]>`
      select response_code from app.idempotency_key
       where tenant_id = ${a.tenant} and principal_id = ${a.human} and key = ${key}`;
    return row?.response_code;
  };

  it("requires a key on unsafe methods", async () => {
    const response = await api.request({
      method: "POST",
      path: "/v1/companies",
      as: a.human,
      idempotencyKey: null,
      body: { code: "NO_KEY", name: "No key", baseCurrency: "MYR" },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("replays the stored response and refuses reuse with a different request", async () => {
    const key = "company-create-1";
    const input = { code: "IDEMP", name: "Idempotent", baseCurrency: "MYR" };
    const first = await api.request({
      method: "POST",
      path: "/v1/companies",
      as: a.human,
      idempotencyKey: key,
      body: input,
    });
    const replay = await api.request({
      method: "POST",
      path: "/v1/companies",
      as: a.human,
      idempotencyKey: key,
      body: { ...input },
    });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    const reused = await api.request({
      method: "POST",
      path: "/v1/companies",
      as: a.human,
      idempotencyKey: key,
      body: { ...input, name: "Changed" },
    });
    expect(reused.status).toBe(409);
    expect(((await reused.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_REUSED");
  });

  it("answers 400, not 500, to a multipart body that cannot be parsed", async () => {
    const res = await api.app.request("/v1/idempotency-probe", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.tokenFor(a.human)}`,
        "Idempotency-Key": crypto.randomUUID(),
        "content-type": "multipart/form-data; boundary=----missing",
      },
      body: "this is not a multipart body",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("does not require an idempotency key for a safe method", async () => {
    const response = await api.request({ method: "GET", path: "/v1/session", as: a.human });
    expect(response.status).toBe(200);
  });

  it("runs an identical request once and replays its stored response", async () => {
    const before = await roleCount();
    const key = "probe-replay";
    const first = await api.request({
      method: "POST",
      path: "/v1/idempotency-probe",
      as: a.human,
      body: { value: 1 },
      idempotencyKey: key,
    });
    const replay = await api.request({
      method: "POST",
      path: "/v1/idempotency-probe",
      as: a.human,
      body: { value: 1 },
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await roleCount()).toBe(before + 1);
  });

  it("returns in-flight with Retry-After for a live reservation with the same hash", async () => {
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
      await tx`insert into app.idempotency_key (tenant_id, principal_id, key, request_hash)
               values (${a.tenant}, ${a.human}, 'probe-in-flight',
                       sha256(convert_to('POST' || chr(10) || '/v1/idempotency-probe' || chr(10) || '{}', 'UTF8')))`;
    });
    const response = await api.request({
      method: "POST",
      path: "/v1/idempotency-probe",
      as: a.human,
      body: {},
      idempotencyKey: "probe-in-flight",
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(((await response.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_IN_FLIGHT");
  });

  it("reports reuse before in-flight when a live reservation has a different hash", async () => {
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
      await tx`insert into app.idempotency_key (tenant_id, principal_id, key, request_hash)
               values (${a.tenant}, ${a.human}, 'probe-in-flight-mismatch', sha256('different'::bytea))`;
    });
    const response = await api.request({
      method: "POST",
      path: "/v1/idempotency-probe",
      as: a.human,
      body: {},
      idempotencyKey: "probe-in-flight-mismatch",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_REUSED");
  });

  it("reclaims a stale reservation instead of blocking the key for its full retention period", async () => {
    // Seeded with the hash this very request computes: the reclaim now insists on a match, so a row
    // holding any other hash would prove nothing about staleness.
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
      await tx`insert into app.idempotency_key (tenant_id, principal_id, key, request_hash, created_at)
               values (${a.tenant}, ${a.human}, 'probe-stale',
                       sha256(convert_to('POST' || chr(10) || '/v1/idempotency-probe' || chr(10) || '{}', 'UTF8')),
                       now() - interval '10 minutes')`;
    });
    const before = await roleCount();
    const response = await api.request({
      method: "POST",
      path: "/v1/idempotency-probe",
      as: a.human,
      body: {},
      idempotencyKey: "probe-stale",
    });
    expect(response.status).toBe(201);
    expect(await roleCount()).toBe(before + 1);
  });

  it("will not reclaim a stale reservation for a different body, and leaves its hash alone", async () => {
    // The reclaim used to write `request_hash = excluded.request_hash` without comparing it. A slow
    // in-flight R1 (body B1) reclaimed after RECLAIM_AFTER_SECONDS by R2 (body B2) left the row holding
    // B2's hash; R1 then recorded its own response into that row, so a later replay of B2 was served
    // R1's answer. A different body against a reclaimable key is reuse, like any other mismatch.
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
      await tx`insert into app.idempotency_key (tenant_id, principal_id, key, request_hash, created_at)
               values (${a.tenant}, ${a.human}, 'probe-stale-mismatch', sha256('another body'::bytea),
                       now() - interval '10 minutes')`;
    });
    const before = await roleCount();
    const response = await api.request({
      method: "POST",
      path: "/v1/idempotency-probe",
      as: a.human,
      body: {},
      idempotencyKey: "probe-stale-mismatch",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_REUSED");
    expect(await roleCount()).toBe(before);
    const [row] = await api.db.admin<{ untouched: boolean }[]>`
      select request_hash = sha256('another body'::bytea) as untouched
        from app.idempotency_key
       where tenant_id = ${a.tenant} and principal_id = ${a.human} and key = 'probe-stale-mismatch'`;
    expect(row!.untouched).toBe(true);
  });

  it("commits the handler's write and the record of its response together, or neither", async () => {
    const key = "probe-atomic";
    const before = await roleCount();
    const arrived = new Promise<void>((resolve) => {
      parkedArrived = resolve;
    });
    let release!: () => void;
    parkedRelease = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = api.request({
      method: "POST",
      path: "/v1/idempotency-parked",
      as: a.human,
      body: {},
      idempotencyKey: key,
    });
    await arrived;
    // The handler's insert has returned. When the response was recorded in a SECOND transaction, that
    // insert was already committed here while the key still read `response_code null` — the window in
    // which a crash left the mutation done and the key reclaimable, so the next attempt did it again.
    // One transaction now holds both, so from outside it neither has happened.
    expect(await roleCount()).toBe(before);
    expect(await responseCode(key)).toBeNull();

    release();
    const response = await inFlight;
    expect(response.status).toBe(201);
    expect(await roleCount()).toBe(before + 1);
    expect(await responseCode(key)).toBe(201);
    parkedArrived = null;
    parkedRelease = null;
  });

  it("never reclaims a reservation whose request is still running, however old it is (CON-01)", async () => {
    // A request that outlives RECLAIM_AFTER_SECONDS — a slow render, a queue for a pooled connection —
    // used to have its key reclaimed by a same-key retry, which then ran the handler beside it; both
    // committed. The request now holds its key's advisory lock for its whole transaction, and a reclaim
    // must take that lock first.
    const key = "probe-reclaim-live";
    const before = await roleCount();
    const arrived = new Promise<void>((resolve) => {
      parkedArrived = resolve;
    });
    let release!: () => void;
    parkedRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = api.request({
      method: "POST",
      path: "/v1/idempotency-parked",
      as: a.human,
      body: {},
      idempotencyKey: key,
    });
    await arrived;
    // Ages the reservation past the window. `created_at` is also the request's fencing token, which time
    // passing never moves, so it is put back before the first request records its answer.
    const [held] = await api.db.admin<{ at: string }[]>`
      select created_at::text as at from app.idempotency_key
       where tenant_id = ${a.tenant} and principal_id = ${a.human} and key = ${key}`;
    await api.db.admin`update app.idempotency_key set created_at = now() - interval '121 seconds'
      where tenant_id = ${a.tenant} and principal_id = ${a.human} and key = ${key}`;
    const retried = api.request({
      method: "POST",
      path: "/v1/idempotency-parked",
      as: a.human,
      body: {},
      idempotencyKey: key,
    });
    // A retry the middleware let through parks in the handler too, so it is released with the first.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await api.db.admin`update app.idempotency_key set created_at = ${held!.at}::text::timestamptz
      where tenant_id = ${a.tenant} and principal_id = ${a.human} and key = ${key}`;
    release();
    const [response, retry] = await Promise.all([first, retried]);
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_IN_FLIGHT");
    expect(response.status).toBe(201);
    expect(await roleCount()).toBe(before + 1);
    expect(await responseCode(key)).toBe(201);
    parkedArrived = null;
    parkedRelease = null;
  });

  it("rolls back a request whose reservation was taken over before it took the lock (CON-01)", async () => {
    // The window the lock cannot cover: the reservation commits, then the request waits for a pooled
    // connection; a retry arriving after RECLAIM_AFTER_SECONDS finds the lock free and takes the key over.
    // The takeover is simulated by moving `created_at`, as a reclaim does. The superseded request's
    // record no longer matches its token, so it rolls back and its write never lands.
    const key = "probe-reclaim-fenced";
    const before = await roleCount();
    const arrived = new Promise<void>((resolve) => {
      parkedArrived = resolve;
    });
    let release!: () => void;
    parkedRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = api.request({
      method: "POST",
      path: "/v1/idempotency-parked",
      as: a.human,
      body: {},
      idempotencyKey: key,
    });
    await arrived;
    await api.db.admin`update app.idempotency_key set created_at = now() + interval '1 second'
      where tenant_id = ${a.tenant} and principal_id = ${a.human} and key = ${key}`;
    release();
    const response = await first;
    expect(response.status).toBe(409);
    expect(((await response.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_IN_FLIGHT");
    expect(await roleCount()).toBe(before);
    expect(await responseCode(key)).toBeNull();
    parkedArrived = null;
    parkedRelease = null;
  });

  it("stores a handler failure so a retry replays it", async () => {
    const key = "probe-failure";
    const first = await api.request({
      method: "POST",
      path: "/v1/idempotency-boom",
      as: a.human,
      body: {},
      idempotencyKey: key,
    });
    const replay = await api.request({
      method: "POST",
      path: "/v1/idempotency-boom",
      as: a.human,
      body: {},
      idempotencyKey: key,
    });
    expect(first.status).toBe(500);
    expect(replay.status).toBe(500);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(((await replay.json()) as Problem).code).toBe("ERR_INTERNAL");
  });

  it("refuses a principal without the registered permission", async () => {
    const response = await api.request({ method: "GET", path: "/v1/companies", as: b.human });
    expect(response.status).toBe(403);
    expect(((await response.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("rejects an unsafe route gated by a read-only permission at boot", () => {
    const app = new OpenAPIHono<AppEnv>();
    app.post(
      "/v1/bad-gate",
      requirePermission(PERMISSION["admin.audit_log.read"], { company: "any" }),
      (context) => context.json({}),
    );
    expect(() => assertRouteGates(app)).toThrow(/ERR_ROUTE_GATE_READONLY.*admin\.audit_log\.read/s);
  });
});

// `path` is what Hono's request carries as `c.req.path` — the path it routed on. These paths hold no
// percent-encoding, so the routed path and the URL's spelling agree; `routedMatch` below asks a real
// Hono dispatch for the encoded spellings, where they do not.
const rerunAt = (method: string, path: string) =>
  isReplayByRerun({ req: { method, url: `https://api.test${path}`, path } } as never);

describe("REPLAY_BY_RERUN — the write-free routes a replayed key re-runs (contracts §4.2.9, 2C)", () => {
  it("matches the print path and nothing adjacent to it", () => {
    expect(rerunAt("POST", "/v1/companies/c1/documents/d1/print")).toBe(true);
    expect(rerunAt("POST", "/v1/companies/c1/documents/d1/transitions")).toBe(false);
    expect(rerunAt("POST", "/v1/companies/c1/documents/d1/print/extra")).toBe(false);
    expect(rerunAt("POST", "/v1/companies/c1/documents/print")).toBe(false);
    expect(rerunAt("GET", "/v1/companies/c1/documents/d1/print")).toBe(false);
  });

  it("holds exactly one member at 2C", () => {
    expect(REPLAY_BY_RERUN).toHaveLength(1);
    expect(REPLAY_BY_RERUN[0]!.method).toBe("POST");
  });
});

const selfTransactedAt = (method: string, path: string) =>
  isSelfTransacted({ req: { method, url: `https://api.test${path}`, path } } as never);

describe("SELF_TRANSACTED — writes in its service's own transactions, records its real answer after (ADR 0053, 2026-10-06)", () => {
  it("matches the e-invoice cancel and poll paths and nothing adjacent to them", () => {
    const base = "/v1/companies/c1/einvoice-transmissions/t1";
    expect(selfTransactedAt("POST", `${base}/poll`)).toBe(true);
    expect(selfTransactedAt("POST", `${base}/cancel`)).toBe(true);
    // submit enqueues on the request's transaction through c.var.withTenant: not a member.
    expect(selfTransactedAt("POST", `${base}/submit`)).toBe(false);
    expect(selfTransactedAt("POST", `${base}/poll/extra`)).toBe(false);
    expect(selfTransactedAt("GET", `${base}/poll`)).toBe(false);
    expect(selfTransactedAt("POST", "/v1/companies/c1/einvoice-transmissions/poll")).toBe(false);
  });

  it("is a list of its own: its routes write, so none of them joins REPLAY_BY_RERUN", () => {
    expect(SELF_TRANSACTED).toHaveLength(1);
    expect(rerunAt("POST", "/v1/companies/c1/einvoice-transmissions/t1/poll")).toBe(false);
    expect(rerunAt("POST", "/v1/companies/c1/einvoice-transmissions/t1/cancel")).toBe(false);
  });
});

/**
 * What both matchers answer for a request Hono itself dispatched, and the path it routed on. Hono
 * routes on the percent-DECODED path (`decodeURI`, so an unreserved `%70` is `p` and `%2D` is `-`,
 * while a reserved `%2F` stays three characters), so `…/%70oll` reaches the poll handler. A matcher
 * that read the URL's own spelling instead let such a request run inside the request-spanning
 * transaction — the pool deadlock SELF_TRANSACTED exists to prevent (PR 11 review).
 */
async function routedMatch(
  method: "GET" | "POST",
  path: string,
): Promise<{ selfTransacted: boolean; rerun: boolean; routed: string }> {
  const probe = new Hono<AppEnv>();
  let seen: { selfTransacted: boolean; rerun: boolean; routed: string } | undefined;
  probe.all("*", (c) => {
    seen = { selfTransacted: isSelfTransacted(c), rerun: isReplayByRerun(c), routed: c.req.path };
    return c.body(null, 204);
  });
  expect((await probe.request(path, { method })).status).toBe(204);
  return seen!;
}

describe("TRANSACTION_AT_FIRST_WRITE — the request transaction opens at the handler's first write (CON-02)", () => {
  it("matches the payslip generation path and nothing adjacent to it", () => {
    const company = "00000000-0000-7000-8000-000000000001";
    const run = "00000000-0000-7000-8000-000000000002";
    expect(TRANSACTION_AT_FIRST_WRITE).toHaveLength(1);
    expect(
      isTransactionAtFirstWritePath(
        "POST",
        `/v1/companies/${company}/payroll-runs/${run}/payslips`,
      ),
    ).toBe(true);
    expect(
      isTransactionAtFirstWritePath("GET", `/v1/companies/${company}/payroll-runs/${run}/payslips`),
    ).toBe(false);
    expect(
      isTransactionAtFirstWritePath("POST", `/v1/companies/${company}/payroll-runs/${run}/approve`),
    ).toBe(false);
    expect(
      isTransactionAtFirstWritePath(
        "POST",
        `/v1/companies/${company}/payroll-runs/${run}/payslips/x`,
      ),
    ).toBe(false);
  });

  it("is a list of its own: its route is neither write-free nor self-transacted", () => {
    const sample = "/v1/companies/c/payroll-runs/r/payslips";
    expect(isTransactionAtFirstWritePath("POST", sample)).toBe(true);
    expect(isReplayByRerunPath("POST", sample)).toBe(false);
    expect(isSelfTransactedPath("POST", sample)).toBe(false);
  });
});

describe("both lists match the path Hono routed on, never the URL's percent-encoded spelling (PR 11 review)", () => {
  const base = "/v1/companies/c1/einvoice-transmissions/t1";

  it.each([
    { spelling: `${base}/%70oll`, routed: `${base}/poll` },
    { spelling: `${base}/po%6Cl`, routed: `${base}/poll` },
    { spelling: `${base}/cance%6C`, routed: `${base}/cancel` },
    {
      spelling: "/v1/companies/c1/einvoice%2Dtransmissions/t1/poll",
      routed: `${base}/poll`,
    },
  ])(
    "an encoded spelling of a SELF_TRANSACTED route is SELF_TRANSACTED: $spelling",
    async ({ spelling, routed }) => {
      const seen = await routedMatch("POST", spelling);
      expect(seen.routed).toBe(routed); // the path the poll or cancel handler is reached on
      expect(seen.selfTransacted).toBe(true);
      expect(seen.rerun).toBe(false);
    },
  );

  it("an encoded spelling of the REPLAY_BY_RERUN print route is REPLAY_BY_RERUN", async () => {
    const seen = await routedMatch("POST", "/v1/companies/c1/documents/d1/%70rint");
    expect(seen.routed).toBe("/v1/companies/c1/documents/d1/print");
    expect(seen.rerun).toBe(true);
    expect(seen.selfTransacted).toBe(false);
  });

  it("a reserved separator stays encoded, as Hono's router leaves it: `t1%2Fpoll` is one segment", async () => {
    const seen = await routedMatch("POST", "/v1/companies/c1/einvoice-transmissions/t1%2Fpoll");
    expect(seen.routed).toBe("/v1/companies/c1/einvoice-transmissions/t1%2Fpoll");
    expect(seen.selfTransacted).toBe(false);
  });

  it("the method still decides: an encoded GET is neither", async () => {
    const seen = await routedMatch("GET", `${base}/%70oll`);
    expect(seen.selfTransacted).toBe(false);
    expect(seen.rerun).toBe(false);
  });
});
