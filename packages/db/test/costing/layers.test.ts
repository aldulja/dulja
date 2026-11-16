import { grantCodes } from "../fixtures";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Relative imports, never `@dulja/db*`: 0B's `dependency-rule` pins `"packages/db": ["@dulja/domain"]`
// and keys the owner on the path prefix `packages/db/`, so `test/**` is in its scope too — `@dulja/domain`
// is the only package specifier any file under `packages/db` may name (0b:5052, 0b:5091), and a
// `@dulja/db` self-import is reported like any other. 1A's and 3A's suites in this very directory import
// `../fixtures`, `../harness` and `../../src/**` for exactly this reason (3a:237–241, 3a:2920–2924).
import { COST_LAYER_CHECK, projectionChecks, runIntegrityCheck } from "../../src/integrity";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
import { seedItem, seedLot, seedTenantV2, seedWarehouse, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/**
 * A draft document to hang a movement on. Plan 0A's `draftDocument(db, s)` fixture does the same job and is
 * used elsewhere in this slice, but it opens its OWN `withTenant`, and this row must land on the same `tx`
 * as the movement insert below — the movement's FK `(tenant_id, document_id)` is checked inside that
 * transaction. So the insert is written out here rather than delegated.
 */
async function draftFor(tx: Sql, s: Seed): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.document (tenant_id, company_id, document_type_id, posting_policy_id, series, fiscal_period_id, effective_date, currency, branch_id)
    values (${s.tenant}, ${s.company}, ${s.docType}, ${s.policy}, 'JV', ${s.period}, '2026-01-10', 'MYR', ${s.hq})
    returning id::text as id`;
  return row!.id;
}

describe("migration 0034 — cost_layer, cost_consumption, stock_valuation (contracts §4.7.3, §4.6.1; spec:1210, 1216-1221)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    b = await seedTenantV2(db, "Beta");
    await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
  });
  afterAll(async () => {
    await db.stop();
  });

  it("the schema linter reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("the three tables are in the sets contracts §3.5.3 assigns them, and in no others", () => {
    // cost_layer and cost_consumption were forward-declared in plan0A's AUDIT_EXEMPT; stock_valuation is
    // added by this task's edit to lint-schema.ts.
    expect(AUDIT_EXEMPT.has("cost_layer")).toBe(true);
    expect(AUDIT_EXEMPT.has("cost_consumption")).toBe(true);
    expect(AUDIT_EXEMPT.has("stock_valuation")).toBe(true);
    // Derived, not immutable — the posting service and the replay both UPDATE qty_remaining (spec:1210, 1993).
    expect(IMMUTABLE.has("cost_layer")).toBe(false);
    expect(IMMUTABLE.has("cost_consumption")).toBe(false);
    expect(IMMUTABLE.has("stock_valuation")).toBe(false);
  });

  it("app_rw may select, insert and update a layer but never delete one (contracts §3.5.4)", async () => {
    const held = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'cost_layer' order by 1`;
    expect(held.map((h) => h.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("a layer round-trips and qty_remaining refuses to go negative", async () => {
    // `baseUnitId` is destructured here, not fetched by seeding a SECOND item: `seedItem` returns both, and
    // a second row created only to read a unit id back would also be created on a different transaction
    // from the `withTenant` block below, inside a tagged-template argument.
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "ITEM-1" });
    const warehouseId = await seedWarehouse(db, a, { code: "WH-1" });
    const lotId = await seedLot(db, a, { itemId, code: "L1" });
    const movementId = await uuidv7(db.admin);
    const layerId = await uuidv7(db.admin);

    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      // A layer needs a movement to point at; the movement itself is 3A's table and applyMovements is its
      // only writer in production — this test writes one directly as app_migrator to isolate the DDL under
      // test. The document is created on this same `tx` (see `draftFor` above).
      const documentId = await draftFor(tx, a);
      await tx`insert into app.inventory_movement
        (id, tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
        values (${movementId}, ${a.tenant}, ${a.company}, ${documentId}, 1, 1, ${itemId}, ${warehouseId},
                ${lotId}, ${baseUnitId}, '10.000000', '100.0000', '2026-01-10', 1)`;
      await tx`insert into app.cost_layer
        (id, tenant_id, company_id, item_id, warehouse_id, lot_id, movement_id, qty_in, unit_cost, value, qty_remaining, effective_at, sequence)
        values (${layerId}, ${a.tenant}, ${a.company}, ${itemId}, ${warehouseId}, ${lotId}, ${movementId},
                '10.000000', '10.0000', '100.0000', '10.000000', '2026-01-10', 1)`;
    });

    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.cost_layer set qty_remaining = '-0.000001' where id = ${layerId}`,
      ),
    ).rejects.toThrow(/cost_layer_qty_remaining_check/);

    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.cost_layer set unit_cost = '-0.0001' where id = ${layerId}`,
      ),
    ).rejects.toThrow(/cost_layer_unit_cost_check/);
  });

  it("the exact receipt value is required and cannot be negative", async () => {
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.cost_layer set value = '-0.0001'`),
    ).rejects.toThrow(/cost_layer_value_check/);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.cost_layer set value = null`),
    ).rejects.toThrow(/null value in column "value"/);
  });

  it("one movement can carry only one layer (contracts §4.7.3 unique (movement_id))", async () => {
    const [row] = await withTenant(
      db.migrator,
      a.tenant,
      a.system,
      (tx) =>
        tx<{ movement_id: string; item_id: string; warehouse_id: string; lot_id: string }[]>`
        select movement_id::text, item_id::text, warehouse_id::text, lot_id::text from app.cost_layer limit 1`,
    );
    await expect(
      withTenant(
        db.migrator,
        a.tenant,
        a.system,
        (tx) => tx`
      insert into app.cost_layer (tenant_id, company_id, item_id, warehouse_id, lot_id, movement_id, qty_in, unit_cost, value, qty_remaining, effective_at, sequence)
      values (${a.tenant}, ${a.company}, ${row!.item_id}, ${row!.warehouse_id}, ${row!.lot_id}, ${row!.movement_id},
              '1.000000', '1.0000', '1.0000', '1.000000', '2026-01-11', 2)`,
      ),
    ).rejects.toThrow(/cost_layer_movement_id_key/);
  });

  it("all three tables carry the composite (tenant_id, company_id) FK to app.company (amendment A23)", async () => {
    // Plan 0A's `composite_fk` rule only inspects the FKs a table HAS, so the linter case above stays green
    // whether or not this key exists — which is why it is asserted by name. `cost_consumption`'s is the one
    // §4.7.3's block omits and amendment A23 restores.
    // Two shapes to keep: the schema and table name come from `pg_class`/`pg_namespace` rather than from
    // `conrelid::regclass::text`, which drops the schema whenever `app` is on the connection's search_path;
    // and `att.attname` is cast to `text` before the comparison, because `array_agg(name)` is `name[]` and
    // `name[] = text[]` has no operator. `'app.company'::regclass` as an INPUT is search_path-independent.
    const held = await db.admin<{ table_name: string }[]>`
      select n.nspname || '.' || cl.relname as table_name
        from pg_constraint c
        join pg_class     cl on cl.oid = c.conrelid
        join pg_namespace n  on n.oid  = cl.relnamespace
       where c.contype = 'f' and c.confrelid = 'app.company'::regclass
         and n.nspname = 'app'
         and cl.relname in ('cost_layer', 'cost_consumption', 'stock_valuation')
         and (select array_agg(att.attname::text order by att.attname)
                from unnest(c.conkey) as k
                join pg_attribute att on att.attrelid = c.conrelid and att.attnum = k)
             = array['company_id', 'tenant_id']
       order by 1`;
    expect(held.map((h) => h.table_name)).toEqual([
      "app.cost_consumption",
      "app.cost_layer",
      "app.stock_valuation",
    ]);
  });

  it("tenant B sees none of tenant A's layers, consumptions or valuation rows (spec:106, test 12)", async () => {
    const counts = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ layers: number; cons: number; val: number }[]>`
      select (select count(*)::int from app.cost_layer)       as layers,
             (select count(*)::int from app.cost_consumption) as cons,
             (select count(*)::int from app.stock_valuation)  as val`,
    );
    expect(counts[0]).toEqual({ layers: 0, cons: 0, val: 0 });
  });

  it("stock_valuation is keyed by (company, item, warehouse, as_of) and has no id column", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'stock_valuation' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "as_of",
      "company_id",
      "created_at",
      "item_id",
      "quantity",
      "tenant_id",
      "updated_at",
      "value",
      "warehouse_id",
    ]);
  });

  describe("COST_LAYER_CHECK — cost_layer joins the projection registry (test 2 re-run; amendment A10)", () => {
    // `runIntegrityCheck(tx, ctx, opts)` takes the TENANT CONTEXT second and its options third — it reads
    // ctx.tenantId for the audit-chain walk and ctx.requestId for the report. Passing `{ companyId }` in the
    // second position puts the company in the ctx slot and the check walks nothing.
    const integrityCtx = async () => ({
      tenantId: a.tenant,
      actorId: a.system,
      requestId: await uuidv7(db.admin),
    });

    // 4B's ITEM_PROFITABILITY_CHECK (ADR 0046) is the fifth, registered after this file was written.
    it("the registry is exactly these six, alphabetically (8C added employee_ytd)", () => {
      expect(projectionChecks().map((c) => c.name)).toEqual([
        "account_balance",
        "cost_layer",
        "document_series",
        "employee_ytd",
        "item_profitability",
        "stock_on_hand",
      ]);
      expect(COST_LAYER_CHECK.name).toBe("cost_layer");
    });

    it("a clean company reports no mismatch", async () => {
      const ctx = await integrityCtx();
      const report = await withTenant(db.rw, a.tenant, a.system, (tx) =>
        runIntegrityCheck(tx, ctx, { companyId: a.company }),
      );
      expect(report.projections.checked).toEqual([
        "account_balance",
        "cost_layer",
        "document_series",
        "employee_ytd",
        "item_profitability",
        "stock_on_hand",
      ]);
      expect(report.projections.mismatches.filter((m) => m.projection === "cost_layer")).toEqual(
        [],
      );
    });

    it("a layer whose qty_remaining drifts from qty_in minus its valid consumptions is a mismatch", async () => {
      const [layer] = await withTenant(
        db.migrator,
        a.tenant,
        a.system,
        (tx) => tx<{ id: string }[]>`
        update app.cost_layer set qty_remaining = qty_remaining + '1.000000'
         where invalidated_at is null returning id::text as id`,
      );
      const ctx = await integrityCtx();
      const report = await withTenant(db.rw, a.tenant, a.system, (tx) =>
        runIntegrityCheck(tx, ctx, { companyId: a.company }),
      );
      const found = report.projections.mismatches.filter((m) => m.projection === "cost_layer");
      expect(found).toHaveLength(1);
      // the layer exists on both sides; only the residue differs
      expect(found[0]!.side).toBe("amount_differs");
      expect(found[0]!.key).toEqual({ layerId: layer!.id });
      expect(found[0]!.detail).toMatch(new RegExp(`layer ${layer!.id}`));
      expect(found[0]!.detail).toMatch(/qty_remaining .* does not equal qty_in .* minus/);
      await withTenant(
        db.migrator,
        a.tenant,
        a.system,
        (tx) =>
          tx`update app.cost_layer set qty_remaining = qty_remaining - '1.000000' where id = ${layer!.id}`,
      );
    });

    it("an invalidated layer is skipped — mid-replay is not a mismatch", async () => {
      const [layer] = await withTenant(
        db.migrator,
        a.tenant,
        a.system,
        (tx) => tx<{ id: string }[]>`
        update app.cost_layer set invalidated_at = now(), qty_remaining = '99999.000000'
         where invalidated_at is null returning id::text as id`,
      );
      const ctx = await integrityCtx();
      const report = await withTenant(db.rw, a.tenant, a.system, (tx) =>
        runIntegrityCheck(tx, ctx, { companyId: a.company }),
      );
      expect(report.projections.mismatches.filter((m) => m.projection === "cost_layer")).toEqual(
        [],
      );
      await withTenant(
        db.migrator,
        a.tenant,
        a.system,
        (tx) =>
          tx`update app.cost_layer set invalidated_at = null, qty_remaining = qty_in where id = ${layer!.id}`,
      );
    });
  });
});
