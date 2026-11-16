import { grantCodes } from "../fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listStockOnHand } from "../../src/inventory/stock";
import { seedItem, seedLot, seedTenant, seedWarehouse, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("listStockOnHand — the read behind GET …/stock-on-hand", () => {
  let db: Db;
  let a: Seed;
  let itemId: string;
  let main: string;
  let chill: string;
  let lotId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Stock A");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    ({ itemId } = await seedItem(db, a, { code: "MILK-1L" }));
    main = await seedWarehouse(db, a, { code: "HQ-MAIN" });
    chill = await seedWarehouse(db, a, { code: "CHILL" });
    lotId = await seedLot(db, a, { itemId, code: "B-2026-04", expiresOn: "2026-10-31" });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      for (const [wh, lot, qty] of [
        [main, lotId, "40"],
        [chill, lotId, "0"],
      ] as const) {
        await tx`insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
                 values (${a.tenant}, ${a.company}, ${itemId}, ${wh}, ${lot}, ${qty})`;
      }
    });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("joins the names a screen needs and orders by item, warehouse, lot", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listStockOnHand(tx, { companyId: a.company, limit: 50 }),
    );
    expect(rows.map((r) => [r.itemCode, r.warehouseCode, r.lotCode, r.quantity])).toEqual([
      ["MILK-1L", "CHILL", "B-2026-04", "0.000000"],
      ["MILK-1L", "HQ-MAIN", "B-2026-04", "40.000000"],
    ]);
    expect(rows[0]!.expiresOn).toBe("2026-10-31");
  });

  it("nonZeroOnly drops a settled row, which is what a stock screen wants by default", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listStockOnHand(tx, { companyId: a.company, nonZeroOnly: true, limit: 50 }),
    );
    expect(rows.map((r) => r.warehouseCode)).toEqual(["HQ-MAIN"]);
  });

  it("filters by warehouse and by lot, and pages on the full ordering key", async () => {
    const byWarehouse = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listStockOnHand(tx, { companyId: a.company, warehouseId: main, limit: 50 }),
    );
    expect(byWarehouse).toHaveLength(1);
    const byLot = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listStockOnHand(tx, { companyId: a.company, lotId, limit: 50 }),
    );
    expect(byLot).toHaveLength(2);
    const page = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listStockOnHand(tx, { companyId: a.company, limit: 1 }),
    );
    const next = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listStockOnHand(tx, {
        companyId: a.company,
        limit: 1,
        cursor: {
          itemCode: page[0]!.itemCode,
          warehouseCode: page[0]!.warehouseCode,
          lotCode: page[0]!.lotCode,
        },
      }),
    );
    expect(next[0]!.warehouseCode).toBe("HQ-MAIN");
  });
});
