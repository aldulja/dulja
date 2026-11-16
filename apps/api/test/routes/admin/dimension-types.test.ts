import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { grantAdmin } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const types = (seed: Seed, suffix = "") => `/v1/companies/${seed.company}/dimension-types${suffix}`;

describe("generic dimension API", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;
  let costCentre: string;
  /** A second company inside tenant A, with a dimension type and value of its own. */
  let secondType: string;
  let secondValue: string;
  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    b = await seedTenant(api.db, "Beta");
    await grantAdmin(api, a);
    await grantAdmin(api, b);
    // `grantAdmin` assigns a.human in a.company only, so every request below that puts a.company in
    // the path and this company's rows in the URL is an attack the tenant bound cannot see.
    const second = await uuidv7(api.db.admin);
    secondType = await uuidv7(api.db.admin);
    secondValue = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency)
               values (${second}, ${a.tenant}, 'SECOND', 'Alpha second company', 'MYR')`;
      await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en)
               values (${secondType}, ${a.tenant}, ${second}, 'BRANCH', 'Branch')`;
      await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en)
               values (${secondValue}, ${a.tenant}, ${secondType}, 'HQ', 'Second head office')`;
    });
  });
  afterAll(async () => api.stop());

  it("creates a new dimension without a migration", async () => {
    const res = await api.request({
      method: "POST",
      path: types(a),
      as: a.human,
      body: { code: "COST_CENTRE", nameEn: "Cost centre", nameAr: "مركز التكلفة" },
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { id: string; code: string; nameAr: string };
    expect(row).toMatchObject({ code: "COST_CENTRE", nameAr: "مركز التكلفة" });
    costCentre = row.id;
  });

  it("adds parent and child values", async () => {
    const north = await api.request({
      method: "POST",
      path: types(a, `/${costCentre}/values`),
      as: a.human,
      body: { code: "NORTH", nameEn: "Northern region" },
    });
    const { id: northId } = (await north.json()) as { id: string };
    const kl = await api.request({
      method: "POST",
      path: types(a, `/${costCentre}/values`),
      as: a.human,
      body: { code: "KL", nameEn: "Kuala Lumpur", parentId: northId },
    });
    expect(kl.status).toBe(201);
    expect(await kl.json()).toMatchObject({ code: "KL", parentId: northId });
  });

  it("refuses a parent that is a value of another type — this company's or a sibling's (404)", async () => {
    const [branchType] = await api.db.admin<{ id: string }[]>`
      select id from app.dimension_type where company_id = ${a.company} and code = 'BRANCH'`;
    for (const parentId of [a.hq, secondValue]) {
      const res = await api.request({
        method: "POST",
        path: types(a, `/${costCentre}/values`),
        as: a.human,
        // A code DimensionCodeSchema admits (`^[A-Z][A-Z0-9_]{1,31}$`), so the parent — not the code — is
        // what is refused: `X-<hex>` has a hyphen and lower-case hex and answered 400 before the lookup.
        body: { code: `X_${parentId.slice(-4).toUpperCase()}`, nameEn: "Orphan", parentId },
      });
      expect(res.status, parentId).toBe(404);
      expect(((await res.json()) as Problem).code).toBe("ERR_NOT_FOUND");
    }
    void branchType;
  });

  it("lists types and values", async () => {
    const list = await api.request({ method: "GET", path: types(a), as: a.human });
    expect(
      ((await list.json()) as { items: { code: string }[] }).items
        .map((item) => item.code)
        .toSorted(),
    ).toEqual(["BRANCH", "COST_CENTRE"]);
    const values = await api.request({
      method: "GET",
      path: types(a, `/${costCentre}/values`),
      as: a.human,
    });
    expect(
      ((await values.json()) as { items: { code: string }[] }).items
        .map((item) => item.code)
        .toSorted(),
    ).toEqual(["KL", "NORTH"]);
  });

  it("returns a conflict for a duplicate type code", async () => {
    const res = await api.request({
      method: "POST",
      path: types(a),
      as: a.human,
      body: { code: "BRANCH", nameEn: "again" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("validates the code shape", async () => {
    const res = await api.request({
      method: "POST",
      path: types(a),
      as: a.human,
      body: { code: "lower case", nameEn: "x" },
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.some((error) => error.path.includes("code"))).toBe(true);
  });

  it("archives a value instead of deleting it", async () => {
    const created = await api.request({
      method: "POST",
      path: types(a, `/${costCentre}/values`),
      as: a.human,
      body: { code: "TEMP", nameEn: "Temporary" },
    });
    const { id } = (await created.json()) as { id: string };
    const archived = await api.request({
      method: "PATCH",
      path: types(a, `/${costCentre}/values/${id}`),
      as: a.human,
      body: { archived: true },
    });
    expect(archived.status).toBe(200);
    const live = await api.request({
      method: "GET",
      path: types(a, `/${costCentre}/values`),
      as: a.human,
    });
    expect(
      ((await live.json()) as { items: { code: string }[] }).items.map((item) => item.code),
    ).not.toContain("TEMP");
  });

  it("refuses a dimension type belonging to another company of this tenant", async () => {
    // `app.dimension_value` has no company, so a.company in the path and this company's type id in
    // the URL used to satisfy every check there was: `companyExists` is true for both companies.
    const values = await api.request({
      method: "GET",
      path: types(a, `/${secondType}/values`),
      as: a.human,
    });
    expect(values.status).toBe(404);
    expect(((await values.json()) as Problem).code).toBe("ERR_NOT_FOUND");
    const created = await api.request({
      method: "POST",
      path: types(a, `/${secondType}/values`),
      as: a.human,
      body: { code: "FORGED", nameEn: "forged" },
    });
    expect(created.status).toBe(404);
    const patched = await api.request({
      method: "PATCH",
      path: types(a, `/${secondType}/values/${secondValue}`),
      as: a.human,
      body: { nameEn: "Stolen", archived: true },
    });
    expect(patched.status).toBe(404);
    const rows = await api.db.admin<{ code: string; name_en: string; archived_at: Date | null }[]>`
      select code, name_en, archived_at from app.dimension_value
       where dimension_type_id = ${secondType}`;
    expect(rows).toEqual([{ code: "HQ", name_en: "Second head office", archived_at: null }]);
  });

  it("refuses a value that belongs to a different type of the same company", async () => {
    // The PATCH matched on `id` alone, so the `dimensionTypeId` segment named one type while the
    // update reached a value of another. Both are predicates now, and a mismatch is the same 404.
    const response = await api.request({
      method: "PATCH",
      path: types(a, `/${costCentre}/values/${a.hq}`),
      as: a.human,
      body: { nameEn: "Stolen" },
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as Problem).code).toBe("ERR_NOT_FOUND");
    const [row] = await api.db.admin<{ name_en: string }[]>`
      select name_en from app.dimension_value where id = ${a.hq}`;
    expect(row!.name_en).toBe("Head office");
  });

  it("hides another tenant's company and rejects writes", async () => {
    // 403 rather than 404 now that the list carries a gate: the refusal lands before the handler.
    expect((await api.request({ method: "GET", path: types(a), as: b.human })).status).toBe(403);
    const forge = await api.request({
      method: "POST",
      path: types(a),
      as: b.human,
      body: { code: "FORGED", nameEn: "forged" },
    });
    expect([403, 404]).toContain(forge.status);
  });
});
