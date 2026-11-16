import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api"; // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

describe("the pay-component catalogue over HTTP", () => {
  let f: HrFixture;
  const path = () => `/v1/companies/${f.companyId}/pay-components`;
  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-pay-components");
    const res = await f.api.request({
      method: "POST",
      path: path(),
      as: f.officer,
      body: { code: "BASIC", nameEn: "Basic salary", kind: "earning", quantityBased: false },
    });
    expect(res.status).toBe(201);
  }, 240_000);
  afterAll(async () => {
    await f.api.stop();
  });

  it("creates and lists, with the account columns null until 8B seeds them (amendment A2)", async () => {
    const res = await f.api.request({ method: "GET", path: path(), as: f.officer });
    const body = (await res.json()) as {
      items: { code: string; kind: string; expenseAccountId: string | null; schemeIds: string[] }[];
    };
    const row = body.items.find((i) => i.code === "BASIC")!;
    expect(row.kind).toBe("earning");
    expect(row.expenseAccountId).toBeNull();
    expect(row.schemeIds).toEqual([]); // applicability arrives with OD-23 (T6)
  });

  it("a third kind is ERR_VALIDATION_FAILED at the Zod layer, before the CHECK ever runs (spec:2079)", async () => {
    const res = await f.api.request({
      method: "POST",
      path: path(),
      as: f.officer,
      body: { code: "EMPLOYER_X", nameEn: "Employer share", kind: "employer_contribution" },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("the create body accepts no account id — 8B's seed owns that wiring", async () => {
    const res = await f.api.request({
      method: "POST",
      path: path(),
      as: f.officer,
      body: {
        code: "STRAY",
        nameEn: "Stray",
        kind: "earning",
        expenseAccountId: "00000000-0000-7000-8000-000000000001",
      },
    });
    expect(res.status).toBe(400); // an unknown property: CreatePayComponentBody is closed
  });

  it("a duplicate code in one company is ERR_CONFLICT_UNIQUE", async () => {
    const res = await f.api.request({
      method: "POST",
      path: path(),
      as: f.officer,
      body: { code: "BASIC", nameEn: "Basic salary again", kind: "earning" },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("a principal without hr.pay_component.manage cannot create, and one without hr.compensation.read cannot list", async () => {
    const post = await f.api.request({
      method: "POST",
      path: path(),
      as: f.outsider,
      body: { code: "NOPE", nameEn: "Nope", kind: "earning" },
    });
    expect(post.status).toBe(403);
    const get = await f.api.request({ method: "GET", path: path(), as: f.outsider });
    expect(get.status).toBe(403);
  });

  it("renames, and refuses a change of code or kind (a posted line is read back by code)", async () => {
    const list = (await (
      await f.api.request({ method: "GET", path: path(), as: f.officer })
    ).json()) as { items: { id: string; code: string }[] };
    const id = list.items.find((i) => i.code === "BASIC")!.id;
    const renamed = await f.api.request({
      method: "PATCH",
      path: `${path()}/${id}`,
      as: f.officer,
      body: { nameEn: "Basic pay", nameAr: "الراتب الأساسي" },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      code: "BASIC",
      nameEn: "Basic pay",
      nameAr: "الراتب الأساسي",
    });
    for (const body of [{ code: "BASIC2" }, { kind: "deduction" }]) {
      const res = await f.api.request({
        method: "PATCH",
        path: `${path()}/${id}`,
        as: f.officer,
        body,
      });
      expect(res.status).toBe(400);
    }
  });

  it("an unknown or other-tenant component is 404 on every component route", async () => {
    const missing = `${path()}/00000000-0000-7000-8000-0000000000fd`;
    for (const [method, p, body] of [
      ["PATCH", missing, { nameEn: "x" }],
      ["PUT", `${missing}/schemes`, { schemeIds: [] }],
      ["POST", `${missing}/archive`, undefined],
    ] as const) {
      const res = await f.api.request({
        method,
        path: p,
        as: f.officer,
        ...(body ? { body } : {}),
      });
      expect(res.status, `${method} ${p}`).toBe(404);
    }
  });

  // The `PUT …/schemes` unknown-scheme case is NOT here: the scheme FK arrives with migration 0084 (amendment A13),
  // so before Task 8 an unknown id inserts. The case lives in Task 10, the first suite with the constraint in place.

  it("archiving sets archivedAt and drops the row from the default list (spec:2049 — never DELETE)", async () => {
    const created = await f.api.request({
      method: "POST",
      path: path(),
      as: f.officer,
      body: { code: "OLD_BONUS", nameEn: "Old bonus", kind: "earning" },
    });
    const id = ((await created.json()) as { id: string }).id;
    expect(
      (await f.api.request({ method: "POST", path: `${path()}/${id}/archive`, as: f.officer }))
        .status,
    ).toBe(200);
    const listed = (await (
      await f.api.request({ method: "GET", path: path(), as: f.officer })
    ).json()) as { items: { code: string }[] };
    expect(listed.items.map((i) => i.code)).not.toContain("OLD_BONUS");
    const all = (await (
      await f.api.request({
        method: "GET",
        path: `${path()}?filter[archived][eq]=true`,
        as: f.officer,
      })
    ).json()) as { items: { code: string; archivedAt: string | null }[] };
    expect(all.items.find((i) => i.code === "OLD_BONUS")!.archivedAt).not.toBeNull();
  });

  it("an undeclared filter, a sort or a page size is ERR_VALIDATION_FAILED, never silently dropped", async () => {
    for (const q of ["filter[code][eq]=BASIC", "sort=code", "limit=1"]) {
      const res = await f.api.request({ method: "GET", path: `${path()}?${q}`, as: f.officer });
      expect(res.status).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });
});
