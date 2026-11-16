import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedItem, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/price-lists — contracts §4.6.1, spec:1025", () => {
  let api: StartedApi;
  let s: Seed;
  let other: Seed;
  let itemId: string;
  let otherItemId: string;
  let stockOnly: string;
  const base = () => `/v1/companies/${s.company}/price-lists`;

  const get = (path: string, as: string = s.human) => api.request({ method: "GET", path, as });
  const post = (path: string, body: unknown, as: string = s.human) =>
    api.request({ method: "POST", path, body, as });
  const put = (path: string, body: unknown, as: string = s.human) =>
    api.request({ method: "PUT", path, body, as });

  /** A real second principal (2B's `secondPrincipal` shape, plan0A:837) — `role_assignment.principal_id` has
   *  a foreign key to `app.principal`, so a bare uuid would be a 23503 in `grantCodes`. */
  const secondPrincipal = async (label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    // `actorId: s.system` — the tenant's system principal from the `Seed` (§4.1), NOT resolved through
    // `systemContext`: that helper calls `app.resolve_principal`, whose EXECUTE is granted to `app_rw` only,
    // and this transaction runs as `app_migrator`.
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
    s = await seedTenantV2(api.db, "Prices API");
    other = await seedTenantV2(api.db, "Prices API B");
    // `grantAdmin` grants the five ADMIN codes and nothing else, so the gate these routes carry is granted
    // here through a real role chain — the same reason `parties.test.ts` writes its own grant helper.
    await grantCodes(api.db, s, { codes: ["inventory.price.manage"], roleCode: "price-clerk" });
    ({ itemId } = await seedItem(api.db, s, { code: "RICE-5KG" }));
    ({ itemId: otherItemId } = await seedItem(api.db, s, { code: "SUGAR-1KG" }));
    stockOnly = await secondPrincipal("stock-only");
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  it("creates a price list; a null branchId means every branch (spec:1312)", async () => {
    const res = await post(base(), {
      code: "RETAIL",
      nameEn: "Retail",
      nameAr: "التجزئة",
      currency: "MYR",
      customerKind: "retail",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      code: "RETAIL",
      currency: "MYR",
      customerKind: "retail",
      branchId: null,
      archivedAt: null,
    });
  });

  it("a validTo before validFrom is a 400 naming validTo, never a 500 from the CHECK", async () => {
    const res = await post(base(), {
      code: "BAD-WINDOW",
      nameEn: "Bad window",
      currency: "MYR",
      validFrom: "2026-06-30",
      validTo: "2026-06-01",
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toContain("validTo");
  });

  it("PUT …/lines replaces the set, archives an omitted line and returns the survivors", async () => {
    const list = (await (
      await post(base(), { code: "LINES", nameEn: "Lines", currency: "MYR" })
    ).json()) as { id: string };
    const first = await put(`${base()}/${list.id}/lines`, {
      lines: [
        { itemId, minQuantity: "0.000000", unitPrice: "9.5000" },
        { itemId: otherItemId, minQuantity: "0.000000", unitPrice: "3.2000" },
      ],
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { items: unknown[] }).items).toHaveLength(2);

    const second = await put(`${base()}/${list.id}/lines`, {
      lines: [{ itemId, minQuantity: "0.000000", unitPrice: "8.9000" }],
    });
    expect(second.status).toBe(200);
    const surviving = ((await second.json()) as { items: { itemId: string; unitPrice: string }[] })
      .items;
    expect(surviving.map((l) => [l.itemId, l.unitPrice])).toEqual([[itemId, "8.9000"]]);

    const listed = await get(`${base()}/${list.id}/lines`);
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("a negative unitPrice is a 400 at the wire, not a check_violation", async () => {
    const list = (await (
      await post(base(), { code: "NEG", nameEn: "Negative", currency: "MYR" })
    ).json()) as { id: string };
    const res = await put(`${base()}/${list.id}/lines`, {
      lines: [{ itemId, unitPrice: "-1.0000" }],
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("resolve prefers the branch list over the company-wide one", async () => {
    const companyWide = (await (
      await post(base(), { code: "A-COMPANY", nameEn: "Company wide", currency: "MYR" })
    ).json()) as { id: string };
    const branch = (await (
      await post(base(), {
        code: "B-BRANCH",
        nameEn: "Branch",
        currency: "MYR",
        branchId: s.hq,
      })
    ).json()) as { id: string };
    await put(`${base()}/${companyWide.id}/lines`, {
      lines: [{ itemId, unitPrice: "10.0000" }],
    });
    await put(`${base()}/${branch.id}/lines`, { lines: [{ itemId, unitPrice: "7.0000" }] });

    const query = `itemId=${itemId}&currency=MYR&quantity=1.000000&on=2026-06-01&branchId=${s.hq}`;
    const res = await get(`${base()}/resolve?${query}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { price: { unitPrice: string } }).toMatchObject({
      price: { priceListCode: "B-BRANCH", unitPrice: "7.0000" },
    });
  });

  it("an item on no applicable list answers 200 { price: null }, never a 404", async () => {
    const unpriced = await seedItem(api.db, s, { code: "SALT-1KG" });
    const res = await get(
      `${base()}/resolve?itemId=${unpriced.itemId}&currency=MYR&quantity=1.000000&on=2026-06-01`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ price: null });
  });

  it("lists with a cursor over code and hides archived lists by default", async () => {
    const page1 = (await (await get(`${base()}?limit=2`)).json()) as {
      items: { code: string }[];
      next_cursor: string | null;
    };
    expect(page1.items.map((l) => l.code)).toEqual(["A-COMPANY", "B-BRANCH"]);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = (await (
      await get(`${base()}?limit=2&cursor=${encodeURIComponent(page1.next_cursor!)}`)
    ).json()) as { items: { code: string }[] };
    expect(page2.items.map((l) => l.code)).toEqual(["LINES", "NEG"]);
  });

  it("archive is a POST, never a DELETE (spec:2049), and the list then hides it", async () => {
    const created = (await (
      await post(base(), { code: "OLD-LIST", nameEn: "Old", currency: "MYR" })
    ).json()) as { id: string };
    const res = await post(`${base()}/${created.id}/archive`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();

    const listed = (await (await get(`${base()}?limit=100`)).json()) as {
      items: { code: string }[];
    };
    expect(listed.items.map((l) => l.code)).not.toContain("OLD-LIST");

    const del = await api.request({
      method: "DELETE",
      path: `${base()}/${created.id}`,
      as: s.human,
    });
    expect(del.status).toBe(404); // no route: master data is archived, never deleted
  });

  it("the gate is inventory.price.manage: inventory.stock.read alone cannot write or read", async () => {
    await grantCodes(api.db, s, {
      codes: ["inventory.stock.read"],
      principalId: stockOnly,
      roleCode: "stock-only-prices",
    });
    const write = await post(base(), { code: "NOPE", nameEn: "Nope", currency: "MYR" }, stockOnly);
    expect(write.status).toBe(403);
    expect((await problemOf(write)).code).toBe("ERR_RBAC_FORBIDDEN");
    expect((await get(base(), stockOnly)).status).toBe(403);
  });

  it("another tenant's company is refused before any row is read (test 12)", async () => {
    const res = await get(`/v1/companies/${other.company}/price-lists`);
    expect(res.status).toBe(403);
  });

  it("API-15 / INV-14: a branch that is not this company's BRANCH value is a 404 and creates nothing", async () => {
    const foreign = await seedForeignRefs("PL");
    for (const [code, branchId] of [
      ["SIB-BRANCH", foreign.branch],
      ["NOT-BRANCH", foreign.costCentre],
    ] as const) {
      const res = await post(base(), { code, nameEn: code, currency: "MYR", branchId });
      expect(res.status).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
      const listed = (await (await get(`${base()}?limit=100`)).json()) as {
        items: { code: string }[];
      };
      expect(listed.items.map((l) => l.code)).not.toContain(code);
    }
  });

  it("API-15: PUT …/lines refuses another company's item or unit with a 404 and keeps the lines", async () => {
    const foreign = await seedForeignRefs("PLL");
    const list = (await (
      await post(base(), { code: "FOREIGN-LINES", nameEn: "Foreign lines", currency: "MYR" })
    ).json()) as { id: string };
    expect(
      (await put(`${base()}/${list.id}/lines`, { lines: [{ itemId, unitPrice: "1.0000" }] }))
        .status,
    ).toBe(200);
    for (const line of [
      { itemId: foreign.item, unitPrice: "2.0000" },
      { itemId, unitId: foreign.unit, unitPrice: "2.0000" },
    ]) {
      const res = await put(`${base()}/${list.id}/lines`, { lines: [line] });
      expect(res.status).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
    }
    const kept = (await (await get(`${base()}/${list.id}/lines`)).json()) as {
      items: { itemId: string; unitPrice: string }[];
    };
    expect(kept.items.map((l) => [l.itemId, l.unitPrice])).toEqual([[itemId, "1.0000"]]);
  });
});
