import { grantCodes } from "../fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Quantity } from "@dulja/domain";
import { EXPIRY_HORIZON_DAYS, listNearExpiryLots } from "../../src/inventory/expiry";
import { createLot, pickLotsFefo, sentinelLotId } from "../../src/inventory/lots";
import { seedItem, seedTenant, seedWarehouse, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("app.pick_lots_fefo — migration 0031 (the 3A card, SAH-067, ADR 0036)", () => {
  let db: Db;
  let a: Seed;
  let itemId: string;
  let warehouseId: string;
  const lots: Record<string, string> = {};

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "FEFO A");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    ({ itemId } = await seedItem(db, a, { code: "MILK-1L" }));
    warehouseId = await seedWarehouse(db, a, { code: "CHILL" });
    // Every expiry is in 2099, never in the build year: migration 0112 makes `pick_lots_fefo` skip a lot
    // whose `expires_on` is before `current_date` — the SERVER's today, not a document date — so a batch
    // dated "2026-07-31" became unpickable the day that date passed and every pick below returned the next
    // lot instead. The three batches keep their month-ends and their spacing (30 and 61 days from the
    // `asOf` of the near-expiry cases), which is all any assertion here depends on.
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      lots.late = (
        await createLot(tx, {
          companyId: a.company,
          itemId,
          code: "B-LATE",
          expiresOn: "2099-09-30",
        })
      ).id;
      lots.early = (
        await createLot(tx, {
          companyId: a.company,
          itemId,
          code: "B-EARLY",
          expiresOn: "2099-07-31",
        })
      ).id;
      lots.mid = (
        await createLot(tx, {
          companyId: a.company,
          itemId,
          code: "B-MID",
          expiresOn: "2099-08-31",
        })
      ).id;
      lots.none = await sentinelLotId(tx, itemId);
      // The projection is what FEFO reads (ADR 0036). Writing it by hand is legal here and nowhere in
      // production: packages/db/test/** is on posting-only-tables' allow-list (§3.7.5).
      for (const [key, qty] of [
        ["late", "40"],
        ["early", "10"],
        ["mid", "25"],
        ["none", "100"],
      ] as const) {
        await tx`insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
                 values (${a.tenant}, ${a.company}, ${itemId}, ${warehouseId}, ${lots[key]!}, ${qty})`;
      }
    });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("returns the earliest-expiring lot first — this slice's share of the Phase 3 DoD", async () => {
    const picks = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ lot_id: string; quantity: string }[]>`
        select lot_id, quantity::text from app.pick_lots_fefo(${itemId}, ${warehouseId}, 5.0)`,
    );
    expect(picks).toHaveLength(1);
    expect(picks[0]!.lot_id).toBe(lots.early);
    expect(picks[0]!.quantity).toBe("5.000000");
  });

  it("walks forward through lots in expiry order and stops when the quantity is met", async () => {
    const picks = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ lot_id: string; quantity: string }[]>`
        select lot_id, quantity::text from app.pick_lots_fefo(${itemId}, ${warehouseId}, 30.0)`,
    );
    expect(picks.map((p) => p.lot_id)).toEqual([lots.early, lots.mid]);
    expect(picks.map((p) => p.quantity)).toEqual(["10.000000", "20.000000"]);
  });

  it("a NULL expiry sorts last, so the sentinel lot is never picked ahead of a dated batch", async () => {
    const picks = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ lot_id: string }[]>`
        select lot_id from app.pick_lots_fefo(${itemId}, ${warehouseId}, 80.0)`,
    );
    expect(picks.map((p) => p.lot_id)).toEqual([lots.early, lots.mid, lots.late, lots.none]);
  });

  it("returns fewer rows than asked rather than raising — the refusal is the trigger's job", async () => {
    const picks = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ quantity: string }[]>`
        select quantity::text from app.pick_lots_fefo(${itemId}, ${warehouseId}, 1000.0)`,
    );
    const total = picks.reduce((sum, p) => sum + Number(p.quantity), 0);
    expect(total).toBe(175); // 10 + 25 + 40 + 100 — every open lot, and no more
  });

  it("a non-positive quantity is a caller error, not an empty result", async () => {
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`select * from app.pick_lots_fefo(${itemId}, ${warehouseId}, 0)`,
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: pick_lots_fefo needs a positive quantity/);
  });

  it("the ordering is total, so two identical calls return identical rows (SAH-067)", async () => {
    const once = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ lot_id: string; quantity: string }[]>`
        select lot_id, quantity::text from app.pick_lots_fefo(${itemId}, ${warehouseId}, 60.0)`,
    );
    const twice = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ lot_id: string; quantity: string }[]>`
        select lot_id, quantity::text from app.pick_lots_fefo(${itemId}, ${warehouseId}, 60.0)`,
    );
    expect(twice).toEqual(once);
  });

  it("pickLotsFefo returns Quantity values, never numbers, and the same order as the function", async () => {
    const picks = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      pickLotsFefo(tx, { itemId, warehouseId, quantity: Quantity.of("30.000000") }),
    );
    expect(picks.map((p) => p.lotId)).toEqual([lots.early, lots.mid]);
    expect(picks.map((p) => p.quantity.toString())).toEqual(["10.000000", "20.000000"]);
    expect(picks[0]!.quantity).toBeInstanceOf(Quantity);
  });

  it("pickLotsFefo on an item with only its sentinel lot returns that one lot", async () => {
    const { itemId: bolts } = await seedItem(db, a, { code: "BOLT-M8", trackLots: false });
    const sentinel = await withTenant(db.rw, a.tenant, a.human, (tx) => sentinelLotId(tx, bolts));
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
        values (${a.tenant}, ${a.company}, ${bolts}, ${warehouseId}, ${sentinel}, 50.000000)`,
    );
    const picks = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      pickLotsFefo(tx, { itemId: bolts, warehouseId, quantity: Quantity.of("5.000000") }),
    );
    expect(picks).toEqual([{ lotId: sentinel, quantity: Quantity.of("5.000000") }]);
  });

  it("listNearExpiryLots reports what expires inside the horizon, soonest first", async () => {
    const near = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listNearExpiryLots(tx, { companyId: a.company, horizonDays: 40, asOf: "2099-07-01" }),
    );
    expect(near.map((l) => l.lotCode)).toEqual(["B-EARLY"]); // 2099-07-31 is 30 days out; MID is 61
    expect(near[0]!.daysToExpiry).toBe(30);
    expect(near[0]!.quantity).toBe("10.000000");
    expect(near[0]!.warehouseCode).toBe("CHILL");
  });

  it("listNearExpiryLots ignores a lot with no stock and a lot with no expiry", async () => {
    const near = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listNearExpiryLots(tx, { companyId: a.company, horizonDays: 3650, asOf: "2099-07-01" }),
    );
    // Never the 'NONE' sentinel, which holds 100 units and has no expires_on to warn about.
    expect(near.map((l) => l.lotCode).toSorted()).toEqual(["B-EARLY", "B-LATE", "B-MID"]);
  });

  it("EXPIRY_HORIZON_DAYS is a reporting horizon and defaults to 30", async () => {
    expect(EXPIRY_HORIZON_DAYS).toBe(30);
    const near = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listNearExpiryLots(tx, { companyId: a.company, asOf: "2099-07-01" }),
    );
    expect(near.map((l) => l.lotCode)).toEqual(["B-EARLY"]);
  });

  it("an already-expired lot is never picked, however early it expired (migration 0112)", async () => {
    // Its own item, and LAST in the file, so no quantity or near-expiry list asserted above sees it. The
    // expired batch sorts FIRST by `expires_on` — exactly the shape 0031 got wrong — and holds more than
    // enough to fill the pick on its own.
    const { itemId: yogurt } = await seedItem(db, a, { code: "YOGURT-1" });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const gone = await createLot(tx, {
        companyId: a.company,
        itemId: yogurt,
        code: "Y-GONE",
        expiresOn: "2020-01-31",
      });
      const good = await createLot(tx, {
        companyId: a.company,
        itemId: yogurt,
        code: "Y-GOOD",
        expiresOn: "2099-01-31",
      });
      for (const [lotId, qty] of [
        [gone.id, "50"],
        [good.id, "8"],
      ] as const) {
        await tx`insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
                 values (${a.tenant}, ${a.company}, ${yogurt}, ${warehouseId}, ${lotId}, ${qty})`;
      }
      lots.yGood = good.id;
    });
    const picks = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ lot_id: string; quantity: string }[]>`
        select lot_id, quantity::text from app.pick_lots_fefo(${yogurt}, ${warehouseId}, 20.0)`,
    );
    // Short rather than expired: 8 of the 20 asked for, all from the good batch.
    expect(picks).toEqual([{ lot_id: lots.yGood, quantity: "8.000000" }]);
  });
});
