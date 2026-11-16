import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, type Seed } from "@dulja/db/test";
import { grantAdmin } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const codes = async (response: Response) =>
  ((await response.json()) as { items: { code: string }[] }).items
    .map((item) => item.code)
    .toSorted();

describe("/v1/admin/currencies", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;
  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    b = await seedTenant(api.db, "Beta");
    await grantAdmin(api, a);
    await grantAdmin(api, b);
  });
  afterAll(async () => api.stop());

  // USD, not MYR: seedTenant gives every tenant its own MYR, because 0008 made company.base_currency
  // a foreign key into app.currency. The defaults this asserts are the column's, not the code's.
  it("creates currencies with defaults and explicit display policy", async () => {
    const usd = await api.request({
      method: "POST",
      path: "/v1/admin/currencies",
      as: a.human,
      body: {
        companyId: a.company,
        code: "USD",
        nameEn: "United States dollar",
        nameAr: "دولار أمريكي",
      },
    });
    expect(usd.status).toBe(201);
    expect(await usd.json()).toMatchObject({
      minorUnits: 2,
      posRoundingIncrement: "0.0100",
      roundingMode: "HALF_AWAY_FROM_ZERO",
    });
    const jpy = await api.request({
      method: "POST",
      path: "/v1/admin/currencies",
      as: a.human,
      body: {
        companyId: a.company,
        code: "JPY",
        nameEn: "Japanese yen",
        minorUnits: 0,
        posRoundingIncrement: "1.0000",
      },
    });
    expect(jpy.status).toBe(201);
  });

  it("validates codes and rounding modes", async () => {
    for (const body of [
      { companyId: a.company, code: "myr", nameEn: "x" },
      { companyId: a.company, code: "SGD", nameEn: "x", roundingMode: "HALF_UP" },
    ]) {
      const res = await api.request({
        method: "POST",
        path: "/v1/admin/currencies",
        as: a.human,
        body,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("enforces tenant-local uniqueness", async () => {
    const duplicate = await api.request({
      method: "POST",
      path: "/v1/admin/currencies",
      as: a.human,
      body: { companyId: a.company, code: "MYR", nameEn: "again" },
    });
    expect(((await duplicate.json()) as Problem).code).toBe("ERR_CONFLICT_UNIQUE");
    const other = await api.request({
      method: "POST",
      path: "/v1/admin/currencies",
      as: b.human,
      body: { companyId: b.company, code: "USD", nameEn: "United States dollar" },
    });
    expect(other.status).toBe(201);
  });

  it("lists only the caller tenant", async () => {
    const mine = await api.request({ method: "GET", path: "/v1/admin/currencies", as: a.human });
    const theirs = await api.request({ method: "GET", path: "/v1/admin/currencies", as: b.human });
    expect(await codes(mine)).toEqual(["JPY", "MYR", "USD"]);
    expect(await codes(theirs)).toEqual(["MYR", "USD"]);
  });

  it("archives instead of deleting", async () => {
    const created = await api.request({
      method: "POST",
      path: "/v1/admin/currencies",
      as: a.human,
      body: { companyId: a.company, code: "SGD", nameEn: "Singapore dollar" },
    });
    const { id } = (await created.json()) as { id: string };
    const archived = await api.request({
      method: "PATCH",
      path: `/v1/admin/currencies/${id}`,
      as: a.human,
      body: { companyId: a.company, archived: true },
    });
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();
    const visible = await api.request({ method: "GET", path: "/v1/admin/currencies", as: a.human });
    expect(await codes(visible)).not.toContain("SGD");
    const all = await api.request({
      method: "GET",
      path: "/v1/admin/currencies?includeArchived=true",
      as: a.human,
    });
    expect(await codes(all)).toContain("SGD");
  });
});
