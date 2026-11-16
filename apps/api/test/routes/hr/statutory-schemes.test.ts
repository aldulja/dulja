import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYNTH_RATE_TABLE_V1 } from "@dulja/db/test";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api"; // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

describe("statutory schemes and rate tables over HTTP", () => {
  let f: HrFixture;
  let schemeId: string;
  let componentId: string;
  const schemes = () => `/v1/companies/${f.companyId}/statutory-schemes`;
  const tables = () => `${schemes()}/${schemeId}/rate-tables`;

  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-schemes");
    // The scheme comes from the FIXTURE: schemes are seed-pack data (ADR 0073) and no route creates one.
    schemeId = f.schemeId;
    const created = await f.api.request({
      method: "POST",
      path: `/v1/companies/${f.companyId}/pay-components`,
      as: f.officer,
      body: { code: "BASIC", nameEn: "Basic salary", kind: "earning", quantityBased: false },
    });
    expect(created.status).toBe(201);
    componentId = ((await created.json()) as { id: string }).id;
  }, 240_000);
  afterAll(async () => {
    await f.api.stop();
  });

  it("the list route returns the fixture's scheme, by code", async () => {
    const res = await f.api.request({ method: "GET", path: schemes(), as: f.officer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; code: string; employerRegistration: string | null }[];
      next_cursor: string | null;
    };
    const synth = body.items.find((s) => s.code === "SYNTH");
    expect(synth?.id).toBe(schemeId);
    expect(synth?.employerRegistration).toBeNull(); // ⚠️ OD-23 has not landed (T11)
    expect(body.next_cursor).toBeNull();
  });

  it("the list takes no query — a limit or a filter is refused, not ignored", async () => {
    const res = await f.api.request({ method: "GET", path: `${schemes()}?limit=5`, as: f.officer });
    expect(res.status).toBe(400);
  });

  it("the break-glass load stores the table UNVERIFIED and stamps loaded_by (ADR 0073)", async () => {
    const res = await f.api.request({
      method: "POST",
      path: tables(),
      as: f.officer,
      body: { definition: SYNTH_RATE_TABLE_V1 },
    });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as {
      version: number;
      verifiedAt: string | null;
      loadedBy: string;
      source: string;
      effectiveFrom: string;
    };
    expect(dto.version).toBe(1);
    expect(dto.effectiveFrom).toBe("2026-01-01");
    expect(dto.verifiedAt).toBeNull();
    expect(dto.loadedBy).toBe(f.officer);
    expect(dto.source).toContain("Dulja test fixture");
  });

  it("a second load of the same version is ERR_CONFLICT_UNIQUE — a loaded table is never replaced", async () => {
    const res = await f.api.request({
      method: "POST",
      path: tables(),
      as: f.officer,
      body: { definition: SYNTH_RATE_TABLE_V1 },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("an invalid definition is ERR_VALIDATION_FAILED with JSON-Pointer paths (§4.2.4)", async () => {
    const res = await f.api.request({
      method: "POST",
      path: tables(),
      as: f.officer,
      body: { definition: { schema_version: 1, scheme: "SYNTH", version: 9 } },
    });
    expect(res.status).toBe(400);
    const p = await problemOf(res);
    expect(p.code).toBe("ERR_VALIDATION_FAILED");
    expect(p.errors!.length).toBeGreaterThan(0);
    expect(p.errors![0]!.path).toMatch(/^\//);
  });

  it("a definition for another scheme is refused at /scheme, before anything is written", async () => {
    const res = await f.api.request({
      method: "POST",
      path: tables(),
      as: f.officer,
      body: { definition: { ...SYNTH_RATE_TABLE_V1, scheme: "OTHER", version: 5 } },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).errors).toEqual([
      { path: "/scheme", message: 'must be "SYNTH"' },
    ]);
  });

  it("an unknown scheme is 404", async () => {
    const res = await f.api.request({
      method: "POST",
      path: `${schemes()}/00000000-0000-7000-8000-0000000000ee/rate-tables`,
      as: f.officer,
      body: { definition: SYNTH_RATE_TABLE_V1 },
    });
    expect(res.status).toBe(404);
  });

  it("the LOADER cannot verify (test 35, spec:2080)", async () => {
    const res = await f.api.request({
      method: "POST",
      path: `${tables()}/1/verify`,
      as: f.officer,
    });
    // The officer holds manage, not verify, so the pre-flight refuses FIRST: the two codes are held by two seeded
    // roles (R6), and the trigger is the second line, proved in the case after next.
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the CHECKER can, and the row comes back verified", async () => {
    const res = await f.api.request({
      method: "POST",
      path: `${tables()}/1/verify`,
      as: f.checker,
    });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { verifiedAt: string | null; verifiedBy: string | null };
    expect(dto.verifiedAt).not.toBeNull();
    expect(dto.verifiedBy).toBe(f.checker);
  });

  it("and a principal holding BOTH codes still cannot verify what they loaded — the trigger is the control", async () => {
    const loaded = await f.api.request({
      method: "POST",
      path: tables(),
      as: f.checker,
      body: { definition: { ...SYNTH_RATE_TABLE_V1, version: 2, effective_from: "2027-01-01" } },
    });
    expect(loaded.status).toBe(201);
    const res = await f.api.request({
      method: "POST",
      path: `${tables()}/2/verify`,
      as: f.checker,
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_HR_SELF_VERIFY");
  });

  it("a second verification of the same version is 409, not a silent success", async () => {
    const res = await f.api.request({
      method: "POST",
      path: `${tables()}/1/verify`,
      as: f.checker,
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_HR_SELF_VERIFY");
  });

  it("an unknown version is 404", async () => {
    const res = await f.api.request({
      method: "POST",
      path: `${tables()}/99/verify`,
      as: f.checker,
    });
    expect(res.status).toBe(404);
  });

  it("the verifier reads what it signs: the table list, newest first, verified or not", async () => {
    const res = await f.api.request({ method: "GET", path: tables(), as: f.checker });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { version: number; verifiedBy: string | null; loadedBy: string }[];
    };
    expect(body.items.map((t) => [t.version, t.verifiedBy, t.loadedBy])).toEqual([
      [2, null, f.checker],
      [1, f.checker, f.officer],
    ]);
  });

  it("the outsider sees no scheme at all", async () => {
    for (const path of [schemes(), tables()]) {
      const res = await f.api.request({ method: "GET", path, as: f.outsider });
      expect(res.status).toBe(403);
    }
  });

  it("neither unsafe route accepts a call without Idempotency-Key", async () => {
    const load = await f.api.request({
      method: "POST",
      path: tables(),
      as: f.officer,
      body: { definition: SYNTH_RATE_TABLE_V1 },
      idempotencyKey: null,
    });
    expect((await problemOf(load)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    const verify = await f.api.request({
      method: "POST",
      path: `${tables()}/2/verify`,
      as: f.officer,
      idempotencyKey: null,
    });
    expect((await problemOf(verify)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  // Task 7's route, asserted here: `pay_component_scheme.scheme_id` is constrained only from migration 0084 (A13).
  it("PUT /pay-components/{id}/schemes maps a scheme, and an unknown one is ERR_CONFLICT_REFERENCE", async () => {
    const ok = await f.api.request({
      method: "PUT",
      path: `/v1/companies/${f.companyId}/pay-components/${componentId}/schemes`,
      as: f.officer,
      body: { schemeIds: [schemeId] },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { schemeIds: string[] }).schemeIds).toEqual([schemeId]);

    const bad = await f.api.request({
      method: "PUT",
      path: `/v1/companies/${f.companyId}/pay-components/${componentId}/schemes`,
      as: f.officer,
      body: { schemeIds: ["00000000-0000-7000-8000-0000000000ee"] },
    });
    expect(bad.status).toBe(409);
    expect((await problemOf(bad)).code).toBe("ERR_CONFLICT_REFERENCE");
  });
});
