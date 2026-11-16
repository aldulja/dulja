import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SENTINEL_LOT_CODE, createLot, listLots, sentinelLotId } from "../../src/inventory/lots";
import { seedItem, seedTenant, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("app.lot and the per-item sentinel — migration 0029 (SAH-050, ADR 0034)", () => {
  let db: Db;
  let a: Seed;
  let itemId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Lot A");
    ({ itemId } = await seedItem(db, a, { code: "MILK-1L" }));
  });
  afterAll(async () => {
    await db.stop();
  });

  it("every item is created with exactly one sentinel lot coded NONE, by trigger", async () => {
    const rows = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ code: string; expires_on: string | null }[]>`
        select code, expires_on from app.lot where item_id = ${itemId} order by code`,
    );
    expect(rows.map((r) => r.code)).toEqual([SENTINEL_LOT_CODE]);
    expect(rows[0]!.expires_on).toBeNull();
  });

  it("EVERY item has a sentinel — the trigger's invariant, asserted over the whole table", async () => {
    // Migration 0029 deliberately carries no back-fill statement: FORCE RLS binds app_migrator too, so a
    // migration with no tenant set sees zero rows and could never insert one (§3.4.8 — only app.permission
    // is migration data). The guarantee is the AFTER INSERT trigger, and this is where it is checked, inside
    // `withTenant` where there are rows to check. `stock_on_hand`'s primary key contains `lot_id`, so an
    // item without a sentinel would fail the step-12 MERGE much later (SAH-050).
    const [gap] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.item i
       where not exists (select 1 from app.lot l where l.item_id = i.id and l.code = ${SENTINEL_LOT_CODE})`,
    );
    expect(gap!.n).toBe(0);
  });

  it("sentinelLotId finds it and is stable across calls", async () => {
    const first = await withTenant(db.rw, a.tenant, a.human, (tx) => sentinelLotId(tx, itemId));
    const second = await withTenant(db.rw, a.tenant, a.human, (tx) => sentinelLotId(tx, itemId));
    expect(first).toBe(second);
  });

  it("a real lot carries expiry and cannot expire before it was made", async () => {
    const lot = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createLot(tx, {
        companyId: a.company,
        itemId,
        code: "B-2026-01",
        manufacturedOn: "2026-01-05",
        expiresOn: "2026-07-05",
      }),
    );
    expect(lot.expiresOn).toBe("2026-07-05");
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        createLot(tx, {
          companyId: a.company,
          itemId,
          code: "B-BAD",
          manufacturedOn: "2026-07-05",
          expiresOn: "2026-01-05",
        }),
      ),
    ).rejects.toThrow(/lot_expiry_after_manufacture_check/);
  });

  it("(item_id, code) is unique, so the same batch cannot be entered twice", async () => {
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        createLot(tx, { companyId: a.company, itemId, code: "B-2026-01" }),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("listLots can filter to lots expiring before a date, sentinel excluded by its null expiry", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listLots(tx, { companyId: a.company, itemId, expiringBefore: "2026-12-31", limit: 10 }),
    );
    expect(rows.map((r) => r.code)).toEqual(["B-2026-01"]);
  });
});
