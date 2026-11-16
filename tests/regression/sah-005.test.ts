import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allocateLandedCostForDocument,
  createJobClient,
  JOBS,
  postDocument,
  withTenant,
  type JobClient,
} from "@dulja/db";
import {
  draftTypedDocument,
  grantCodes,
  installBoss,
  seedAccount,
  seedItem,
  seedParty,
  seedTenant,
  startDb,
  stopBoss,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import {
  ensureOpenPeriods,
  postInventoryDocument,
  recordingJobs,
} from "../invariants/support/post-inventory";
import { costingContext, type CostingFixture } from "./support/costing";

// 0B's `thinRegression` shape the 3B plan assumed is not what this file is: 0D wrote it as a full file whose
// two `it` bodies each bind a local `ctx`, and whose module scope already holds `db`, `jobs` and `seed`. The
// slice's shared fixture is therefore bound as `costing`, and the block below names nothing 0D's block names.
const costing = costingContext("005"); // ← this file's own SAH number

describe("SAH-005 transactional enqueue — 0D", () => {
  let db: Db;
  let boss: PgBoss;
  let jobs: JobClient;
  let seed: Seed;
  beforeAll(async () => {
    db = await startDb();
    seed = await seedTenant(db, "Alpha");
    boss = await installBoss(db, Object.keys(JOBS));
    jobs = createJobClient(boss);
  });
  afterAll(async () => {
    await stopBoss(boss);
    await db.stop();
  });

  const count = async (name: string) =>
    (
      await db.admin<
        { n: number }[]
      >`select count(*)::int as n from pgboss.job where name = ${name}`
    )[0]!.n;

  it("committed work and its job are atomic", async () => {
    const requestId = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      { tenantId: seed.tenant, actorId: seed.system, requestId },
      async (tx) => {
        await tx`update app.company set name = 'Alpha HQ (renamed)' where id = ${seed.company}`;
        // The replay's queue is stately, so the company key is required (contracts §4.2.6).
        await jobs.enqueue(
          tx,
          "inventory.cost.replay",
          { tenantId: seed.tenant, requestId, payload: { companyId: seed.company } },
          { singletonKey: seed.company },
        );
      },
    );
    expect(await count("inventory.cost.replay")).toBe(1);
  });

  it("rolled-back work leaves no phantom job", async () => {
    // A worker claims the replay queued above, as it would. The company's queued slot is then free, so the
    // enqueue below INSERTS a job — rather than collapsing into the queued one (§4.2.6), which would leave
    // nothing for the rollback to remove and this case with nothing to prove.
    const [claimed] = await boss.fetch("inventory.cost.replay");
    expect(claimed).toBeDefined();
    const before = await count("inventory.cost.replay");
    const requestId = await uuidv7(db.admin);
    await expect(
      withTenant(db.rw, { tenantId: seed.tenant, actorId: seed.system, requestId }, async (tx) => {
        await tx`update app.company set name = 'never committed' where id = ${seed.company}`;
        const id = await jobs.enqueue(
          tx,
          "inventory.cost.replay",
          { tenantId: seed.tenant, requestId, payload: { companyId: seed.company } },
          { singletonKey: seed.company },
        );
        expect(id).not.toBe(claimed!.id);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await count("inventory.cost.replay")).toBe(before);
    const rows = await withTenant(
      db.rw,
      { tenantId: seed.tenant, actorId: seed.system, requestId },
      (tx) => tx<{ name: string }[]>`select name from app.company where id = ${seed.company}`,
    );
    expect(rows[0]!.name).toBe("Alpha HQ (renamed)");
  });

  it("refuses to fail silently on singleton collision", async () => {
    const requestId = await uuidv7(db.admin);
    const ctx = { tenantId: seed.tenant, actorId: seed.system, requestId };
    const job = { tenantId: seed.tenant, requestId, payload: {} };
    await withTenant(db.rw, ctx, (tx) =>
      jobs.enqueue(tx, "accounting.period.month_end", job, { singletonKey: "sah-005-once" }),
    );
    await expect(
      withTenant(db.rw, ctx, (tx) =>
        jobs.enqueue(tx, "accounting.period.month_end", job, { singletonKey: "sah-005-once" }),
      ),
    ).rejects.toThrow(/did not insert job accounting\.period\.month_end/);
  });
});

describe("SAH-005 CstChanged never set on INSERT, so back-dated documents were never recosted — 3B", () => {
  // first proven by spec:242, spec:1220
  it("invalidation is STRUCTURAL — a row's own invalidated_at, never a flag set from three of four paths", async () => {
    const fixture = await costing.inventory();
    const cols = await fixture.db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name in ('cost_layer', 'cost_consumption')
         and column_name like '%changed%'`;
    expect(cols).toEqual([]); // there is no dirty flag to forget to set
  });
  it("a back-dated post enqueues the replay in the SAME transaction, or refuses to post", async () => {
    const fixture = await costing.inventory();
    const recorded = recordingJobs();
    await postInventoryDocument(fixture.db, fixture.s, {
      documentTypeId: fixture.receipt,
      warehouseId: fixture.warehouse,
      jobs: recorded,
      effectiveDate: "2026-03-01",
      lines: [
        {
          itemId: fixture.item,
          warehouseId: fixture.warehouse,
          quantity: "5.000000",
          unitPrice: "5.0000",
        },
      ],
    });
    await postInventoryDocument(fixture.db, fixture.s, {
      documentTypeId: fixture.receipt,
      warehouseId: fixture.warehouse,
      jobs: recorded,
      effectiveDate: "2026-02-01",
      lines: [
        {
          itemId: fixture.item,
          warehouseId: fixture.warehouse,
          quantity: "5.000000",
          unitPrice: "9.0000",
        },
      ],
    });
    // Exactly one replay across both posts — the forward one enqueues none. (Each post also enqueues 4B's
    // accounting.projection.rebuild, step 14's other clause, which is not this defect's subject.)
    expect(
      recorded.enqueued.map((j) => j.name).filter((name) => name === "inventory.cost.replay"),
    ).toEqual(["inventory.cost.replay"]);
  });
});

/** This file's 3C context. Module scope, not inside the `describe`: it captures nothing from that closure
 *  and `unicorn/consistent-function-scoping` refuses the inner form (the same reason `costing.ts` gives). */
const ctxOf = (s: { tenant: string; human: string }) => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: "sah-005-3c",
});

/**
 * A posted September SHIPMENT, then a DRAFT August one carrying a freight line that has already been
 * allocated — the state Task 9's back-dated case reaches just before its post, with the post removed.
 * File-local because §4.17.1 gives 3C no shared helper and hazard 9 forbids inventing one.
 *
 * The September document has to be posted FIRST: step 14 enqueues `inventory.cost.replay` only when an
 * already-posted movement of the same item carries a LATER effective_date, so without it `jobs.enqueued`
 * is empty and the first case asserts nothing (Task 9's own comment says the same).
 */
async function prepareBackDatedShipment(
  f: CostingFixture,
  code: string,
): Promise<{ documentId: string; costLineId: string }> {
  const { db, s, warehouse } = f;
  // `2150` is 3C's own account (Task 3) and `costingContext` does not seed it; `1300`, `5000` and `5900`
  // arrive with 3A's `seedItem`, which `costing.inventory()` already called. `seedAccount` is idempotent
  // on (company_id, code), so this is safe even if a later fixture seeds it too.
  await seedAccount(db, s, {
    code: "2150",
    nameEn: "Goods received not invoiced",
    type: "liability",
  });
  // `costingContext` grants only `accounting.journal.post` — so the two SHIPMENT receipt codes have to be
  // granted here or every post below is ERR_RBAC_FORBIDDEN at 2B's R2 trigger.
  await grantCodes(db, s, { codes: ["inventory.receipt.create", "inventory.receipt.post"] });
  // The party code is derived from `code` for the same reason the item code is: `app.party` carries
  // `unique (company_id, code)` and `seedParty` inserts without `on conflict`, so the two cases below
  // cannot share one literal.
  const partyId = await seedParty(db, s, { kind: "vendor", code: `${code}-VEND` });
  // The item code is a PARAMETER, so the two cases below never share a layer chain: each gets its own
  // September receipt and its own back-dated draft, and neither depends on the order Vitest runs them in.
  // trackLots: false — `seedItem` defaults it to TRUE (§4.6.1) and neither SHIPMENT line carries a lot.
  const { itemId, baseUnitId } = await seedItem(db, s, { code, trackLots: false });

  const [shipmentType] = await withTenant(
    db.rw,
    ctxOf(s),
    (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = 'SHIPMENT'`,
  );
  const [freightAccount] = await withTenant(
    db.rw,
    ctxOf(s),
    (tx) => tx<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = '5900'`,
  );

  const later = await draftTypedDocument(db, s, {
    documentTypeId: shipmentType!.id,
    series: "SHP",
    partyId,
    warehouseId: warehouse,
    effectiveDate: "2026-09-01",
    lines: [
      {
        kind: "item",
        itemId,
        unitId: baseUnitId,
        warehouseId: warehouse,
        quantity: "10.000000",
        unitPrice: "10.0000",
        amount: "100.0000",
      },
    ],
  });
  await withTenant(db.rw, ctxOf(s), (tx) =>
    postDocument(tx, ctxOf(s), { documentId: later.documentId, jobs: recordingJobs() }),
  );

  const back = await draftTypedDocument(db, s, {
    documentTypeId: shipmentType!.id,
    series: "SHP",
    partyId,
    warehouseId: warehouse,
    effectiveDate: "2026-08-01",
    lines: [
      {
        kind: "item",
        itemId,
        unitId: baseUnitId,
        warehouseId: warehouse,
        quantity: "10.000000",
        unitPrice: "10.0000",
        amount: "100.0000",
      },
      {
        kind: "account",
        accountId: freightAccount!.id,
        description: "airfreight",
        amount: "50.0000",
      },
    ],
  });
  await withTenant(db.rw, ctxOf(s), (tx) =>
    allocateLandedCostForDocument(tx, ctxOf(s), {
      documentId: back.documentId,
      allocations: [{ costLineId: back.lineIds[1]!, method: "by_value" }],
    }),
  );
  return { documentId: back.documentId, costLineId: back.lineIds[1]! };
}

describe("SAH-005 — 3C: a back-dated SHIPMENT enqueues its recost on the posting transaction, or posts nothing", () => {
  it("a rolled-back post leaves no movement, no layer and no job effect — but keeps the allocation", async () => {
    const f = await costing.inventory();
    await ensureOpenPeriods(f.db, f.s, 2026);
    const jobs = recordingJobs();
    const prepared = await prepareBackDatedShipment(f, "SAH005-SHP-A");

    await expect(
      withTenant(f.db.rw, ctxOf(f.s), async (tx) => {
        await postDocument(tx, ctxOf(f.s), { documentId: prepared.documentId, jobs });
        throw new Error("deliberate rollback"); // after the post, inside the same tx
      }),
    ).rejects.toThrow("deliberate rollback");

    const [after] = await withTenant(
      f.db.rw,
      ctxOf(f.s),
      (tx) => tx<{ movements: number; layers: number; allocations: number }[]>`
      select (select count(*)::int from app.inventory_movement where document_id = ${prepared.documentId}) as movements,
             (select count(*)::int from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
               where m.document_id = ${prepared.documentId}) as layers,
             (select count(*)::int from app.landed_cost_allocation where shipment_document_id = ${prepared.documentId}) as allocations`,
    );
    // The allocation was committed BEFORE the post, on the draft, so it survives — that is correct and is the
    // whole reason allocation is draft-only. The movement and the layer do not.
    expect(after).toEqual({ movements: 0, layers: 0, allocations: 1 });
    // The enqueue is asserted on the RECORDER, not on `pgboss.job`: `recordingJobs` never reaches pg-boss, so
    // a `select count(*) from pgboss.job` would read zero whatever happened and prove nothing. What the roll
    // back has to demonstrate is that the recorder *did* see the enqueue during the transaction — so the
    // enqueue and the movements were on one `tx` — and that the movements are gone all the same. 4B's
    // accounting.projection.rebuild (step 14, amendment 2) follows the replay on the same `tx`.
    expect(jobs.enqueued.map((j) => j.name)).toEqual([
      "inventory.cost.replay",
      "accounting.projection.rebuild",
    ]);
  });

  it("and a caller that supplies no JobClient is refused rather than silently skipping the recost", async () => {
    const f = await costing.inventory();
    await ensureOpenPeriods(f.db, f.s, 2026);
    const prepared = await prepareBackDatedShipment(f, "SAH005-SHP-B");
    await expect(
      withTenant(f.db.rw, ctxOf(f.s), (tx) =>
        postDocument(tx, ctxOf(f.s), { documentId: prepared.documentId }),
      ),
    ).rejects.toThrow(
      /is back-dated and needs a cost replay, but was posted through a caller that supplied no JobClient/,
    );
  });
});
