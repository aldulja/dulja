import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedItem, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/promotions — contracts §4.6.1, spec:1062", () => {
  let api: StartedApi;
  let s: Seed;
  let other: Seed;
  let stockOnly: string;
  const base = () => `/v1/companies/${s.company}/promotions`;

  const get = (path: string, as: string = s.human) => api.request({ method: "GET", path, as });
  const post = (path: string, body: unknown, as: string = s.human) =>
    api.request({ method: "POST", path, body, as });
  const patch = (path: string, body: unknown, as: string = s.human) =>
    api.request({ method: "PATCH", path, body, as });

  /** A real second principal (2B's `secondPrincipal` shape, plan0A:837) — `role_assignment.principal_id` has
   *  a foreign key to `app.principal`, so a bare uuid would be a 23503 in `grantCodes`. */
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

  /** A SIBLING company in the same tenant with its own BRANCH, unit and item, and a same-company value of a
   *  dimension that is not BRANCH (2026-11-15 review, API-15 / INV-14). */
  const seedForeignRefs = async (label: string) => {
    const ids = {
      company: await uuidv7(api.db.admin),
      branchType: await uuidv7(api.db.admin),
      branch: await uuidv7(api.db.admin),
      unit: await uuidv7(api.db.admin),
      item: await uuidv7(api.db.admin),
      costType: await uuidv7(api.db.admin),
      costCentre: await uuidv7(api.db.admin),
    };
    await withTenant(
      api.db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: `${label}-foreign` },
      async (tx) => {
        await tx`insert into app.company (id, tenant_id, code, name, base_currency)
                 values (${ids.company}, ${s.tenant}, ${`${label}-SIB`}, 'Sibling company', 'MYR')`;
        await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en)
                 values (${ids.branchType}, ${s.tenant}, ${ids.company}, 'BRANCH', 'Branch')`;
        await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en)
                 values (${ids.branch}, ${s.tenant}, ${ids.branchType}, 'HQ', 'Sibling head office')`;
        await tx`insert into app.unit_of_measure (id, tenant_id, company_id, code, name_en)
                 values (${ids.unit}, ${s.tenant}, ${ids.company}, 'PCS', 'Pieces')`;
        await tx`insert into app.item (id, tenant_id, company_id, code, name_en, kind, base_unit_id)
                 values (${ids.item}, ${s.tenant}, ${ids.company}, 'SIB-ITEM', 'Sibling item',
                         'product', ${ids.unit})`;
        await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en)
                 values (${ids.costType}, ${s.tenant}, ${s.company}, ${`${label}-CC`}, 'Cost centre')`;
        await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en)
                 values (${ids.costCentre}, ${s.tenant}, ${ids.costType}, 'CC1', 'Cost centre 1')`;
      },
    );
    return ids;
  };

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Promotions API");
    other = await seedTenantV2(api.db, "Promotions API B");
    await grantCodes(api.db, s, { codes: ["inventory.price.manage"], roleCode: "promo-clerk" });
    stockOnly = await secondPrincipal("stock-only");
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  it("creates a promotion; the definition is carried verbatim for 6B to interpret", async () => {
    const res = await post(base(), {
      code: "RAYA-10",
      nameEn: "Raya 10%",
      nameAr: "عرض العيد",
      kind: "percent_off",
      definition: { percent: "10.0000" },
      startsAt: "2026-03-01T00:00:00Z",
      endsAt: "2026-03-31T00:00:00Z",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      code: "RAYA-10",
      kind: "percent_off",
      definition: { percent: "10.0000" },
      branchId: null,
    });
  });

  it("a kind outside the CHECK is a 400 naming kind, never a 500", async () => {
    const res = await post(base(), {
      code: "BOGO",
      nameEn: "Buy one get one",
      kind: "buy_one_get_one",
      definition: {},
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toContain("kind");
  });

  it("an endsAt before startsAt is a 400 naming endsAt", async () => {
    const res = await post(base(), {
      code: "BAD-WINDOW",
      nameEn: "Bad window",
      kind: "amount_off",
      definition: {},
      startsAt: "2026-05-31T00:00:00Z",
      endsAt: "2026-05-01T00:00:00Z",
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).errors?.map((e) => e.path)).toContain("endsAt");
  });

  it("?activeOn filters on the window and ?branchId returns the branch's plus the company-wide", async () => {
    await post(base(), {
      code: "BRANCH-5",
      nameEn: "Branch five",
      kind: "amount_off",
      definition: { amount: "5.0000" },
      branchId: s.hq,
    });
    const inWindow = (await (
      await get(`${base()}?activeOn=2026-03-15T00:00:00Z&limit=100`)
    ).json()) as { items: { code: string }[] };
    expect(inWindow.items.map((p) => p.code)).toContain("RAYA-10");

    const outOfWindow = (await (
      await get(`${base()}?activeOn=2026-08-15T00:00:00Z&limit=100`)
    ).json()) as { items: { code: string }[] };
    expect(outOfWindow.items.map((p) => p.code)).not.toContain("RAYA-10");

    const byBranch = (await (await get(`${base()}?branchId=${s.hq}&limit=100`)).json()) as {
      items: { code: string }[];
    };
    // The branch's own offer AND the company-wide ones — spec:1312's "a shop pulls only its own".
    expect(byBranch.items.map((p) => p.code)).toEqual(
      expect.arrayContaining(["BRANCH-5", "RAYA-10"]),
    );
  });

  it("lists with a cursor over code", async () => {
    const page1 = (await (await get(`${base()}?limit=1`)).json()) as {
      items: { code: string }[];
      next_cursor: string | null;
    };
    expect(page1.items.map((p) => p.code)).toEqual(["BRANCH-5"]);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = (await (
      await get(`${base()}?limit=1&cursor=${encodeURIComponent(page1.next_cursor!)}`)
    ).json()) as { items: { code: string }[] };
    expect(page2.items.map((p) => p.code)).toEqual(["RAYA-10"]);
  });

  it("there is no archive route: a promotion is retired by patching endsAt (§4.6.1)", async () => {
    const created = (await (
      await post(base(), {
        code: "RETIRE-ME",
        nameEn: "Retire me",
        kind: "bundle",
        definition: { buy: 2, get: 1 },
      })
    ).json()) as { id: string };

    const archive = await post(`${base()}/${created.id}/archive`, {});
    expect(archive.status).toBe(404); // app.promotion has no archived_at, so no such route exists

    const retired = await patch(`${base()}/${created.id}`, { endsAt: "2026-01-01T00:00:00Z" });
    expect(retired.status).toBe(200);
    expect(((await retired.json()) as { endsAt: string | null }).endsAt).not.toBeNull();

    const active = (await (
      await get(`${base()}?activeOn=2026-06-01T00:00:00Z&limit=100`)
    ).json()) as {
      items: { code: string }[];
    };
    expect(active.items.map((p) => p.code)).not.toContain("RETIRE-ME");
  });

  it("the gate is inventory.price.manage: inventory.stock.read alone is refused", async () => {
    await grantCodes(api.db, s, {
      codes: ["inventory.stock.read"],
      principalId: stockOnly,
      roleCode: "stock-only-promos",
    });
    const write = await post(
      base(),
      { code: "NOPE", nameEn: "Nope", kind: "percent_off", definition: {} },
      stockOnly,
    );
    expect(write.status).toBe(403);
    expect((await problemOf(write)).code).toBe("ERR_RBAC_FORBIDDEN");
    expect((await get(base(), stockOnly)).status).toBe(403);
  });

  it("another tenant's company is refused before any row is read (test 12)", async () => {
    const res = await get(`/v1/companies/${other.company}/promotions`);
    expect(res.status).toBe(403);
  });

  it("compares promotion windows by instant even when their UTC offsets differ", async () => {
    const response = await post(base(), {
      code: "ZZ-OFFSET",
      nameEn: "Offset window",
      kind: "percent_off",
      definition: {},
      startsAt: "2026-09-30T12:00:00+08:00",
      endsAt: "2026-09-30T05:00:00Z",
    });
    expect(response.status).toBe(201);
    const row = (await response.json()) as { id: string };
    const invalid = await patch(`${base()}/${row.id}`, {
      startsAt: "2026-09-30T12:00:00+08:00",
      endsAt: "2026-09-30T13:00:00+10:00",
    });
    expect(invalid.status).toBe(400);
    expect((await problemOf(invalid)).errors?.map((e) => e.path)).toContain("endsAt");
  });

  it("preserves microseconds when creating, updating and filtering a promotion window", async () => {
    const response = await post(base(), {
      code: "ZZ-PRECISE",
      nameEn: "Precise window",
      kind: "percent_off",
      definition: {},
      startsAt: "2026-09-30T12:00:00.000001Z",
      endsAt: "2026-09-30T12:00:00.000003Z",
    });
    expect(response.status).toBe(201);
    const row = (await response.json()) as { id: string; startsAt: string; endsAt: string };
    expect(row.startsAt).toContain(".000001");
    expect(row.endsAt).toContain(".000003");
    const inside = await get(`${base()}?activeOn=2026-09-30T12:00:00.000002Z&limit=100`);
    const page = (await inside.json()) as { items: { code: string }[] };
    expect(page.items.map((item) => item.code)).toContain("ZZ-PRECISE");
    const updated = await patch(`${base()}/${row.id}`, {
      startsAt: "2026-09-30T12:00:00.000010Z",
      endsAt: "2026-09-30T12:00:00.000011Z",
    });
    expect(updated.status).toBe(200);
    const changed = (await updated.json()) as { startsAt: string; endsAt: string };
    expect(changed.startsAt).toContain(".00001");
    expect(changed.endsAt).toContain(".000011");
  });

  it("returns a field validation error when PostgreSQL rounds a window's endpoints to the same instant", async () => {
    const response = await post(base(), {
      code: "ZZ-ROUNDED",
      nameEn: "Rounded window",
      kind: "percent_off",
      definition: {},
      startsAt: "2026-09-30T12:00:00.0000001Z",
      endsAt: "2026-09-30T12:00:00.0000002Z",
    });
    expect(response.status).toBe(400);
    expect((await problemOf(response)).errors?.map((e) => e.path)).toContain("endsAt");
  });

  it("validates a partial window patch against the retained endpoint without changing the row", async () => {
    const created = await post(base(), {
      code: "ZZ-PARTIAL",
      nameEn: "Partial window",
      kind: "percent_off",
      definition: {},
      startsAt: "2026-09-30T12:00:00Z",
      endsAt: "2026-09-30T13:00:00Z",
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as { id: string; startsAt: string; endsAt: string };
    for (const change of [
      { endsAt: "2026-09-30T11:00:00Z" },
      { startsAt: "2026-09-30T14:00:00Z" },
      { startsAt: "2026-09-30T12:00:00.0000001Z", endsAt: "2026-09-30T12:00:00.0000002Z" },
    ]) {
      const response = await patch(`${base()}/${row.id}`, change);
      expect(response.status).toBe(400);
      expect((await problemOf(response)).errors?.map((e) => e.path)).toContain("endsAt");
    }
    const unchanged = await patch(`${base()}/${row.id}`, { nameEn: "Renamed" });
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({ startsAt: row.startsAt, endsAt: row.endsAt });
  });

  it("API-15 / INV-14: a branch that is not this company's BRANCH value is a 404 and creates nothing", async () => {
    const foreign = await seedForeignRefs("PR");
    for (const [code, branchId] of [
      ["SIB-BRANCH", foreign.branch],
      ["NOT-BRANCH", foreign.costCentre],
    ] as const) {
      const res = await post(base(), {
        code,
        nameEn: code,
        kind: "percent_off",
        definition: {},
        branchId,
      });
      expect(res.status).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
      const listed = (await (await get(`${base()}?limit=100`)).json()) as {
        items: { code: string }[];
      };
      expect(listed.items.map((p) => p.code)).not.toContain(code);
    }
  });

  it("API-15: a definition's itemIds must be this company's items, on create and on edit", async () => {
    const foreign = await seedForeignRefs("PRI");
    const { itemId } = await seedItem(api.db, s, { code: "PROMO-OWN" });
    const refused = await post(base(), {
      code: "SIB-ITEM",
      nameEn: "Sibling item",
      kind: "percent_off",
      definition: { itemIds: [itemId, foreign.item], percent: "0.100000" },
    });
    expect(refused.status).toBe(404);
    expect((await problemOf(refused)).code).toBe("ERR_NOT_FOUND");

    const created = await post(base(), {
      code: "OWN-ITEM",
      nameEn: "Own item",
      kind: "percent_off",
      definition: { itemIds: [itemId], percent: "0.100000" },
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as { id: string };
    const edited = await patch(`${base()}/${row.id}`, {
      definition: { itemIds: [foreign.item], percent: "0.100000" },
    });
    expect(edited.status).toBe(404);
    expect((await problemOf(edited)).code).toBe("ERR_NOT_FOUND");
  });
});
