import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkAccountBalanceProjection,
  checkStockOnHandProjection,
  postDocument,
  projectionChecks,
  rebuildStockValuation,
  reverseDocument,
  runIntegrityCheck,
  withTenant,
} from "@dulja/db";
import {
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { cutOverFixture, loadFromCorpus } from "./support/cut-over";
import { postJournal } from "./support/post-journal";
import {
  postInventoryDocument,
  recordingJobs,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "./support/post-inventory";

// ── 3A: the stock_on_hand projection (acceptance test 2's 3A re-run) ─────────────────────────────
// Written inline rather than behind a helper: §4.17.1 binds a slice to the shared-helper rows it is
// assigned, and this slice is assigned none, so a `stockScenario()` in tests/support would be a
// contracts amendment bought for one case. The policy factory below is the same text
// packages/db/test/costing/apply-movements.test.ts uses — the same registered §4.14 codes, so there is
// one policy text per code (two spellings of a registered code is hazard 32).
//
// `itemRules` is the ledger pair that accounts for the item line's movement. Until code review 3 (R4) the
// factory had none — "two account legs balance the ledger; the item line carries the stock and matches no
// ledger rule" — and postDocument now refuses exactly that: a line that moves stock must meet an each_line
// rule, or its movement posts with no ledger leg. The account legs are unchanged.
const stockPolicy = (
  code: string,
  series: string,
  inventory: Record<string, unknown>,
  itemRules: readonly Record<string, unknown>[],
) => ({
  version: 1,
  documentType: code,
  direction: "internal",
  requires: [],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "line.account" },
      amount: "line.debit",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "line.account" },
      amount: "line.credit",
      when: { "line.kind": "account" },
    },
    ...itemRules,
  ],
  inventory,
  tax: { applies: false },
  numbering: { series, assignAt: "issue" },
  reversal: { allowed: true, producesType: code },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
});

/** One item-line rule for `stockPolicy`'s `itemRules`: `side` to `account` at `amount`. */
const itemRule = (side: string, account: Record<string, string>, amount: string) => ({
  for: "each_line",
  side,
  account,
  amount,
  when: { "line.kind": "item" },
});

