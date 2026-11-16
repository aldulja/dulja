import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("GET|POST /v1/companies/{companyId}/units", () => {
  let api: StartedApi;
  let s: Seed;
  let other: Seed;
  let readOnly: string;

  const post = (path: string, body: unknown, as: string = s.human) =>
    api.request({ method: "POST", path, body, as });
  const get = (path: string, as: string = s.human) => api.request({ method: "GET", path, as });

  const secondPrincipal = async (label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await withTenant(
      api.db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: `${label}-setup` },
      async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${id}, 'human', ${`${label}:${s.tenant}`}, ${label})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
      },
    );
    return id;
  };

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Units API");
    other = await seedTenantV2(api.db, "Units API B");
    await grantCodes(api.db, s, {
      codes: ["inventory.item.read", "inventory.item.manage"],
      roleCode: "catalogue",
    });
    readOnly = await secondPrincipal("unit-reader");
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  it("creates a unit of measure", async () => {
    const res = await post(`/v1/companies/${s.company}/units`, { code: "CTN", nameEn: "Carton" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ code: "CTN", nameEn: "Carton", nameAr: null });
  });

  it("requires Idempotency-Key on POST (spec:2055)", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/units`,
      as: s.human,
      idempotencyKey: null,
      body: { code: "BOX", nameEn: "Box" },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("a duplicate code in one company is a 409", async () => {
    const res = await post(`/v1/companies/${s.company}/units`, { code: "CTN", nameEn: "Again" });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("an empty code is a 400 naming the field, never a 500", async () => {
    const res = await post(`/v1/companies/${s.company}/units`, { code: "", nameEn: "Nameless" });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toContain("code");
  });

  it("lists with a cursor over code", async () => {
    for (const code of ["AAA", "BBB"]) {
      await post(`/v1/companies/${s.company}/units`, { code, nameEn: code });
    }
    const first = await get(`/v1/companies/${s.company}/units?limit=2`);
    const page1 = (await first.json()) as { items: { code: string }[]; next_cursor: string };
    expect(page1.items.map((u) => u.code)).toEqual(["AAA", "BBB"]);
    expect(page1.next_cursor).toBeTruthy();
    const second = await get(
      `/v1/companies/${s.company}/units?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`,
    );
    const page2 = (await second.json()) as { items: { code: string }[] };
    expect(page2.items.map((u) => u.code)).toEqual(["CTN"]);
  });

  it("has no archive route: a unit carries no archived_at (§4.6.1)", async () => {
    const created = (await (
      await post(`/v1/companies/${s.company}/units`, { code: "ZZZ", nameEn: "Zed" })
    ).json()) as { id: string };
    const res = await post(`/v1/companies/${s.company}/units/${created.id}/archive`, {});
    expect(res.status).toBe(404);
  });

  it("a read code lists but cannot create (R7)", async () => {
    await grantCodes(api.db, s, {
      codes: ["inventory.item.read"],
      principalId: readOnly,
      roleCode: "unit-reader",
    });
    expect((await get(`/v1/companies/${s.company}/units`, readOnly)).status).toBe(200);
    const write = await post(
      `/v1/companies/${s.company}/units`,
      { code: "NOPE", nameEn: "Nope" },
      readOnly,
    );
    expect(write.status).toBe(403);
    expect((await problemOf(write)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("another tenant's company is refused before any row is read (test 12)", async () => {
    expect((await get(`/v1/companies/${other.company}/units`)).status).toBe(403);
  });
});
