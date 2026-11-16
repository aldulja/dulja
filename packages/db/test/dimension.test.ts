import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import {
  createDimensionType,
  createDimensionValue,
  listDimensionTypes,
  listDimensionValues,
} from "../src/dimensions/service";
import { seedBranch, seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

describe("migration 0007 and the generic dimension service", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    b = await seedTenant(db, "Beta");
  });
  afterAll(async () => db.stop());

  it("adds nullable Arabic labels and keeps schema lint clean", async () => {
    const columns = await db.admin<{ table_name: string; is_nullable: string }[]>`
      select table_name, is_nullable from information_schema.columns
       where table_schema = 'app' and column_name = 'name_ar'
         and table_name in ('dimension_type', 'dimension_value')
       order by table_name`;
    expect(columns).toEqual([
      { table_name: "dimension_type", is_nullable: "YES" },
      { table_name: "dimension_value", is_nullable: "YES" },
    ]);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("preserves the original BRANCH seed", async () => {
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<{ code: string; name_en: string; name_ar: string | null }[]>`
        select code, name_en, name_ar from app.dimension_type where id = ${a.branchType}`,
    );
    expect(row).toEqual({ code: "BRANCH", name_en: "Branch", name_ar: null });
  });

  it("creates a type and a hierarchy without a schema change", async () => {
    const typeId = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createDimensionType(tx, {
        companyId: a.company,
        code: "COST_CENTRE",
        nameEn: "Cost centre",
        nameAr: "مركز التكلفة",
      }),
    );
    const north = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createDimensionValue(tx, {
        dimensionTypeId: typeId,
        code: "NORTH",
        nameEn: "Northern region",
        nameAr: "المنطقة الشمالية",
      }),
    );
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createDimensionValue(tx, {
        dimensionTypeId: typeId,
        code: "KL",
        nameEn: "Kuala Lumpur",
        parentId: north,
      }),
    );
    const types = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listDimensionTypes(tx, a.company),
    );
    expect(types.map((type) => type.code).toSorted()).toEqual(["BRANCH", "COST_CENTRE"]);
    const values = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listDimensionValues(tx, typeId, false),
    );
    expect(values.map((value) => [value.code, value.parentId])).toEqual([
      ["KL", north],
      ["NORTH", null],
    ]);
  });

  it("enforces codes unique within their owner", async () => {
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        createDimensionType(tx, { companyId: a.company, code: "BRANCH", nameEn: "again" }),
      ),
    ).rejects.toThrow(/unique|duplicate key/);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        createDimensionValue(tx, { dimensionTypeId: a.branchType, code: "HQ", nameEn: "again" }),
      ),
    ).rejects.toThrow(/unique|duplicate key/);
  });

  it("walks value trees with a recursive CTE", async () => {
    const rows = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<{ code: string; depth: number }[]>`
        with recursive tree as (
          select id, code, 0 as depth from app.dimension_value
           where parent_id is null and dimension_type_id in (
             select id from app.dimension_type
              where company_id = ${a.company} and code = 'COST_CENTRE')
          union all
          select value.id, value.code, tree.depth + 1
            from app.dimension_value value join tree on value.parent_id = tree.id)
        select code, depth from tree order by depth, code`,
    );
    expect(rows).toEqual([
      { code: "NORTH", depth: 0 },
      { code: "KL", depth: 1 },
    ]);
  });

  it("archives values instead of deleting", async () => {
    const id = await seedBranch(db, a, { code: "KLANG", nameEn: "Klang branch" });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.dimension_value set archived_at = now() where id = ${id}`,
    );
    const live = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listDimensionValues(tx, a.branchType, false),
    );
    const all = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listDimensionValues(tx, a.branchType, true),
    );
    expect(live.map((value) => value.code)).toEqual(["HQ"]);
    expect(all.map((value) => value.code).toSorted()).toEqual(["HQ", "KLANG"]);
  });

  it("isolates dimensions by tenant", async () => {
    expect(
      await withTenant(db.rw, b.tenant, b.human, (tx) => listDimensionTypes(tx, a.company)),
    ).toEqual([]);
    await expect(
      withTenant(db.rw, b.tenant, b.human, (tx) =>
        createDimensionValue(tx, { dimensionTypeId: a.branchType, code: "X", nameEn: "forged" }),
      ),
    ).rejects.toThrow();
  });

  it("keeps all foundation tables for the down migration owner", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables where table_schema = 'app'`;
    expect(row!.n).toBeGreaterThanOrEqual(25);
  });
});
