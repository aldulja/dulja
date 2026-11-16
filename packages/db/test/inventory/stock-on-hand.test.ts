import { grantCodes } from "../fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectionChecks } from "../../src/integrity";
import { checkStockOnHandProjection } from "../../src/integrity/stock";
import { draftDocument, seedItem, seedTenant, seedWarehouse, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("stock_on_hand rebuild-and-compare — test 2's 3A re-run (contracts §4.7.3, §4.16.3)", () => {
  let db: Db;
  let a: Seed;
  let itemId: string;
  let warehouseId: string;
  let lotId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "SOH A");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    ({ itemId } = await seedItem(db, a, { code: "NAIL-3IN" }));
    warehouseId = await seedWarehouse(db, a, { code: "HQ-MAIN" });
    [lotId] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ id: string }[]>`select id from app.lot where item_id = ${itemId}`,
    ).then((r) => r.map((x) => x.id));
  });
  afterAll(async () => {
    await db.stop();
  });

  it("the registry now holds six checks, in a stable alphabetical order", () => {
    // Three when 3A wrote this; 3B's COST_LAYER_CHECK (its amendment A10) is the fourth and 4B's
    // ITEM_PROFITABILITY_CHECK (ADR 0046) the fifth, and `costing/layers.test.ts` and
    // `tests/invariants/projection-rebuild.test.ts` pin the same names; 8C's EMPLOYEE_YTD_CHECK is the sixth.
    expect(projectionChecks().map((c) => c.name)).toEqual([
      "account_balance",
      "cost_layer",
      "document_series",
      "employee_ytd",
      "item_profitability",
      "stock_on_hand",
    ]);
  });

  it("an untouched database has no mismatch", async () => {
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) => checkStockOnHandProjection(tx)),
    ).toEqual([]);
  });

  it("a projection row with no movements behind it is reported as missing_in_rebuild", async () => {
    // Written by hand, which only packages/db/test may do (§3.7.5's allow-list) — the point of the check
    // is to catch a projection that drifted from the movements, so the test has to make it drift.
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
        values (${a.tenant}, ${a.company}, ${itemId}, ${warehouseId}, ${lotId}, 7.000000)`,
    );
    const mismatches = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      checkStockOnHandProjection(tx),
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      projection: "stock_on_hand",
      side: "missing_in_rebuild",
      key: {
        company_id: a.company,
        item_id: itemId,
        warehouse_id: warehouseId,
        lot_id: lotId,
      },
    });
    expect(mismatches[0]!.detail).toMatch(/stock_on_hand has 7.000000 and the movements have none/);
  });

  it("a quantity that differs is reported as amount_differs, naming both figures", async () => {
    // The movement needs a document to belong to, and `seedTenant` drafts none: the `from app.document`
    // below over an empty table inserted NOTHING, and the case then saw only the missing_in_rebuild row.
    await draftDocument(db, a);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.inventory_movement
          (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
           quantity, value, effective_date, posting_seq)
        select ${a.tenant}, ${a.company}, d.id, 1, 1, ${itemId}, ${warehouseId}, ${lotId}, i.base_unit_id,
               5.000000, 50.0000, '2026-01-15', 1
          from app.document d, app.item i
         where i.id = ${itemId} limit 1`,
    );
    const mismatches = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      checkStockOnHandProjection(tx),
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ projection: "stock_on_hand", side: "amount_differs" });
    expect(mismatches[0]!.detail).toMatch(/quantity 7.000000 <> 5.000000/);
  });

  it("the rebuild leaves no scratch object behind, so a second call in one transaction is clean", async () => {
    // The plan's draft materialised the rebuild in `create temporary table … on commit drop`; this check
    // is one statement with a CTE instead, mirroring 1B's checkAccountBalanceProjection — AGENTS.md forbids
    // issuing DDL from application code, and 1B's own comment records that same replacement. Both halves of
    // the original claim still hold, which is what this case asserts: calling it twice inside one
    // transaction is safe, and nothing named after it survives anywhere in pg_tables.
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await checkStockOnHandProjection(tx);
      await checkStockOnHandProjection(tx);
    });
    const [temp] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_tables where tablename = 'integrity_rebuilt_stock_on_hand'`;
    expect(temp!.n).toBe(0);
  });
});
