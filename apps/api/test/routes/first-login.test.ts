import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@dulja/db";
// The seed reaches the test tier through the "./seed" subpath export, never through @dulja/db's main entry: that
// entry is imported by apps/api's production code, and re-exporting the seed there would put
// @supabase/supabase-js and the service-role admin client on the request-serving path (sah-039).
import { parseSeedArgs, seed, StubSeedAuthAdmin } from "@dulja/db/seed";
import { startApi, type StartedApi } from "../support/app";

describe("§5.0 row 0.7b — the owner logs in, enrols MFA at aal1, and sees the company (spec:2004, 2317)", () => {
  let api: StartedApi;
  let ownerPrincipalId = "";
  let companyId = "";

  beforeAll(async () => {
    api = await startApi();
    const migrator = createDb(api.db.url("app_migrator"));
    const cfg = parseSeedArgs(
      ["--tenant", randomUUID(), "--owner-email", "owner@example.my"],
      {} as NodeJS.ProcessEnv,
    );
    const r = await seed(migrator, cfg, new StubSeedAuthAdmin());
    ownerPrincipalId = r.ownerPrincipalId;
    companyId = r.companyId;
    await migrator.end();
  });
  afterAll(async () => {
    await api.stop();
  });

  it("at aal1 the owner reaches GET /v1/session and nothing else", async () => {
    const session = await api.request({
      method: "GET",
      path: "/v1/session",
      as: ownerPrincipalId,
      aal: "aal1",
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ principalId: ownerPrincipalId, aal: "aal1" });
    const blocked = await api.request({
      method: "GET",
      path: "/v1/companies",
      as: ownerPrincipalId,
      aal: "aal1",
    });
    expect(blocked.status).toBe(401);
    expect(((await blocked.json()) as { code: string }).code).toBe("ERR_AUTH_AAL_INSUFFICIENT");
  });

  it("after enrolling, the owner sees one fully configured company", async () => {
    const res = await api.request({ method: "GET", path: "/v1/companies", as: ownerPrincipalId });
    expect(res.status).toBe(200);
    // 0B's ListEnvelope is `{ items, next_cursor }` (§4.2.8) — not `{ data }`.
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: companyId,
      code: "HQ",
      baseCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
    });
  });

  it("and the audit log the owner may read is not empty — every seed write was audited (spec:2286)", async () => {
    const res = await api.request({
      method: "GET",
      path: "/v1/admin/audit-log?limit=5",
      as: ownerPrincipalId,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });
});
