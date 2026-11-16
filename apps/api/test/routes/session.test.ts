import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../support/app";

describe("GET /v1/session — the aal1 exemption the owner's first login needs (spec:2317)", () => {
  let api: StartedApi;
  let a: Seed;
  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
  });
  afterAll(async () => api.stop());

  it("returns the caller's principal, tenant, kind and aal, and no permission is required", async () => {
    const response = await api.request({
      method: "GET",
      path: "/v1/session",
      as: a.human,
      aal: "aal1",
    });
    expect(response.status).toBe(200);
    // Exact equality, not a subset: the session body is the whole of what a first login may learn, so an
    // extra field leaking out of app.principal has to fail here. a.human holds no role_assignment at all,
    // which is what "no permission is required" means — the route carries no requirePermission gate.
    expect(await response.json()).toEqual({
      principalId: a.human,
      tenantId: a.tenant,
      principalKind: "human",
      aal: "aal1",
      displayName: "Alpha owner",
      email: null,
    });
  });

  it("reports aal2 once the caller has enrolled", async () => {
    const response = await api.request({ method: "GET", path: "/v1/session", as: a.human });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      principalId: a.human,
      tenantId: a.tenant,
      principalKind: "human",
      aal: "aal2",
      displayName: "Alpha owner",
      email: null,
    });
  });
});
