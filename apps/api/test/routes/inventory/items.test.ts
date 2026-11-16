import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import {
  grantCodes,
  seedAccount,
  seedTaxCode,
  seedTenantV2,
  seedUnit,
  uuidv7,
  type Seed,
} from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("GET|POST /v1/companies/{companyId}/items", () => {
  let api: StartedApi;
  let s: Seed;
  let other: Seed;
  let pieceId: string;
  let cartonId: string;
  let readOnly: string;

  /** §4.2.12's harness: ONE `ApiRequest` object, `as` for the principal, and a fresh `Idempotency-Key`
   *  minted for every unsafe method unless `idempotencyKey` says otherwise. Nothing sets that header here. */
  const post = (path: string, body: unknown, as: string = s.human) =>
    api.request({ method: "POST", path, body, as });
  const get = (path: string, as: string = s.human) => api.request({ method: "GET", path, as });

  /** A real second principal (2B's `secondPrincipal` shape): `role_assignment.principal_id` has a foreign
   *  key to `app.principal`, so a bare uuid handed to `grantCodes` is a 23503, and `as` would sign a token
   *  resolving to no membership. `actorId: s.system` because this transaction runs as `app_migrator`. */
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
    s = await seedTenantV2(api.db, "Items API");
    other = await seedTenantV2(api.db, "Items API B");
    for (const account of [
      ["1300", "asset"],
      ["5000", "expense"],
      ["5900", "expense"],
    ] as const) {
      await seedAccount(api.db, s, { code: account[0], nameEn: account[0], type: account[1] });
    }
    // `grantAdmin` grants the five admin codes only, and none of them reaches an inventory route, so the
    // two catalogue codes are granted here through a real role chain.
    await grantCodes(api.db, s, {
      codes: ["inventory.item.read", "inventory.item.manage"],
      roleCode: "catalogue",
    });
    pieceId = await seedUnit(api.db, s, { code: "PCS", nameEn: "Piece" });
    cartonId = await seedUnit(api.db, s, { code: "CTN", nameEn: "Carton" });
    readOnly = await secondPrincipal("item-reader");
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  it("creates an item with the four resolved account defaults", async () => {
    const res = await post(`/v1/companies/${s.company}/items`, {
      code: "RICE-5KG",
      nameEn: "Rice 5kg",
      nameAr: "أرز ٥ كجم",
      kind: "product",
      baseUnitId: pieceId,
      barcode: "9556000000019",
      shelfLifeDays: 365,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: "RICE-5KG",
      kind: "product",
      trackLots: true,
      archivedAt: null,
    });
    expect(body.inventoryAccountId).not.toBeNull();
    expect(body.cogsAccountId).not.toBeNull();
  });

  it("round-trips item tax selection, clears explicit null and refuses missing, expired and other-company codes", async () => {
    const tax = await seedTaxCode(api.db, s, { code: "ITEM-EXEMPT", kind: "exempt" });
    const otherTax = await seedTaxCode(api.db, other, { code: "OTHER-EXEMPT", kind: "exempt" });
    const base = { code: "TAX-ITEM", nameEn: "Tax item", kind: "product", baseUnitId: pieceId };
    const created = await post(`/v1/companies/${s.company}/items`, {
      ...base,
      taxCodeId: tax.taxCodeId,
    });
    expect(created.status).toBe(201);
    const item = (await created.json()) as { id: string; taxCodeId: string | null };
    expect(item.taxCodeId).toBe(tax.taxCodeId);
    const path = `/v1/companies/${s.company}/items/${item.id}`;
    const patched = await api.request({
      method: "PATCH",
      path,
      as: s.human,
      body: { taxCodeId: null },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ taxCodeId: null });
    expect(await (await get(path)).json()).toMatchObject({ taxCodeId: null });
    for (const taxCodeId of [otherTax.taxCodeId, await uuidv7(api.db.admin)]) {
      const refused = await api.request({
        method: "PATCH",
        path,
        as: s.human,
        body: { taxCodeId },
      });
      expect(refused.status).toBe(400);
      expect((await problemOf(refused)).code).toBe("ERR_VALIDATION_FAILED");
    }
    await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: "expire-item-tax" },
      (tx) =>
        tx`update app.tax_code set effective_to = current_date - 1 where id = ${tax.taxCodeId}`,
    );
    const expired = await post(`/v1/companies/${s.company}/items`, {
      ...base,
      code: "EXPIRED-TAX",
      taxCodeId: tax.taxCodeId,
    });
    expect(expired.status).toBe(400);
    expect((await problemOf(expired)).code).toBe("ERR_VALIDATION_FAILED");
    const untaxed = await post(`/v1/companies/${s.company}/items`, {
      ...base,
      code: "UNTAXED-ITEM",
    });
    expect(untaxed.status).toBe(201);
    expect(await untaxed.json()).toMatchObject({ taxCodeId: null });
  });

  it("requires Idempotency-Key on POST (spec:2055)", async () => {
    // `idempotencyKey: null` sends NO header. Omitting the field would let the harness mint one.
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/items`,
      as: s.human,
      idempotencyKey: null,
      body: { code: "X", nameEn: "X", kind: "product", baseUnitId: pieceId },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("a duplicate code in one company is a 409", async () => {
    const res = await post(`/v1/companies/${s.company}/items`, {
      code: "RICE-5KG",
      nameEn: "Rice again",
      kind: "product",
      baseUnitId: pieceId,
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("a bad kind is a 400 naming the field, never a 500", async () => {
    const res = await post(`/v1/companies/${s.company}/items`, {
      code: "BAD",
      nameEn: "Bad",
      kind: "widget",
      baseUnitId: pieceId,
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toContain("kind");
  });

  it("lists with a cursor and hides archived items by default", async () => {
    for (const code of ["AAA-1", "BBB-2", "CCC-3"]) {
      await post(`/v1/companies/${s.company}/items`, {
        code,
        nameEn: code,
        kind: "product",
        baseUnitId: pieceId,
      });
    }
    const first = await get(`/v1/companies/${s.company}/items?limit=2`);
    const page1 = (await first.json()) as { items: { code: string }[]; next_cursor: string };
    expect(page1.items.map((i) => i.code)).toEqual(["AAA-1", "BBB-2"]);
    expect(page1.next_cursor).toBeTruthy();
    const second = await get(
      `/v1/companies/${s.company}/items?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`,
    );
    const page2 = (await second.json()) as { items: { code: string }[] };
    expect(page2.items.map((i) => i.code)).toEqual(["CCC-3", "RICE-5KG"]);
  });

  it("archive is a POST, never a DELETE (spec:2049)", async () => {
    const created = (await (
      await post(`/v1/companies/${s.company}/items`, {
        code: "OLD-1",
        nameEn: "Old",
        kind: "product",
        baseUnitId: pieceId,
      })
    ).json()) as { id: string };
    const res = await post(`/v1/companies/${s.company}/items/${created.id}/archive`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();
    const gone = await get(`/v1/companies/${s.company}/items?limit=1000`);
    const page = (await gone.json()) as { items: { code: string }[] };
    expect(page.items.map((i) => i.code)).not.toContain("OLD-1");
    const del = await api.request({
      method: "DELETE",
      path: `/v1/companies/${s.company}/items/${created.id}`,
      as: s.human,
    });
    // No route: master data is archived, never deleted.
    expect(del.status).toBe(404);
  });

  it("replaces an item's unit conversions and refuses a zero denominator", async () => {
    const found = (await (
      await get(`/v1/companies/${s.company}/items?filter[code][eq]=RICE-5KG`)
    ).json()) as { items: { id: string }[] };
    const item = found.items[0]!;
    const ok = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/items/${item.id}/unit-conversions`,
      as: s.human,
      body: { conversions: [{ unitId: cartonId, numerator: "12", denominator: "1" }] },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        unitId: cartonId,
        unitCode: "CTN",
        numerator: "12",
        denominator: "1",
      }),
    ]);
    const bad = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/items/${item.id}/unit-conversions`,
      as: s.human,
      body: { conversions: [{ unitId: cartonId, numerator: "12", denominator: "0" }] },
    });
    // The Zod digit-string regex refuses it before `unit_conversion_denominator_check` does.
    expect(bad.status).toBe(400);
  });

  it("a read code cannot write, and a write code is required for the manage routes (R7)", async () => {
    await grantCodes(api.db, s, {
      codes: ["inventory.item.read"],
      principalId: readOnly,
      roleCode: "item-reader",
    });
    const list = await get(`/v1/companies/${s.company}/items`, readOnly);
    expect(list.status).toBe(200);
    const write = await post(
      `/v1/companies/${s.company}/items`,
      { code: "NOPE", nameEn: "Nope", kind: "product", baseUnitId: pieceId },
      readOnly,
    );
    expect(write.status).toBe(403);
    expect((await problemOf(write)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("another tenant's company is refused before any row is read (test 12)", async () => {
    const res = await get(`/v1/companies/${other.company}/items`);
    expect(res.status).toBe(403);
  });
});
