import { grantCodes } from "../fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWarehouse, updateWarehouse, warehouseTree } from "../../src/inventory/warehouses";
import { lintSchema } from "../../src/lint-schema";
import { seedTenant, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("app.warehouse — migration 0029 (contracts §4.6.1, SAH-071)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "WH A");
    await grantCodes(db, a);
    b = await seedTenant(db, "WH B");
    await grantCodes(db, b);
  });
  afterAll(async () => {
    await db.stop();
  });

  it("a warehouse carries a NOT NULL branch and defaults to kind 'stock'", async () => {
    const row = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createWarehouse(tx, {
        companyId: a.company,
        code: "HQ-MAIN",
        nameEn: "HQ main store",
        branchId: a.hq,
      }),
    );
    expect(row.kind).toBe("stock");
    expect(row.branchId).toBe(a.hq);
    expect(row.parentId).toBeNull();
  });

  it("branch_id is NOT NULL, so no warehouse can be branch-less (spec:1023, SAH-050 in the other direction)", async () => {
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.warehouse (tenant_id, company_id, code, name_en, branch_id)
      values (${a.tenant}, ${a.company}, 'NO-BRANCH', 'No branch', null)`,
      ),
    ).rejects.toThrow(/branch_id/);
  });

  it("kind is closed to stock | in_transit (spec:1053, §4.6.1)", async () => {
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.warehouse (tenant_id, company_id, code, name_en, kind, branch_id)
      values (${a.tenant}, ${a.company}, 'BAD-KIND', 'Bad', 'virtual', ${a.hq})`,
      ),
    ).rejects.toThrow(/warehouse_kind_check/);
  });

  it("a cycle in the tree is refused in ONE indexed check, not a procedure per row (SAH-071)", async () => {
    const { parent, child } = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const p = await createWarehouse(tx, {
        companyId: a.company,
        code: "T-P",
        nameEn: "Parent",
        branchId: a.hq,
      });
      const c = await createWarehouse(tx, {
        companyId: a.company,
        code: "T-C",
        nameEn: "Child",
        branchId: a.hq,
        parentId: p.id,
      });
      return { parent: p.id, child: c.id };
    });
    // self-parent
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        updateWarehouse(tx, parent, { parentId: parent }),
      ),
    ).rejects.toThrow(/ERR_WAREHOUSE_TREE_CYCLE/);
    // two-node cycle: parent becomes the child of its own child
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        updateWarehouse(tx, parent, { parentId: child }),
      ),
    ).rejects.toThrow(/ERR_WAREHOUSE_TREE_CYCLE/);
  });

  it("warehouseTree returns depth and path from one recursive CTE", async () => {
    const nodes = await withTenant(db.rw, a.tenant, a.human, (tx) => warehouseTree(tx, a.company));
    const child = nodes.find((n) => n.code === "T-C");
    expect(child?.depth).toBe(1);
    expect(child?.path).toEqual(["T-P", "T-C"]);
    expect(nodes.find((n) => n.code === "T-P")?.depth).toBe(0);
  });

  it("a second tenant sees no warehouse (test 12)", async () => {
    const [n] = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.warehouse`,
    );
    expect(n!.n).toBe(0);
  });

  it("lintSchema is clean and the warehouse restrictive branch policy is attached (§4.5.6)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    const [p] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_policies where schemaname = 'app' and tablename = 'warehouse'
        and policyname = 'branch_isolation' and permissive = 'RESTRICTIVE'`;
    // Migration 0068 attaches Form A″, including the bounded in-transit exception.
    expect(p!.n).toBe(1);
  });
});
