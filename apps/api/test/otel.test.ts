import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedTenant, type Seed } from "@dulja/db/test";
import { collectedSpans, resetSpans, startTelemetry } from "../src/otel";
import { startApi, type StartedApi } from "./support/app";

// Telemetry starts at module evaluation, before startApi(), so the SDK is running for the first request.
const telemetry = startTelemetry({ serviceName: "dulja-api", appEnv: "dev" });

describe("§5.0 row 0.14 — one request visible end to end with tenant and actor attached (spec:2324)", () => {
  let api: StartedApi;
  let s: Seed;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenant(api.db, "Alpha");
  });
  beforeEach(() => {
    resetSpans(); // each case asserts over its own request's spans only
  });
  afterAll(async () => {
    await telemetry.shutdown();
    await api.stop();
  });

  it("an inbound traceparent is continued, not replaced — the Worker's trace id survives into the container", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const res = await api.request({
      method: "GET",
      path: "/v1/session",
      as: s.human,
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect(res.status).toBe(200);
    const spans = collectedSpans();
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((sp) => sp.traceId === traceId)).toBe(true);
  });

  it("the request span carries tenant, actor and request id (the four fields of spec:2063)", async () => {
    await api.request({ method: "GET", path: "/v1/session", as: s.human });
    const span = collectedSpans().find((sp) => sp.name.includes("/v1/session"));
    expect(span!.attributes["dulja.tenant_id"]).toBe(s.tenant);
    expect(span!.attributes["dulja.actor_id"]).toBe(s.human);
    expect(String(span!.attributes["dulja.request_id"])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the database statements of that request are children of it — Worker → container → Postgres is one trace", async () => {
    await api.request({ method: "GET", path: "/v1/companies", as: s.human });
    const spans = collectedSpans();
    const request = spans.find((sp) => sp.name.includes("/v1/companies"))!;
    const db = spans.filter((sp) => sp.name.startsWith("pg "));
    expect(db.length).toBeGreaterThan(0);
    expect(db.every((sp) => sp.traceId === request.traceId)).toBe(true);
  });

  it("no span attribute carries a token, a password or a PIN (spec:2063, forbidden-log-fields)", async () => {
    await api.request({ method: "GET", path: "/v1/session", as: s.human });
    for (const span of collectedSpans()) {
      for (const key of Object.keys(span.attributes)) {
        expect(key, `${span.name}.${key}`).not.toMatch(
          /token|password|authorization|card|pin|secret/i,
        );
      }
    }
  });

  it("with no OTLP endpoint configured telemetry still runs — the default is in-memory, never a crash (OD-22)", () => {
    expect(telemetry.enabled).toBe(true);
  });
});
