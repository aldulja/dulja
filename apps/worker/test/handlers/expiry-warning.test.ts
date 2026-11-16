import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLot, JOBS, withTenant } from "@dulja/db";
import { seedItem, seedTenant, grantCodes, seedWarehouse, type Seed } from "@dulja/db/test";
import { startWorker, type StartedWorker } from "../support/worker";

const day = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("inventory.lot.expiry_warning — the daily near-expiry alert (spec:1022, §4.2.6)", () => {
  let w: StartedWorker;
  let s: Seed;
  let itemId: string;
  let warehouseId: string;

  beforeAll(async () => {
    w = await startWorker();
    s = await seedTenant(w.db, "Expiry A");
    await grantCodes(w.db, s);
    ({ itemId } = await seedItem(w.db, s, { code: "YOG-500G", trackLots: true }));
    warehouseId = await seedWarehouse(w.db, s, { code: "CHILL" });
    await withTenant(
      w.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: "expiry-seed" },
      async (tx) => {
        const soon = await createLot(tx, {
          companyId: s.company,
          itemId,
          code: "B-SOON",
          expiresOn: day(5),
        });
        const later = await createLot(tx, {
          companyId: s.company,
          itemId,
          code: "B-LATER",
          expiresOn: day(400),
        });
        for (const lot of [soon.id, later.id]) {
          await tx`insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
                   values (${s.tenant}, ${s.company}, ${itemId}, ${warehouseId}, ${lot}, 12.000000)`;
        }
      },
    );
  }, 180_000);
  afterAll(async () => {
    await w.stop();
  });

  it("logs one warning per near-expiry lot and writes ONE audit row per company", async () => {
    w.logs.length = 0;
    await w.run("inventory.lot.expiry_warning", {
      tenantId: s.tenant,
      requestId: "expiry-run-1",
      payload: {},
    });
    // `StartedWorker.logs` is `CapturedLog[]` — `{ level, fields, msg }` — because `Logger.warn` takes the
    // message as its SECOND argument. The lot's own fields are under `fields`, never at the top level.
    const warned = w.logs.filter((l) => l.msg === "lot expiring soon");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.level).toBe("warn");
    expect(warned[0]!.fields).toMatchObject({ lot_code: "B-SOON", item_code: "YOG-500G" });
    const [audit] = await withTenant(
      w.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "check" },
      (tx) => tx<{ n: number; actor: string }[]>`
        select count(*)::int as n, max(actor_id::text) as actor from app.audit_log
         where table_name = 'lot_expiry_warning'`,
    );
    expect(audit!.n).toBe(1);
    expect(audit!.actor).toBe(s.system); // jobs run as the tenant's system principal (hazard 20)
  });

  it("a horizon in the payload widens the window", async () => {
    w.logs.length = 0;
    await w.run("inventory.lot.expiry_warning", {
      tenantId: s.tenant,
      requestId: "expiry-run-2",
      payload: { horizonDays: 500 },
    });
    expect(
      w.logs
        .filter((l) => l.msg === "lot expiring soon")
        .map((l) => l.fields["lot_code"] as string)
        .toSorted(),
    ).toEqual(["B-LATER", "B-SOON"]);
  });

  it("a company with nothing near expiry writes no audit row and logs nothing", async () => {
    const quiet = await seedTenant(w.db, "Expiry B");
    w.logs.length = 0;
    await w.run("inventory.lot.expiry_warning", {
      tenantId: quiet.tenant,
      requestId: "expiry-run-3",
      payload: {},
    });
    expect(w.logs.filter((l) => l.msg === "lot expiring soon")).toEqual([]);
    const [audit] = await withTenant(
      w.db.rw,
      { tenantId: quiet.tenant, actorId: quiet.system, requestId: "c" },
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.audit_log where table_name = 'lot_expiry_warning'`,
    );
    expect(audit!.n).toBe(0);
  });

  it("the job is scheduled daily at 06:00 and its name is in the closed registry", () => {
    expect(JOBS["inventory.lot.expiry_warning"]).toEqual({ schedule: "0 6 * * *", owner: "3A" });
  });
});
