import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import {
  grantCodes,
  seedItem,
  seedLot,
  seedTenantV2,
  seedWarehouse,
  uuidv7,
  type Seed,
} from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("GET /v1/companies/{companyId}/stock-on-hand", () => {
  let api: StartedApi;
  let s: Seed;
  let other: Seed;
  let itemId: string;
  let warehouseId: string;
  let early: string;
  let late: string;
  let priceOnly: string;

  /** §4.2.12: one `ApiRequest` object; `as` names the principal. A GET with no `as` is unauthenticated and
   *  answers 401, so every read below names one. */
  const get = (path: string, as: string = s.human) => api.request({ method: "GET", path, as });

  /** A real second principal (2B's `secondPrincipal` shape, plan0A:837) — `role_assignment.principal_id` has
   *  a foreign key to `app.principal`, so a bare uuid would be a 23503 in `grantCodes`. */
  const secondPrincipal = async (label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    // `actorId: s.system` — the tenant's system principal, taken from the `Seed` (§4.1), NOT resolved through
    // `systemContext`: that helper calls `app.resolve_principal`, whose EXECUTE is granted to `app_rw` only
    // (§4.1), and this transaction runs as `app_migrator`. 2B's own `secondPrincipal` passes `s.system` for
    // exactly this reason (2b:157–165); the only difference here is the three-argument PRODUCTION `withTenant`,
    // which is what `apps/*/test` uses (§4.2.12) where `packages/db/test` uses the four-argument one.
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
    s = await seedTenantV2(api.db, "Stock API");
    other = await seedTenantV2(api.db, "Stock API B");
    // `grantAdmin` grants the five ADMIN codes and nothing else, so the gate this module carries is granted
    // here through a real role chain.
    await grantCodes(api.db, s, { codes: ["inventory.stock.read"], roleCode: "stock-reader" });
    ({ itemId } = await seedItem(api.db, s, { code: "MILK-1L", trackLots: true }));
    warehouseId = await seedWarehouse(api.db, s, { code: "CHILL" });
    // 2099, never the build year: migration 0112 makes the FEFO pick skip a lot whose `expires_on` is before
    // the SERVER's `current_date`, so a batch dated in 2026 stops being pickable the day that date passes.
    early = await seedLot(api.db, s, { itemId, code: "B-EARLY", expiresOn: "2099-07-31" });
    late = await seedLot(api.db, s, { itemId, code: "B-LATE", expiresOn: "2099-09-30" });
    await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: "stock-seed" },
      async (tx) => {
        for (const [lot, qty] of [
          [early, "10"],
          [late, "40"],
        ] as const) {
          await tx`insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
                   values (${s.tenant}, ${s.company}, ${itemId}, ${warehouseId}, ${lot}, ${qty})`;
        }
      },
    );
    priceOnly = await secondPrincipal("price-only");
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  it("lists stock per item, warehouse and lot with the names a screen needs", async () => {
    const res = await get(`/v1/companies/${s.company}/stock-on-hand`);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: { lotCode: string; quantity: string }[] }).items;
    expect(items.map((i) => [i.lotCode, i.quantity])).toEqual([
      ["B-EARLY", "10.000000"],
      ["B-LATE", "40.000000"],
    ]);
  });

  it("quantities are STRINGS on the wire, never JSON numbers (assumption 13)", async () => {
    const raw = await (await get(`/v1/companies/${s.company}/stock-on-hand`)).text();
    expect(raw).toContain('"quantity":"10.000000"');
    expect(raw).not.toMatch(/"quantity":\s*10/);
  });

  it("GET …/stock-on-hand/fefo returns the earliest-expiring lot first", async () => {
    const res = await get(
      `/v1/companies/${s.company}/stock-on-hand/fefo?itemId=${itemId}&warehouseId=${warehouseId}&quantity=30.000000`,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([
      { lotId: early, quantity: "10.000000" },
      { lotId: late, quantity: "20.000000" },
    ]);
  });

  it("a non-positive fefo quantity is a 400, not an empty list", async () => {
    const res = await get(
      `/v1/companies/${s.company}/stock-on-hand/fefo?itemId=${itemId}&warehouseId=${warehouseId}&quantity=0.000000`,
    );
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("the gate is inventory.stock.read: price.manage alone is refused", async () => {
    await grantCodes(api.db, s, {
      codes: ["inventory.price.manage"],
      principalId: priceOnly,
      roleCode: "price-only",
    });
    const res = await get(`/v1/companies/${s.company}/stock-on-hand`, priceOnly);
    expect(res.status).toBe(403);
  });

  it("stock-on-hand is a LIST endpoint and not a report code (§4.16.1, hazard 4)", async () => {
    // 3A asserted a 404 on the report path "in this slice": `inventory.stock_on_hand` was 3D's code to seed,
    // and 3D T10 has since mounted it on 1B's reports module (inventory-reports.test.ts). What stays true is
    // that this list is 3A's master-data read and not that report — two routes answering two row types:
    // the list row carries `updatedAt` and no `warehouseKind`, the report row the reverse.
    const list = await get(`/v1/companies/${s.company}/stock-on-hand`);
    expect(list.status).toBe(200);
    const listRow = ((await list.json()) as { items: Record<string, unknown>[] }).items[0]!;
    expect(listRow).toHaveProperty("updatedAt");
    expect(listRow).not.toHaveProperty("warehouseKind");
    const report = await get(`/v1/companies/${s.company}/reports/inventory.stock_on_hand`);
    expect(report.status).toBe(200);
    const reportRow = ((await report.json()) as { items: Record<string, unknown>[] }).items[0]!;
    expect(reportRow).toHaveProperty("warehouseKind");
    expect(reportRow).not.toHaveProperty("updatedAt");
  });

  it("another tenant's company is refused before any row is read (test 12)", async () => {
    const res = await get(`/v1/companies/${other.company}/stock-on-hand`);
    expect(res.status).toBe(403);
  });
});
