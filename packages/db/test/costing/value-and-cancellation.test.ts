import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  postInventoryDocument,
  recordingJobs,
  STOCK_RECEIPT_COST_POLICY,
  STOCK_ISSUE_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import { openLayersOf, valuationAsOf, rebuildStockValuation } from "../../src/costing/valuation";
import { replay } from "../../src/costing/replay";
import { reverseDocument } from "../../src/posting/reverse";
import { loadDocumentTypes } from "../../src/seed/document-types";
import { withTenant } from "../../src/with-tenant";
import { down, listApplied, up } from "../../src/migrate";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, MIGRATIONS_DIR, type Db } from "../harness";

const TYPES = fileURLToPath(new URL("../../seed/my/document-types", import.meta.url));
const MYR = currency("MYR");
interface World {
  s: Seed;
  itemId: string;
  warehouseId: string;
  receipt: string;
  issue: string;
}
const context = (w: World) => ({
  tenantId: w.s.tenant,
  actorId: w.s.human,
  requestId: "costing-remediation",
});

describe("exact layer values and source-specific purchase cancellation", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  async function world(name: string, method: "avco" | "fifo" = "avco"): Promise<World> {
    const s = await seedTenantV2(db, name);
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    await loadDocumentTypes(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      TYPES,
      (await db.admin<{ code: string }[]>`select code from app.permission`).map((p) => p.code),
    );
    await withTenant(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: "method" },
      (tx) => tx`update app.company set costing_method = ${method} where id = ${s.company}`,
    );
    const receipt = await seedDocumentType(db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    const issue = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    const { itemId } = await seedItem(db, s, { code: "EXACT", trackLots: false });
    return {
      s,
      receipt,
      issue,
      itemId,
      warehouseId: await seedWarehouse(db, s, { code: "EXACT-WH" }),
    };
  }
  async function post(w: World, type: string, quantity: string, price: string, date: string) {
    return postInventoryDocument(db, w.s, {
      documentTypeId: type,
      warehouseId: w.warehouseId,
      effectiveDate: date,
      jobs: recordingJobs(),
      lines: [{ itemId: w.itemId, warehouseId: w.warehouseId, quantity, unitPrice: price }],
    });
  }
  async function reverse(w: World, documentId: string, effectiveDate: string) {
    return withTenant(db.rw, context(w), (tx) =>
      reverseDocument(tx, context(w), {
        documentId,
        effectiveDate,
        reason: "cancel untouched purchase",
      }),
    );
  }
  async function runReplay(w: World) {
    const ctx = { ...context(w), actorId: w.s.system };
    return replay(
      db.rw,
      { tenantId: w.s.tenant, requestId: ctx.requestId, payload: { companyId: w.s.company } },
      ctx,
    );
  }
  async function value(w: World, asOf = "2026-01-31") {
    return withTenant(db.rw, context(w), async (tx) => {
      const [row] = await valuationAsOf(tx, { companyId: w.s.company, asOf, limit: 100 });
      const [ledger] = await tx<
        { value: string }[]
      >`select coalesce(sum(e.base_debit - e.base_credit), 0)::numeric(19,4)::text as value
        from app.ledger_entry e join app.account a on a.id = e.account_id where e.company_id = ${w.s.company} and a.code = '1300'`;
      return {
        quantity: row?.quantity ?? "0.000000",
        value: row?.value ?? "0.0000",
        ledger: ledger!.value,
      };
    });
  }
  async function state(w: World) {
    return withTenant(db.rw, context(w), async (tx) => {
      const [row] = await tx<
        { documents: number; movements: number; ledger: number; audit: number }[]
      >`
        select (select count(*)::int from app.document where company_id = ${w.s.company}) as documents,
          (select count(*)::int from app.inventory_movement where company_id = ${w.s.company}) as movements,
          (select count(*)::int from app.ledger_entry where company_id = ${w.s.company}) as ledger,
          (select count(*)::int from app.audit_log) as audit`;
      return row;
    });
  }

  it.each(["avco", "fifo"] as const)(
    "%s cancels the source at its original value, preserves history and replays a reversal chain",
    async (method) => {
      const w = await world(`cancel-${method}`, method);
      await post(w, w.receipt, "100", "10", "2026-01-10");
      const second = await post(w, w.receipt, "100", "20", "2026-01-20");
      const cancelled = await reverse(w, second.documentId, "2026-01-25");
      expect(await value(w)).toEqual({
        quantity: "100.000000",
        value: "1000.0000",
        ledger: "1000.0000",
      });
      expect((await value(w, "2026-01-24")).value).toBe("3000.0000");
      await withTenant(db.rw, context(w), async (tx) => {
        const layers = await openLayersOf(tx, {
          companyId: w.s.company,
          itemId: w.itemId,
          asOf: "2026-01-31",
          limit: 100,
        });
        expect(layers.map((l) => l.value)).toEqual(["1000.0000", "0.0000"]);
        expect(
          (await rebuildStockValuation(tx, { companyId: w.s.company, asOf: "2026-01-31" }))
            .mismatches,
        ).toEqual([]);
      });
      const reinstated = await reverse(w, cancelled.reversalDocumentId, "2026-01-26");
      expect((await value(w)).value).toBe("3000.0000");
      await reverse(w, reinstated.reversalDocumentId, "2026-01-27");
      expect((await value(w)).value).toBe("1000.0000");
      await post(w, w.receipt, "10", "11", "2026-01-05");
      await runReplay(w);
      expect(await value(w)).toEqual({
        quantity: "110.000000",
        value: "1110.0000",
        ledger: "1110.0000",
      });
      expect(await runReplay(w)).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });
    },
  );

  it.each(["avco", "fifo"] as const)(
    "%s preserves a three-unit receipt worth exactly ten through historical reads and depletion",
    async (method) => {
      const w = await world(`thirds-${method}`, method);
      await postInventoryDocument(db, w.s, {
        documentTypeId: w.receipt,
        warehouseId: w.warehouseId,
        effectiveDate: "2026-01-10",
        jobs: recordingJobs(),
        lines: [
          { itemId: w.itemId, warehouseId: w.warehouseId, quantity: "3", unitPrice: "3.3333" },
        ],
        beforePost: async (tx, documentId) => {
          await tx`update app.document_line set amount = '10.0000' where document_id = ${documentId}`;
        },
      });
      const values: string[] = [];
      for (const date of ["2026-01-11", "2026-01-12", "2026-01-13"]) {
        const issued = await post(w, w.issue, "1", "30", date);
        const [movement] = await withTenant(
          db.rw,
          context(w),
          (tx) =>
            tx<
              { value: string }[]
            >`select abs(value)::text as value from app.inventory_movement where document_id = ${issued.documentId}`,
        );
        values.push(movement!.value);
        const after = await value(w);
        expect(after.value).toBe(after.ledger);
      }
      expect(values).toEqual(["3.3333", "3.3334", "3.3333"]);
      expect((await value(w, "2026-01-10")).value).toBe("10.0000");
      expect((await value(w, "2026-01-11")).value).toBe("6.6667");
      expect((await value(w, "2026-01-12")).value).toBe("3.3333");
      await post(w, w.receipt, "1", "2", "2026-01-05");
      await runReplay(w);
      const afterReplay = await value(w);
      expect(afterReplay.value).toBe(afterReplay.ledger);
      expect(await runReplay(w)).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });
    },
  );

  /** Σ base debit − credit on 5000, the cost of goods sold the ledger carries. */
  async function cogs(w: World) {
    const [row] = await withTenant(
      db.rw,
      context(w),
      (tx) =>
        tx<
          { value: string }[]
        >`select coalesce(sum(e.base_debit - e.base_credit), 0)::numeric(19,4)::text as value
        from app.ledger_entry e join app.account a on a.id = e.account_id where e.company_id = ${w.s.company} and a.code = '5000'`,
    );
    return row!.value;
  }
  async function lineCost(w: World, documentId: string) {
    const [row] = await withTenant(
      db.rw,
      context(w),
      (tx) =>
        tx<
          { cost: string }[]
        >`select cost::text as cost from app.document_line where document_id = ${documentId} and line_no = 1`,
    );
    return row!.cost;
  }

  // INV-02 (2026-11-15 review): the reversal of an issue is a receipt priced from the issue's cost (§4.7.2
  // branch 1). A replay that recosts the issue must re-price that receipt from the issue's new cost, or the
  // returned goods keep the stale value and COGS keeps a figure for a sale that was fully reversed.
  it.each([
    ["avco", "15.0000"],
    ["fifo", "20.0000"],
  ] as const)(
    "%s re-prices a reversed issue's receipt from the issue's recomputed cost (INV-02)",
    async (method, recosted) => {
      const w = await world(`rev-recost-${method}`, method);
      await post(w, w.receipt, "1", "10", "2026-01-10");
      const sale = await post(w, w.issue, "1", "30", "2026-01-15");
      const reversal = await reverse(w, sale.documentId, "2026-01-16");
      expect(await cogs(w)).toBe("0.0000");
      await post(w, w.receipt, "1", "20", "2026-01-05");
      await runReplay(w);
      expect({ ...(await value(w)), cogs: await cogs(w) }).toEqual({
        quantity: "2.000000",
        value: "30.0000",
        ledger: "30.0000",
        cogs: "0.0000",
      });
      // The pair moves together: the sale's current cost and its mirror's are the same recomputed figure.
      expect(await lineCost(w, sale.documentId)).toBe(recosted);
      expect(await lineCost(w, reversal.reversalDocumentId)).toBe(recosted);
      await withTenant(db.rw, context(w), async (tx) => {
        expect(
          (await rebuildStockValuation(tx, { companyId: w.s.company, asOf: "2026-01-31" }))
            .mismatches,
        ).toEqual([]);
      });
      expect(await runReplay(w)).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });

      // The reversal's own reversal re-issues the goods from the layers, and a second back-dated receipt
      // recosts all three movements again: the ledger and the layers still tie, and COGS is the re-sale's.
      const resold = await reverse(w, reversal.reversalDocumentId, "2026-01-17");
      await post(w, w.receipt, "1", "40", "2026-01-04");
      await runReplay(w);
      const after = await value(w);
      expect(after).toMatchObject({ quantity: "2.000000", value: after.ledger });
      expect(await cogs(w)).toBe(await lineCost(w, resold.reversalDocumentId));
      expect(await lineCost(w, reversal.reversalDocumentId)).toBe(
        await lineCost(w, sale.documentId),
      );
      expect(await runReplay(w)).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });
    },
  );

  it("re-prices a multi-unit reversal and books nothing when the pair nets to zero (INV-02)", async () => {
    const w = await world("rev-recost-units");
    await post(w, w.receipt, "3", "10", "2026-01-10");
    const sale = await post(w, w.issue, "3", "30", "2026-01-15");
    await reverse(w, sale.documentId, "2026-01-16");
    await post(w, w.receipt, "1", "20", "2026-01-05");
    const result = await runReplay(w);
    // The sale moved +7.50 and its mirror −7.50 in the same period and branch: no adjustment document.
    expect(result.adjustmentsPosted).toEqual([]);
    expect({ ...(await value(w)), cogs: await cogs(w) }).toEqual({
      quantity: "4.000000",
      value: "50.0000",
      ledger: "50.0000",
      cogs: "0.0000",
    });
  });

  it("refuses cancellation dated before its receipt and preserves replayable history", async () => {
    const w = await world("before-source");
    const receipt = await post(w, w.receipt, "10", "20", "2026-01-20");
    const before = await state(w);
    await expect(reverse(w, receipt.documentId, "2026-01-15")).rejects.toMatchObject({
      code: "ERR_VALIDATION_FAILED",
    });
    expect(await state(w)).toEqual(before);
  });

  it("refuses a consumed receipt and rolls back the mirror, movements, ledger and audit", async () => {
    const w = await world("consumed");
    const receipt = await post(w, w.receipt, "10", "20", "2026-01-10");
    await post(w, w.issue, "1", "30", "2026-01-15");
    await post(w, w.receipt, "10", "10", "2026-01-20");
    const before = await state(w);
    await expect(reverse(w, receipt.documentId, "2026-01-25")).rejects.toMatchObject({
      code: "ERR_DOC_STATUS_ILLEGAL",
    });
    expect(await state(w)).toEqual(before);
    expect((await value(w)).value).toBe("280.0000");
  });

  it("refuses a purchase reversal while recost is pending", async () => {
    const w = await world("pending");
    const receipt = await post(w, w.receipt, "10", "20", "2026-01-20");
    await post(w, w.receipt, "10", "10", "2026-01-10");
    const before = await state(w);
    await expect(reverse(w, receipt.documentId, "2026-01-25")).rejects.toMatchObject({
      code: "ERR_DOC_STATUS_ILLEGAL",
    });
    expect(await state(w)).toEqual(before);
    await runReplay(w);
    await reverse(w, receipt.documentId, "2026-01-25");
    expect((await value(w)).value).toBe("100.0000");
  });

  it("refuses a mismatching exact layer value", async () => {
    const w = await world("mismatched");
    const receipt = await post(w, w.receipt, "3", "3.3333", "2026-01-10");
    await withTenant(
      db.migrator,
      context(w),
      (tx) => tx`update app.cost_layer set value = '10.0000' where company_id = ${w.s.company}`,
    );
    const before = await state(w);
    await expect(reverse(w, receipt.documentId, "2026-01-25")).rejects.toMatchObject({
      code: "ERR_DOC_STATUS_ILLEGAL",
    });
    expect(await state(w)).toEqual(before);
  });

  it("refuses a newly back-dated issue crossing a posted purchase cancellation", async () => {
    const w = await world("backdated-issue");
    await post(w, w.receipt, "10", "10", "2026-01-10");
    const second = await post(w, w.receipt, "10", "20", "2026-01-20");
    await reverse(w, second.documentId, "2026-01-25");
    const before = await state(w);
    await expect(post(w, w.issue, "1", "30", "2026-01-22")).rejects.toMatchObject({
      code: "ERR_DOC_STATUS_ILLEGAL",
    });
    expect(await state(w)).toEqual(before);
    await post(w, w.issue, "1", "30", "2026-01-26");
    expect((await value(w)).value).toBe("90.0000");
  });

  it("serializes concurrent receipt reversal and issue so only eligible operations commit", async () => {
    const w = await world("concurrent");
    const receipt = await post(w, w.receipt, "10", "20", "2026-01-10");
    const results = await Promise.allSettled([
      reverse(w, receipt.documentId, "2026-01-20"),
      post(w, w.issue, "1", "30", "2026-01-21"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["ERR_DOC_STATUS_ILLEGAL", "ERR_STOCK_INSUFFICIENT"]).toContain(rejected.reason.code);
    const after = await value(w);
    expect(after.value).toBe(after.ledger);
  });

  it("migration 0118 backfills multiple tenant contexts, preserves booked facts, and restores RLS context on down/up", async () => {
    const a = await world("migration-alpha");
    const b = await world("migration-beta");
    await post(a, a.receipt, "3", "3.3333", "2026-01-10");
    await post(b, b.receipt, "3", "4.3333", "2026-01-10");
    await post(a, a.issue, "1", "30", "2026-01-15");
    const immutableBefore =
      await db.admin`select id, quantity::text, value::text from app.inventory_movement order by id`;
    const ledgerBefore =
      await db.admin`select id, base_debit::text, base_credit::text from app.ledger_entry order by id`;
    // Every migration above 117 rolls back with 0118 and is re-applied after it — 0119 onward included
    // (§3.4.1: no test may assume max(version) is its own last number), as document-header-guard's 0117 case does.
    const applied = await listApplied(db.migrator);
    expect(applied).toContain(118);
    const tail = applied.filter((version) => version > 117);
    expect(await down(db.migrator, MIGRATIONS_DIR, 117)).toEqual(tail.toReversed());
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(tail);
    expect(
      await db.admin`select id, quantity::text, value::text from app.inventory_movement order by id`,
    ).toEqual(immutableBefore);
    expect(
      await db.admin`select id, base_debit::text, base_credit::text from app.ledger_entry order by id`,
    ).toEqual(ledgerBefore);
    for (const w of [a, b]) {
      const [layer] = await withTenant(
        db.rw,
        context(w),
        (tx) =>
          tx<
            { value: string; source: string }[]
          >`select l.value::text, m.value::text as source from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id where l.company_id = ${w.s.company}`,
      );
      expect(layer!.value).toBe(layer!.source);
      await runReplay(w);
      const after = await value(w);
      expect(Money.of(after.value, MYR).toString()).toBe(after.ledger);
    }
    expect(await db.migrator`select * from app.cost_layer`).toEqual([]);
  });
});
