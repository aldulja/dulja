import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCodes, seedTenantV2, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { requireFilingGenerate } from "../../src/hr/authorise";
import { problemOf } from "../../../../tests/support/api";
import { startApi, type StartedApi } from "../support/app";

// 8D T1 — `requireFilingGenerate` through the REAL middleware chain (auth → tenant context → withTenant →
// requirePermission resolving `path:companyId`). The probe route is mounted onto the started app the way
// `apps/api/test/middleware/require-permission.test.ts` mounts its probes: after `createApp`, so `assertRouteGates`
// has already judged the shipped routes and this one is not among them.

let api: StartedApi;
let s: Seed;
let other: Seed;
let holder: string; // holds hr.filing.generate at s.company
let bare: string; // a member of s.tenant with a live role that holds nothing
let elsewhere: string; // holds hr.filing.generate at other.company only

const path = (companyId: string) => `/v1/companies/${companyId}/filing-gate-probe`;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "filing-gate");
  other = await seedTenantV2(api.db, "filing-gate-other");
  holder = s.human;
  await grantCodes(api.db, s, { codes: ["hr.filing.generate"] });
  elsewhere = other.human;
  await grantCodes(api.db, other, { codes: ["hr.filing.generate"] });

  bare = await uuidv7(api.db.admin);
  await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
    await tx`insert into app.principal (id, kind, auth_subject, display_name)
             values (${bare}, 'human', ${`human:filing-bare:${bare}`}, 'Bare')`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${bare})`;
  });
  await grantCodes(api.db, s, { codes: [], principalId: bare });

  api.app.post("/v1/companies/:companyId/filing-gate-probe", requireFilingGenerate(), (c) =>
    c.json({ ok: true }, 200),
  );
  await api.loadPrincipals();
}, 180_000);
afterAll(async () => {
  await api.stop();
});

describe("requireFilingGenerate — §3.6.3's PERMISSION[…] reference and the gate it evaluates", () => {
  it("allows a principal holding hr.filing.generate at the path company", async () => {
    const res = await api.request({ method: "POST", path: path(s.company), as: holder });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses a principal without it with 403 ERR_RBAC_FORBIDDEN, naming the code", async () => {
    const res = await api.request({ method: "POST", path: path(s.company), as: bare });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("hr.filing.generate");
  });

  it("is bound to the path company: a grant in another tenant's company does not carry over", async () => {
    const res = await api.request({ method: "POST", path: path(s.company), as: elsewhere });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });
});
