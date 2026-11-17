import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency } from "@dulja/domain";
// `@dulja/domain` is the one package specifier any file under `packages/db` may name (0b:5052); everything
// else is relative. The reach into `tests/invariants/support/**` is 3B's amendment A21(c) — the third named
// `dependency-rule` allowance, so three DB-tier costing suites post through the same real
// `postInventoryDocument` the invariant and regression suites use rather than a second copy of it.
import { openLayersFor } from "../../src/costing/apply-movements";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";
import {
  postInventoryDocument,
  recordingJobs,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";

const MYR = currency("MYR");

describe("applyMovements — the full body (contracts §4.7.2; spec:1216-1226)", () => {
  let db: Db;
  let s: Seed;
  let receiptType: string;
  let issueType: string;
  let itemId: string;
  let warehouseId: string;
  let cogs: string;
  let inventory: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Apply");
    // `grantCodes(db, s)` with no `codes` grants NOTHING (its docstring), and 2B's R2 evaluates both
    // fixture policies' `approval.post` inside the posting transaction.
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    receiptType = await seedDocumentType(db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    issueType = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    // trackLots: false — `seedItem` defaults it to TRUE (§4.6.1, food is batch-tracked) and `planMovements`
    // refuses a DECLARED receipt of a lot-tracked item that names no lot. The sentinel path is what this
    // suite exercises; the named-lot path is 3A's and 3D's.
    ({ itemId } = await seedItem(db, s, { code: "WIDGET", trackLots: false }));
    warehouseId = await seedWarehouse(db, s, { code: "MAIN" });
    const [accs] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ cogs: string; inv: string }[]>`
        select (select id::text from app.account where company_id = ${s.company} and code = '5000') as cogs,
               (select id::text from app.account where company_id = ${s.company} and code = '1300') as inv`,
    );
    cogs = accs!.cogs;
    inventory = accs!.inv;
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("a receipt writes one movement, one layer, no consumption, and document_line.cost", async () => {
    const jobs = recordingJobs();
    const { documentId } = await postInventoryDocument(db, s, {
      documentTypeId: receiptType,
      warehouseId,
      jobs,
      effectiveDate: "2026-02-01",
      lines: [{ itemId, warehouseId, quantity: "100.000000", unitPrice: "10.0000" }],
    });
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<
        {
          movements: number;
          value: string;
          layers: number;
          qty_in: string;
          unit_cost: string;
          qty_remaining: string;
          cons: number;
          cost: string;
          seq: string;
        }[]
      >`
        select (select count(*)::int from app.inventory_movement where document_id = ${documentId}) as movements,
               (select value::text from app.inventory_movement where document_id = ${documentId}) as value,
               (select count(*)::int from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
                 where m.document_id = ${documentId}) as layers,
               (select l.qty_in::text from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
                 where m.document_id = ${documentId}) as qty_in,
               (select l.unit_cost::text from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
                 where m.document_id = ${documentId}) as unit_cost,
               (select l.qty_remaining::text from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
                 where m.document_id = ${documentId}) as qty_remaining,
               (select count(*)::int from app.cost_consumption c join app.inventory_movement m on m.id = c.movement_id
                 where m.document_id = ${documentId}) as cons,
               (select cost::text from app.document_line where document_id = ${documentId} and line_no = 1) as cost,
               (select l.sequence::text from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
                 where m.document_id = ${documentId}) as seq`,
    );
    expect(row).toEqual({
      movements: 1,
      value: "1000.0000",
      layers: 1,
      qty_in: "100.000000",
      unit_cost: "10.0000",
      qty_remaining: "100.000000",
      cons: 0,
      cost: "1000.0000",
      seq: expect.any(String),
    });
  });

  it("an issue negates quantity and value, consumes the layer, and books COGS at the layer's cost", async () => {
    const jobs = recordingJobs();
    const { documentId } = await postInventoryDocument(db, s, {
      documentTypeId: issueType,
      warehouseId,
      jobs,
      effectiveDate: "2026-02-05",
      lines: [{ itemId, warehouseId, quantity: "30.000000", unitPrice: "25.0000" }],
    });
    const [mv] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ quantity: string; value: string }[]>`
        select quantity::text as quantity, value::text as value
          from app.inventory_movement where document_id = ${documentId}`,
    );
    // The line's unit_price is 25 — the SALE price. Cost is the LAYER's 10, and nothing else.
    expect(mv).toEqual({ quantity: "-30.000000", value: "-300.0000" });

    const [cons] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ quantity: string; unit_cost: string; value: string }[]>`
        select c.quantity::text as quantity, c.unit_cost::text as unit_cost, c.value::text as value
          from app.cost_consumption c join app.inventory_movement m on m.id = c.movement_id
         where m.document_id = ${documentId} and c.invalidated_at is null`,
    );
    expect(cons).toEqual({ quantity: "30.000000", unit_cost: "10.0000", value: "300.0000" });

    const ledger = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ account_id: string; debit: string; credit: string; exchange_rate: string }[]>`
        select account_id::text as account_id, debit::text as debit, credit::text as credit,
               exchange_rate::text as exchange_rate
          from app.ledger_entry where document_id = ${documentId} order by line_no`,
    );
    expect(ledger).toEqual([
      { account_id: cogs, debit: "300.0000", credit: "0.0000", exchange_rate: "1.00000000" },
      { account_id: inventory, debit: "0.0000", credit: "300.0000", exchange_rate: "1.00000000" },
    ]);
  });

  it("openLayersFor returns the residue in chronological order and nothing invalidated", async () => {
    const layers = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      openLayersFor(tx, { companyId: s.company, itemId, warehouseId, baseCurrency: MYR }),
    );
    expect(layers).toHaveLength(1);
    expect(layers[0]!.qtyRemaining.toString()).toBe("70.000000");
    expect(layers[0]!.unitCost.toString()).toBe("10.0000");
    expect(layers[0]!.lineNo).toBe(1);
    expect(layers[0]!.movementNo).toBe(1);
  });

  it("an issue the layers cannot cover is refused with ERR_STOCK_INSUFFICIENT and writes nothing", async () => {
    const jobs = recordingJobs();
    const before = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.inventory_movement where company_id = ${s.company}`,
    );
    await expect(
      postInventoryDocument(db, s, {
        documentTypeId: issueType,
        warehouseId,
        jobs,
        effectiveDate: "2026-02-06",
        lines: [{ itemId, warehouseId, quantity: "5000.000000", unitPrice: "25.0000" }],
      }),
    ).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
    const after = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.inventory_movement where company_id = ${s.company}`,
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("a back-dated document invalidates from its own key forward and enqueues exactly one replay", async () => {
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, {
      documentTypeId: receiptType,
      warehouseId,
      jobs,
      effectiveDate: "2026-01-15", // BEFORE the 2026-02-01 receipt
      lines: [{ itemId, warehouseId, quantity: "50.000000", unitPrice: "8.0000" }],
    });
    expect(jobs.enqueued).toEqual([
      { name: "inventory.cost.replay", payload: { companyId: s.company }, singletonKey: s.company },
      // 4B (step 14, amendment 2): every document with movements also enqueues the projection rebuild.
      {
        name: "accounting.projection.rebuild",
        payload: { companyId: s.company },
        singletonKey: s.company,
      },
    ]);
    const [counts] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ invalid_layers: number; valid_layers: number }[]>`
        select (select count(*)::int from app.cost_layer
                 where company_id = ${s.company} and invalidated_at is not null) as invalid_layers,
               (select count(*)::int from app.cost_layer
                 where company_id = ${s.company} and invalidated_at is null) as valid_layers`,
    );
    // The back-dated key is 2026-01-15, so the February layer IS at or after it and is invalidated; the
    // January layer this document just wrote is too, because the key is its own.
    expect(counts).toEqual({ invalid_layers: 2, valid_layers: 0 });
  });

  it("a back-dated document posted with no JobClient fail-closes rather than skipping the recost (LEGACY-005)", async () => {
    await expect(
      postInventoryDocument(db, s, {
        documentTypeId: receiptType,
        warehouseId,
        effectiveDate: "2026-01-10",
        lines: [{ itemId, warehouseId, quantity: "1.000000", unitPrice: "1.0000" }],
      }),
    ).rejects.toThrow(/ERR_INTERNAL.*back-dated.*no JobClient/s);
  });

  it("a forward-dated document enqueues no replay — only 4B's projection rebuild", async () => {
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, {
      documentTypeId: receiptType,
      warehouseId,
      jobs,
      effectiveDate: "2026-06-01",
      lines: [{ itemId, warehouseId, quantity: "1.000000", unitPrice: "1.0000" }],
    });
    expect(jobs.enqueued.map((j) => j.name)).toEqual(["accounting.projection.rebuild"]);
  });

  it("a lot-less line resolves the item's NONE sentinel, and a second tenant sees none of it (test 12)", async () => {
    const b = await seedTenantV2(db, "Apply-B");
    const [mine] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ sentinel: number }[]>`
        select count(*)::int as sentinel from app.inventory_movement m
          join app.lot l on l.id = m.lot_id
         where l.code = 'NONE' and m.company_id = ${s.company}`,
    );
    expect(mine!.sentinel).toBeGreaterThan(0);
    const [theirs] = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`
        select (select count(*)::int from app.cost_layer)
             + (select count(*)::int from app.cost_consumption) as n`,
    );
    expect(theirs!.n).toBe(0);
  });
});