describe("deterministic projections — acceptance test 2 (spec:2420; SAH-001, 002, 013, 049, 050)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    b = await seedTenantV2(db, "Beta");
    await grantCodes(db, b, { codes: ["accounting.journal.post"] });
  });
  afterAll(async () => {
    await db.stop();
  });

  const ctxFor = async (seed: Seed) => ({
    tenantId: seed.tenant,
    actorId: seed.human,
    requestId: await uuidv7(db.admin),
  });
  const check = async (seed: Seed) =>
    withTenant(db.rw, await ctxFor(seed), (tx) => checkAccountBalanceProjection(tx));
  const snapshot = async (seed: Seed) =>
    withTenant(
      db.rw,
      await ctxFor(seed),
      (tx) => tx<Record<string, string>[]>`
    select company_id::text, account_id::text, fiscal_period_id::text, currency::text,
           debit::text, credit::text, base_debit::text, base_credit::text
      from app.account_balance order by 1, 2, 3, 4`,
    );

  it("the registry holds exactly the projections this phase has", () => {
    // Third of the three assertions §4.16.3 pins: 2B's SERIES_GAP_CHECK registration added
    // "document_series", 3A's STOCK_ON_HAND_CHECK adds "stock_on_hand" and 3B's COST_LAYER_CHECK adds
    // "cost_layer" (amendment A10), 4B's ITEM_PROFITABILITY_CHECK adds "item_profitability" (ADR 0046) and 8C's
    // EMPLOYEE_YTD_CHECK adds "employee_ytd" (round 18 B5);
    // all three assertions move in the registering PR. The other two are
    // in tests/invariants/audit-chain.test.ts and apps/worker/test/handlers/integrity-check.test.ts. projectionChecks() sorts by name.localeCompare,
    // so the order is alphabetical and stable whatever order the registrations run in.
    expect(projectionChecks().map((candidate) => candidate.name)).toEqual([
      "account_balance",
      "cost_layer",
      "document_series",
      "employee_ytd",
      "item_profitability",
      "stock_on_hand",
    ]);
  });

  it("rebuilds bit-identically after several posts to the same key", async () => {
    await postJournal(db, a, [
      { account: a.cash, debit: "100.0000" },
      { account: a.sales, credit: "100.0000" },
    ]);
    await postJournal(db, a, [
      { account: a.cash, debit: "40.2500" },
      { account: a.sales, credit: "40.2500" },
    ]);
    await postJournal(db, a, [
      { account: a.sales, debit: "10.0000" },
      { account: a.cash, credit: "10.0000" },
    ]);
    expect(await check(a)).toEqual([]);
    const [row] = await withTenant(
      db.rw,
      await ctxFor(a),
      (tx) => tx<{ debit: string; credit: string }[]>`
      select debit::text, credit::text from app.account_balance
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    expect(row).toEqual({ debit: "140.2500", credit: "10.0000" });
  });

  it("a reversal ADDS entries with swapped sides — the projection stays a pure sum (D13)", async () => {
    const { documentId } = await postJournal(db, a, [
      { account: a.cash, debit: "77.0000" },
      { account: a.sales, credit: "77.0000" },
    ]);
    const ctx = await ctxFor(a);
    await withTenant(db.rw, ctx, (tx) =>
      reverseDocument(tx, ctx, {
        documentId,
        effectiveDate: "2026-01-20",
        reason: "acceptance test 2 reversal",
      }),
    );
    expect(await check(a)).toEqual([]);
  });

  it("Beta's postings never enter Alpha's rebuild (SAH-001 — the tenant key is RLS, not a column in the query)", async () => {
    await postJournal(db, b, [
      { account: b.cash, debit: "5000.0000" },
      { account: b.sales, credit: "5000.0000" },
    ]);
    expect(await check(a)).toEqual([]);
    expect(await check(b)).toEqual([]);
  });

  it("a hand-edited amount is reported as amount_differs, naming the column and both values (SAH-002)", async () => {
    const ctx = await ctxFor(a);
    await withTenant(
      db.rw,
      ctx,
      (tx) => tx`
      update app.account_balance set base_debit = base_debit + 1
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    const found = await check(a);
    expect(found).toHaveLength(1);
    expect(found[0]!.projection).toBe("account_balance");
    expect(found[0]!.side).toBe("amount_differs");
    expect(found[0]!.key).toMatchObject({
      account_id: a.cash,
      fiscal_period_id: a.period,
      currency: "MYR",
    });
    expect(found[0]!.detail).toMatch(/^base_debit \d+\.\d{4} <> \d+\.\d{4}$/);
    await withTenant(
      db.rw,
      ctx,
      (tx) => tx`
      update app.account_balance set base_debit = base_debit - 1
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    expect(await check(a)).toEqual([]);
  });

  it("a deleted projection row is reported as missing_in_projection", async () => {
    const ctx = await ctxFor(a);
    const before = await snapshot(a);
    await withTenant(
      db.migrator,
      ctx,
      (tx) => tx`
      delete from app.account_balance where account_id = ${a.sales} and fiscal_period_id = ${a.period}`,
    );
    const found = await check(a);
    expect(found.map((mismatch) => mismatch.side)).toEqual(["missing_in_projection"]);
    expect(found[0]!.key["account_id"]).toBe(a.sales);
    await withTenant(
      db.migrator,
      ctx,
      (tx) => tx`
      insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency,
                                       debit, credit, base_debit, base_credit)
      select l.tenant_id, l.company_id, l.account_id, l.fiscal_period_id, l.currency,
             sum(l.debit), sum(l.credit), sum(l.base_debit), sum(l.base_credit)
        from app.ledger_entry l
       where l.account_id = ${a.sales} and l.fiscal_period_id = ${a.period}
       group by l.tenant_id, l.company_id, l.account_id, l.fiscal_period_id, l.currency`,
    );
    expect(await check(a)).toEqual([]);
    expect(await snapshot(a)).toEqual(before);
  });

  it("a projection row with no ledger entries behind it is reported as missing_in_rebuild", async () => {
    const ctx = await ctxFor(a);
    const orphanAccount = await seedAccount(db, a, {
      code: "1900",
      nameEn: "Orphan",
      type: "asset",
    });
    await withTenant(
      db.rw,
      ctx,
      (tx) => tx`
      insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency,
                                       debit, credit, base_debit, base_credit)
      values (${a.tenant}, ${a.company}, ${orphanAccount}, ${a.period}, 'MYR', 3.0000, 0, 3.0000, 0)`,
    );
    const found = await check(a);
    expect(found.map((mismatch) => mismatch.side)).toEqual(["missing_in_rebuild"]);
    expect(found[0]!.key["account_id"]).toBe(orphanAccount);
    await withTenant(
      db.migrator,
      ctx,
      (tx) => tx`delete from app.account_balance where account_id = ${orphanAccount}`,
    );
    expect(await check(a)).toEqual([]);
  });

  it("the check never repairs — running it twice leaves account_balance byte-identical (SAH-079)", async () => {
    const before = await snapshot(a);
    await check(a);
    await check(a);
    expect(await snapshot(a)).toEqual(before);
  });

  it("is re-entrant inside one transaction — one statement, no scratch object to reclaim", async () => {
    const both = await withTenant(db.rw, await ctxFor(a), async (tx) => {
      const first = await checkAccountBalanceProjection(tx);
      const second = await checkAccountBalanceProjection(tx);
      return { first, second };
    });
    expect(both.first).toEqual([]);
    expect(both.second).toEqual([]);
  });

  it("stock_on_hand rebuilds bit-identically from the movements (test 2, 3A's projection)", async () => {
    // The three quantities are declared once and the expected figures are DERIVED from them in Postgres —
    // no literal answer, and no JavaScript number touches a quantity (spec:2043, 3A's assumption 13).
    const RECEIVED = "10.000000";
    const ISSUED = "4.000000";
    const TRANSFERRED = "3.000000";

    const c = await seedTenantV2(db, "Stock 3A");
    await grantCodes(db, c, { codes: ["accounting.journal.post"] }); // seedTenant grants nothing (§4.1)
    // The transfer's corridor, as TRANSFER's own pair names it (§4.15: 3D's account).
    await seedAccount(db, c, { code: "1310", nameEn: "Goods in transit", type: "asset" });
    const receiptType = await seedDocumentType(db, c, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: stockPolicy(
        "STOCK_RECEIPT_TEST",
        "SRT",
        { effect: "receipt", warehouse: "line.warehouse", costing: "create_layer" },
        // STOCK_RECEIPT_COST_POLICY's pair.
        [
          itemRule("debit", { from: "item.inventory_account" }, "line.amount"),
          itemRule("credit", { code: "5900" }, "line.amount"),
        ],
      ),
    });
    const issueType = await seedDocumentType(db, c, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: stockPolicy(
        "STOCK_ISSUE_TEST",
        "SIT",
        { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" },
        // STOCK_ISSUE_COST_POLICY's pair.
        [
          itemRule("debit", { from: "item.cogs_account" }, "line.cost"),
          itemRule("credit", { from: "item.inventory_account" }, "line.cost"),
        ],
      ),
    });
    const transferType = await seedDocumentType(db, c, {
      code: "STOCK_TRANSFER_TEST",
      module: "inventory",
      policy: stockPolicy(
        "STOCK_TRANSFER_TEST",
        "STT",
        {
          effect: "transfer",
          warehouse: "line.warehouse",
          to_warehouse: "header.to_warehouse",
          costing: "consume_layers",
        },
        // TRANSFER's pair.
        [
          itemRule("debit", { code: "1310" }, "line.cost"),
          itemRule("credit", { from: "item.inventory_account" }, "line.cost"),
        ],
      ),
    });
    // trackLots: false — seedItem defaults it to TRUE (§4.6.1) and Task 7's gate refuses a declared receipt
    // of a lot-tracked item with no lotId; the lot-tracked path is covered in packages/db's own suites.
    const { itemId } = await seedItem(db, c, { code: "REBUILD-ITEM", trackLots: false });
    const main = await seedWarehouse(db, c, { code: "RB-MAIN" });
    const transit = await seedWarehouse(db, c, { code: "RB-TRANSIT", kind: "in_transit" });

    /** Drafts and posts one document. `draftDocument` is JOURNAL-only (§4.1), so the insert is explicit —
     *  the same shape apply-movements.test.ts's `post` helper uses, with 0031's two header warehouses. */
    const post = async (
      typeId: string,
      series: string,
      opts: {
        quantity: string;
        unitPrice: string;
        amount: string;
        toWarehouseId?: string;
      },
    ) => {
      const postCtx = await ctxFor(c);
      return withTenant(db.rw, postCtx, async (tx) => {
        const id = await uuidv7(db.admin);
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series,
                                            fiscal_period_id, effective_date, currency, branch_id,
                                            warehouse_id, to_warehouse_id)
                 values (${id}, ${c.tenant}, ${c.company}, ${typeId}, ${series}, ${c.period},
                         '2026-01-15', 'MYR', ${c.hq}, ${main}, ${opts.toWarehouseId ?? null})`;
        const lines: readonly Record<string, unknown>[] = [
          { kind: "account", account_id: c.cash, debit: opts.amount },
          { kind: "account", account_id: c.sales, credit: opts.amount },
          {
            kind: "item",
            item_id: itemId,
            quantity: opts.quantity,
            unit_price: opts.unitPrice,
            amount: opts.amount,
          },
        ];
        for (const [index, line] of lines.entries()) {
          await tx`insert into app.document_line ${tx({
            id: await uuidv7(db.admin),
            tenant_id: c.tenant,
            company_id: c.company,
            document_id: id,
            line_no: index + 1,
            ...line,
          })}`;
        }
        return postDocument(tx, postCtx, { documentId: id });
      });
    };

    await post(receiptType, "SRT", {
      quantity: RECEIVED,
      unitPrice: "12.0000",
      amount: "120.0000",
    });
    await post(issueType, "SIT", { quantity: ISSUED, unitPrice: "12.0000", amount: "48.0000" });
    await post(transferType, "STT", {
      quantity: TRANSFERRED,
      unitPrice: "12.0000",
      amount: "36.0000",
      toWarehouseId: transit,
    });

    const readCtx = await ctxFor(c);
    expect(await withTenant(db.rw, readCtx, (tx) => checkStockOnHandProjection(tx))).toEqual([]);

    // …and the projection is not merely self-consistent with its own movements: it holds the arithmetic
    // answer, computed here from the three posted quantities in exact `numeric` rather than stated.
    const rows = await withTenant(
      db.rw,
      readCtx,
      (tx) => tx<{ warehouse_id: string; quantity: string }[]>`
        select warehouse_id, quantity::text as quantity from app.stock_on_hand
         where item_id = ${itemId} order by warehouse_id`,
    );
    const [expected] = await withTenant(
      db.rw,
      readCtx,
      (tx) => tx<{ main: string; transit: string }[]>`
        select ((${RECEIVED}::numeric(19,6) - ${ISSUED}::numeric(19,6) - ${TRANSFERRED}::numeric(19,6))
                  ::numeric(19,6))::text as main,
               (${TRANSFERRED}::numeric(19,6))::text as transit`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.warehouse_id, r.quantity]))).toEqual({
      [main]: expected!.main, // received, less what was issued, less what left on the transfer
      [transit]: expected!.transit, // the transfer's receiving leg
    });
  });
  // ── 3B: the stock_valuation snapshot (acceptance test 2's 3B re-run, ADR 0039) ──────────────────
  // `stock_valuation` is deliberately NOT in `projectionChecks` — it is an as-of history keyed by date, so
  // its rebuild-and-compare belongs to `inventory.projection.rebuild` and is driven here through
  // `rebuildStockValuation` directly, the same way the two registry checks above are driven through their
  // `check*` functions. Shape copied from the `stock_on_hand` case above: rebuild, rebuild again, assert
  // the second run changed nothing, then break one derivation by hand and assert the mismatch.
  it("stock_valuation rebuilds from the layers and a second run changes nothing (test 2, ADR 0039)", async () => {
    const v = await seedTenantV2(db, "Valuation 3B");
    await grantCodes(db, v, { codes: ["accounting.journal.post"] });
    const receiptType = await seedDocumentType(db, v, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    const issueType = await seedDocumentType(db, v, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    // trackLots: false — `seedItem` defaults it to TRUE, and `evaluatePolicy` refuses a declared receipt of
    // a lot-tracked item whose line names no lot (packages/domain/src/posting/evaluate.ts:912).
    const { itemId } = await seedItem(db, v, { code: "VAL-REBUILD", trackLots: false });
    const warehouseId = await seedWarehouse(db, v, { code: "VR-MAIN" });
    await postInventoryDocument(db, v, {
      documentTypeId: receiptType,
      warehouseId,
      effectiveDate: "2026-01-10",
      jobs: recordingJobs(),
      lines: [{ itemId, warehouseId, quantity: "80.000000", unitPrice: "12.5000" }],
    });
    await postInventoryDocument(db, v, {
      documentTypeId: issueType,
      warehouseId,
      effectiveDate: "2026-01-20",
      jobs: recordingJobs(),
      lines: [{ itemId, warehouseId, quantity: "30.000000", unitPrice: "40.0000" }],
    });

    const rebuild = async () =>
      withTenant(db.rw, await ctxFor(v), (tx) =>
        rebuildStockValuation(tx, { companyId: v.company, asOf: "2026-01-31" }),
      );
    const snapshotRows = async () =>
      withTenant(
        db.rw,
        await ctxFor(v),
        (tx) => tx<Record<string, string>[]>`
          select item_id::text, warehouse_id::text, as_of::text, quantity::text, value::text
            from app.stock_valuation order by 1, 2, 3`,
      );

    const first = await rebuild();
    expect(first).toEqual({
      asOf: "2026-01-31",
      rowsWritten: 1,
      mismatches: [],
      excluded: [],
    });
    // 80 in at 12.5000, 30 consumed at the same average: 50.000000 left, worth 625.0000.
    const after = await snapshotRows();
    expect(after).toEqual([
      {
        item_id: itemId,
        warehouse_id: warehouseId,
        as_of: "2026-01-31",
        quantity: "50.000000",
        value: "625.0000",
      },
    ]);

    const second = await rebuild();
    expect(second.mismatches).toEqual([]);
    expect(await snapshotRows()).toEqual(after); // bit-identical, the Phase 1 DoD's word for it

    // Break the LAYER side by hand, as the account_balance cases above do — and it must be `qty_in`, not
    // `qty_remaining`: `valuationAsOf` derives a layer's residue as `qty_in − Σ valid consumptions` and
    // never reads `qty_remaining`, so moving that column would change nothing the rebuild writes.
    await withTenant(
      db.migrator,
      await ctxFor(v),
      (tx) => tx`update app.cost_layer set qty_in = qty_in + 5 where company_id = ${v.company}`,
    );
    const drifted = await rebuild();
    expect(drifted.mismatches).toHaveLength(1);
    expect(drifted.mismatches[0]!.projection).toBe("stock_valuation");
    expect(drifted.mismatches[0]!.side).toBe("amount_differs");
    expect(drifted.mismatches[0]!.key).toMatchObject({ itemId, warehouseId, asOf: "2026-01-31" });
    expect(drifted.excluded).toEqual([]); // the live gap is 50 − 50 = 0: not an authorised shortfall

    await withTenant(
      db.migrator,
      await ctxFor(v),
      (tx) => tx`update app.cost_layer set qty_in = qty_in - 5 where company_id = ${v.company}`,
    );
    expect((await rebuild()).mismatches).toEqual([]);
    expect(await snapshotRows()).toEqual(after);
  });

  // 9B T9 — acceptance test 2, re-run after a cut-over load (9B plan Task 9 Step 8). The load posts OPENING_BALANCE and
  // OPENING_STOCK through postDocument and writes employee_ytd_opening, so every registered projection is checked
  // against what the whole corpus left. 9B registers no projection of its own: `checked` is the registry as it stands,
  // read rather than assumed, and the load's tenant is its own (cutOverFixture seeds one on the shared API).
  it("every projection still rebuilds bit-identically after a cut-over load (9B; acceptance test 2, re-run)", async () => {
    const f = await cutOverFixture("projection-after-load");
    const skips = await loadFromCorpus(f, "cut-over");
    expect(Array.isArray(skips)).toBe(true);
    const report = await withTenant(f.api.db.rw, f.ctx, (tx) =>
      runIntegrityCheck(tx, f.ctx, { companyId: f.ctx.companyId }),
    );
    expect(report.projections.checked).toEqual(
      projectionChecks().map((candidate) => candidate.name),
    );
    expect(report.projections.checked).toEqual([
      "account_balance",
      "cost_layer",
      "document_series",
      "employee_ytd",
      "item_profitability",
      "stock_on_hand",
    ]);
    expect(report.projections.mismatches).toEqual([]);
    expect(report.ledgerBalance.byDocument).toEqual([]);
    // The load did post: a vacuous "no mismatch" over an empty ledger proves nothing.
    const [posted] = await withTenant(
      f.api.db.rw,
      f.ctx,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document d
          join app.document_type t on t.id = d.document_type_id
         where d.company_id = ${f.ctx.companyId} and d.status = 'posted'
           and t.code in ('OPENING_BALANCE', 'OPENING_STOCK')`,
    );
    expect(posted!.n).toBeGreaterThan(0);
    // No `api.stop()`: cutOverFixture uses the memoised sharedApi() (§4.17.1, §3.7.5) and its consumers never stop it.
  });
});
