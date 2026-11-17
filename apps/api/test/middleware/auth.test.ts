import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, TEST_ISSUER, type StartedApi } from "../support/app";

const problem = async (res: Response): Promise<Problem> => (await res.json()) as Problem;

describe("identity chain — spec:2004, 2132, §5.0 row 0.6; acceptance test 11", () => {
  let api: StartedApi;
  let a: Seed;
  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
  });
  afterAll(async () => {
    await api.stop();
  });

  it("no Authorization header is ERR_AUTH_TOKEN_INVALID, not a 500", async () => {
    const res = await api.request({ method: "GET", path: "/v1/session" });
    expect(res.status).toBe(401);
    expect((await problem(res)).code).toBe("ERR_AUTH_TOKEN_INVALID");
  });

  it("a token signed by another key, with the wrong issuer, or expired is refused", async () => {
    // `tokenFor` always writes iss: TEST_ISSUER and exp: now + 600, so expiry and issuer are exercised
    // through `signToken`, which signs an arbitrary claim set with the same key and kid. `sub` is the
    // seeded owner's real auth_subject, so a 401 proves jose's exp/iss checks fired rather than a
    // missing membership (which would be 403).
    const now = Math.floor(Date.now() / 1000);
    const sub = `human:${a.tenant}`;
    for (const header of [
      "Bearer not.a.jwt",
      `Bearer ${api.tokenFor(a.human)}x`,
      `Bearer ${api.signToken({ sub, aal: "aal2", iss: TEST_ISSUER, iat: now - 3600, exp: now - 60 })}`,
      `Bearer ${api.signToken({ sub, aal: "aal2", iss: "https://other.invalid/auth/v1", iat: now, exp: now + 600 })}`,
    ]) {
      const res = await api.request({
        method: "GET",
        path: "/v1/session",
        headers: { Authorization: header },
      });
      expect(res.status, header).toBe(401);
      expect((await problem(res)).code, header).toBe("ERR_AUTH_TOKEN_INVALID");
    }
  });

  it("a valid token whose sub has no membership is 403 ERR_AUTH_NO_MEMBERSHIP", async () => {
    const orphan = await uuidv7(api.db.admin);
    const res = await api.request({ method: "GET", path: "/v1/session", as: orphan });
    expect(res.status).toBe(403);
    expect((await problem(res)).code).toBe("ERR_AUTH_NO_MEMBERSHIP");
  });

  it("aal1 reaches GET /v1/session and nothing else (spec:2004)", async () => {
    const ok = await api.request({
      method: "GET",
      path: "/v1/session",
      as: a.human,
      aal: "aal1",
    });
    expect(ok.status).toBe(200);
    const blocked = await api.request({
      method: "GET",
      path: "/v1/companies",
      as: a.human,
      aal: "aal1",
    });
    expect(blocked.status).toBe(401);
    expect((await problem(blocked)).code).toBe("ERR_AUTH_AAL_INSUFFICIENT");
  });

  it("a forged X-Tenant-Id or X-Actor-Id header changes nothing — identity comes from the token (LEGACY-026)", async () => {
    const b = await seedTenant(api.db, "Beta");
    const res = await api.request({
      method: "GET",
      path: "/v1/session",
      as: a.human,
      headers: { "X-Tenant-Id": b.tenant, "X-Actor-Id": b.human },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenantId: a.tenant, principalId: a.human });
  });

  it("/healthz needs no token at all", async () => {
    expect((await api.request({ method: "GET", path: "/healthz" })).status).toBe(200);
  });

  it("binds the resolved tenant and actor onto every line logged for the request (spec:2063)", async () => {
    api.takeLogs();
    expect((await api.request({ method: "GET", path: "/v1/session", as: a.human })).status).toBe(
      200,
    );
    const request = api.takeLogs().find((line) => line.msg === "request");
    expect(request).toMatchObject({ tenant_id: a.tenant, actor_id: a.human, status: 200 });
  });
});
