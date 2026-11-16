import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  postInventoryDocument,
  postOverriddenIssue,
  recordingJobs,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import { replay } from "../../src/costing/replay";
import { rebuildStockValuation, VALUATION_PAGE, valuationAsOf } from "../../src/costing/valuation";
import { projectionChecks } from "../../src/integrity";
import { loadDocumentTypes } from "../../src/seed/document-types";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/** Resolved from this file: Vitest runs this package from `packages/db` (1a:5114). */
const TYPES = fileURLToPath(new URL("../../seed/my/document-types", import.meta.url));

describe("stock_valuation — the as-of snapshot (spec:1204; test 2 re-run)", () => {
  let db: Db;
  let s: Seed;
  let itemId: string;
  let warehouseId: string;
  let catalogue: string[];

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Snapshot");
    // `grantCodes(db, s)` with no `codes` grants NOTHING (its docstring), and 2B's R2 evaluates both
    // fixture policies' `approval.post` inside the posting transaction.
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    // The permission catalogue as DATA, read from the table: `packages/db` may not import
    // `@dulja/contracts` (0B's `dependency-rule`; 1a:5105 spells out this exact substitution).
    // `app.permission` is global, carries no `tenant_id` and no RLS (plan0A:1313), migration 0014 is its
    // only writer, and `permission-catalogue.test.ts` pins it equal to `PERMISSIONS` in both directions —
    // so the two sources cannot disagree. 1A's loader suite reads it the same way (1a:5131–5132), and
    // `no-bare-db` allows `db.admin` under `packages/db/test/` (0b:4969).
    catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map(
      (r) => r.code,
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
    // trackLots: false — `seedItem` defaults it to TRUE (§4.6.1) and `evaluatePolicy` refuses a DECLARED
    // receipt of a lot-tracked item whose line names no lot (packages/domain/src/posting/evaluate.ts:912).
    // The lot-tracked path is covered by `packages/db/test/costing/layers.test.ts`.
    ({ itemId } = await seedItem(db, s, { code: "SNAP-1", trackLots: false }));
    warehouseId = await seedWarehouse(db, s, { code: "S-WH" });
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId,
      effectiveDate: "2026-01-10",
      jobs: recordingJobs(),
      lines: [{ itemId, warehouseId, quantity: "80.000000", unitPrice: "12.5000" }],
    });
    await postInventoryDocument(db, s, {
      documentTypeId: issue,
      warehouseId,
      effectiveDate: "2026-01-20",
      jobs: recordingJobs(),
      lines: [{ itemId, warehouseId, quantity: "30.000000", unitPrice: "40.0000" }],
    });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("VALUATION_PAGE is 1000 — the rebuild pages, it never reads a company in one gulp", () => {
    expect(VALUATION_PAGE).toBe(1000);
  });

  it("the rebuild writes one row per (item, warehouse) and reports no mismatch", async () => {
    const out = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      rebuildStockValuation(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    expect(out).toEqual({ asOf: "2026-01-31", rowsWritten: 1, mismatches: [], excluded: [] });

    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx<{ quantity: string; value: string; as_of: string }[]>`
      select quantity::text, value::text, as_of::text as as_of
        from app.stock_valuation where company_id = ${s.company} order by as_of`,
    );
    expect(rows).toEqual([{ quantity: "50.000000", value: "625.0000", as_of: "2026-01-31" }]);
  });

  it("it agrees with valuationAsOf to the cent — one function, one answer (spec:1228, SAH-009)", async () => {
    const direct = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      valuationAsOf(tx, { companyId: s.company, asOf: "2026-01-31", limit: 50 }),
    );
    const stored = await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx<{ quantity: string; value: string }[]>`
      select quantity::text, value::text from app.stock_valuation
       where company_id = ${s.company} and as_of = '2026-01-31'`,
    );
    expect([{ quantity: direct[0]!.quantity, value: direct[0]!.value }]).toEqual(stored);
  });

  it("re-running the same date is idempotent — the row is updated, never duplicated", async () => {
    const again = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      rebuildStockValuation(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    expect(again.rowsWritten).toBe(1);
    const [n] = await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.stock_valuation
       where company_id = ${s.company} and as_of = '2026-01-31'`,
    );
    expect(n!.n).toBe(1);
  });

  it("a quantity that drifts from the movements IS a mismatch (test 2)", async () => {
    // Break the projection by hand, as app_migrator, exactly as 1B's projection tests do.
    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`
      update app.stock_valuation set quantity = '999.000000'
       where company_id = ${s.company} and as_of = '2026-01-31'`,
    );
    // The rebuild overwrites it, so the mismatch is detected against the MOVEMENTS, not against the old
    // row. Break the layer side instead: that is the only way the two derivations can disagree.
    //
    // And it must be `qty_in`, NOT `qty_remaining`. `valuationAsOf` derives a layer's residue as
    // `qty_in − Σ(valid consumptions on or before asOf)` and never selects `qty_remaining` at all, so
    // moving that column changes nothing the rebuild writes: both sides would still say 50.000000, the
    // drift query would drop the pair, and the only visible effect would be a positive live gap — i.e. the
    // pair silently classified as an open shortfall. Moving `qty_in` is what actually makes the
    // layer-derived figure disagree with the movements.
    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`update app.cost_layer set qty_in = qty_in + 5 where company_id = ${s.company}`,
    );
    const out = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      rebuildStockValuation(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    expect(out.mismatches).toHaveLength(1);
    expect(out.mismatches[0]!.projection).toBe("stock_valuation");
    // Present on both sides and unequal — 80 + 5 in, 30 consumed, against the movements' 80 − 30.
    expect(out.mismatches[0]!.side).toBe("amount_differs");
    expect(out.mismatches[0]!.detail).toMatch(
      /quantity 55\.000000 by the cost layers .* 50\.000000 by the movements/,
    );
    expect(out.excluded).toEqual([]); // the live gap is 50 − 50 = 0, so this is NOT an open shortfall
    // Repair the same column, so the later cases, ADR 0039's layer invariant and Task 12's
    // `COST_LAYER_CHECK` all start from a clean company.
    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`update app.cost_layer set qty_in = qty_in - 5 where company_id = ${s.company}`,
    );
    await withTenant(db.rw, s.tenant, s.system, (tx) =>
      rebuildStockValuation(tx, { companyId: s.company, asOf: "2026-01-31" }),
    ); // and put the snapshot back
  });

  it("an OPEN authorised shortfall excludes its pair, and a back-dated receipt plus the replay puts it back", async () => {
    // ADR 0038 note 7's carve-out, bounded by a test rather than by prose. An override issue the layers
    // cannot cover is VALUED but produces no consumption row, so for that (item, warehouse) the layers
    // exceed the movements until a receipt replenishes them. The pair must land in `excluded` and NOT in
    // `mismatches` — otherwise the nightly job raises the same incident every night over a correctly
    // authorised excursion — and it must return to the compared set once the gap actually closes.
    //
    // What closes it is worth being precise about, because the obvious answer is wrong: a *later* receipt
    // does NOT, since nothing re-consumes a historical shortfall (v1 rejects netting — ADR 0038 note 7).
    // What closes it is a **back-dated** receipt: `invalidateFrom` marks the issue's consumptions invalid
    // and the replay recomputes that issue against the replenished layers, which now cover it in full.
    const own = await seedTenantV2(db, "Shortfall");
    await grantCodes(db, own, { codes: ["accounting.journal.post"] });
    // This case runs the replay, and `replay` calls `resolveAdjustmentAccounts` unconditionally the moment
    // anything is in scope (Task 9 Step 3) — which raises `ERR_NOT_FOUND` on a missing document type
    // before any arithmetic. `COST_ADJUSTMENT` therefore has to exist in THIS tenant, not only in the one
    // `beforeAll` seeded. Nothing about the outcome depends on the adjustment; the pack load is what stops
    // the case failing for the wrong reason.
    //
    // `loadDocumentTypes` takes a POOL and opens its own `withTenant` (src/seed/document-types.ts:45), so
    // it is called directly — handing it a transaction makes the production `withTenant` raise
    // ERR_TENANT_CONTEXT_NESTED, which is why `replay.test.ts` calls it the same way.
    await loadDocumentTypes(
      db.migrator,
      { tenantId: own.tenant, actorId: own.system, requestId: await uuidv7(db.admin) },
      TYPES,
      catalogue,
    );
    const receipt = await seedDocumentType(db, own, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    const issue = await seedDocumentType(db, own, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    const { itemId: shortItem } = await seedItem(db, own, {
      code: "SHORT-1",
      trackLots: false,
    });
    const shortWarehouse = await seedWarehouse(db, own, { code: "SH-WH" });

    await postInventoryDocument(db, own, {
      documentTypeId: receipt,
      warehouseId: shortWarehouse,
      effectiveDate: "2026-01-05",
      jobs: recordingJobs(),
      lines: [
        {
          itemId: shortItem,
          warehouseId: shortWarehouse,
          quantity: "10.000000",
          unitPrice: "10.0000",
        },
      ],
    });
    // 12 issued against 10 on hand: two units of authorised shortfall, valued at 10.0000, unconsumed.
    await postOverriddenIssue(db, own, {
      documentTypeId: issue,
      itemId: shortItem,
      warehouseId: shortWarehouse,
      quantity: "12.000000",
      effectiveDate: "2026-01-10",
    });

    const open = await withTenant(db.rw, own.tenant, own.system, (tx) =>
      rebuildStockValuation(tx, { companyId: own.company, asOf: "2026-01-31" }),
    );
    expect(open.excluded).toEqual([{ itemId: shortItem, warehouseId: shortWarehouse }]);
    expect(open.mismatches).toEqual([]);

    // Replenish BEFORE the issue: 5 @ 12.0000 on the 8th. Step 14 enqueues the replay; run it here.
    const jobs = recordingJobs();
    await postInventoryDocument(db, own, {
      documentTypeId: receipt,
      warehouseId: shortWarehouse,
      effectiveDate: "2026-01-08",
      jobs,
      lines: [
        {
          itemId: shortItem,
          warehouseId: shortWarehouse,
          quantity: "5.000000",
          unitPrice: "12.0000",
        },
      ],
    });
    // Step 14 enqueues 3B's replay and then 4B's accounting.projection.rebuild (amendment 2), in that order.
    expect(jobs.enqueued.map((j) => j.name)).toEqual([
      "inventory.cost.replay",
      "accounting.projection.rebuild",
    ]);
    const replayCtx = {
      tenantId: own.tenant,
      actorId: own.system,
      requestId: await uuidv7(db.admin),
    };
    await replay(
      db.rw,
      {
        tenantId: own.tenant,
        requestId: replayCtx.requestId,
        payload: { companyId: own.company },
      },
      replayCtx,
    );

    // 10 + 5 in, 12 out and now FULLY consumed: layers hold 3.000000 and the movements sum to 3.000000.
    const closed = await withTenant(db.rw, own.tenant, own.system, (tx) =>
      rebuildStockValuation(tx, { companyId: own.company, asOf: "2026-01-31" }),
    );
    expect(closed.excluded).toEqual([]);
    expect(closed.mismatches).toEqual([]);
  }, 600_000);

  it("stock_valuation is NOT in the projection-check registry; cost_layer is (ADR 0039, amendment A10)", () => {
    const names = projectionChecks().map((c) => c.name);
    expect(names).not.toContain("stock_valuation");
    expect(names).toContain("cost_layer"); // registered in Task 12 — red until then, and that is correct
  });

  it("a second tenant's rebuild writes nothing of ours (test 12)", async () => {
    const b = await seedTenantV2(db, "Snapshot-B");
    await withTenant(db.rw, b.tenant, b.system, (tx) =>
      rebuildStockValuation(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    const [n] = await withTenant(
      db.rw,
      b.tenant,
      b.system,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.stock_valuation`,
    );
    expect(n!.n).toBe(0);
  });
});
