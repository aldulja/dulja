import { rmSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allocateLandedCostForDocument,
  checkAccountBalanceProjection,
  issueDocument,
  postDocument,
  recordBatch,
  sourceHashOf,
  systemContext,
  withTenant,
} from "@dulja/db";
import {
  createReader,
  FixtureLegacyDriver,
  loaders,
  loadSourceFromEnv,
  runLoad,
  setLoadSource,
  type LegacyCorpus,
  type LegacyRow,
  type Loader,
} from "@dulja/importer";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedItem,
  seedParty,
  seedTenantV2,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import { postJournal } from "../invariants/support/post-journal";
import { costingContext, type CostingFixture } from "./support/costing";

const ctx3c = costingContext("049-3c");

describe("LEGACY-049 Aggregate tables unkeyed; upsert race duplicates silently — 1A", () => {
  it("two concurrent posts to the same account, period and currency produce ONE row holding both amounts", async () => {
    const { db, rw } = await sharedDb();
    const seed = await seedTenantV2(db, "LEGACY049");
    await grantCodes(db, seed, { codes: ["accounting.journal.post"] });
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "legacy049" };
    const draft = async (amount: string): Promise<string> => {
      const id = await uuidv7(db.admin);
      await withTenant(rw, ctx, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${id}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-01-15', 'MYR', ${seed.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${seed.tenant}, ${seed.company}, ${id}, 1, ${seed.cash}, ${amount})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${seed.tenant}, ${seed.company}, ${id}, 2, ${seed.sales}, ${amount})`;
      });
      return id;
    };
    const left = await draft("10.0000");
    const right = await draft("20.0000");
    const one = postgres(db.url("app_rw"), { max: 1, prepare: false });
    const two = postgres(db.url("app_rw"), { max: 1, prepare: false });
    try {
      await Promise.all([
        withTenant(one, ctx, (tx) => postDocument(tx, ctx, { documentId: left })),
        withTenant(two, ctx, (tx) => postDocument(tx, ctx, { documentId: right })),
      ]);
    } finally {
      await one.end();
      await two.end();
    }
    const rows = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ debit: string }[]>`
      select debit::text as debit from app.account_balance
       where account_id = ${seed.cash} and fiscal_period_id = ${seed.period} and currency = 'MYR'`,
    );
    // The key is the grain: no duplicate row, and no lost amount.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.debit).toBe("30.0000");
  });

  /**
   * The test above races two DRAFTS, so both calls go through issueDocument and both queue on
   * `pg_advisory_xact_lock('series:<company>/JV/<period>')` — the MERGE never actually runs concurrently.
   * This test removes that accidental serialisation: both documents are issued FIRST, in their own
   * transactions, so postDocument skips issueDocument entirely (post.ts step 7) and the two MERGEs meet at
   * the same (company, account, fiscal_period, currency) key. `MERGE … WHEN NOT MATCHED THEN INSERT` has no
   * ON CONFLICT-style re-check, so without the sorted balance-key advisory lock of post.ts step 12 the
   * second transaction raises SQLSTATE 23505 on commit of the first — which the production withTenant does
   * NOT retry (it retries 40001 and 40P01 only, contracts §4.2.2) and which surfaces to the caller as
   * ERR_CONFLICT_UNIQUE on a perfectly legitimate post. The route reaches this path whenever a caller
   * issues in one request (`to: "issued"`) and posts in another.
   */
  it("two concurrent posts of ALREADY-ISSUED documents still produce ONE row, and never ERR_CONFLICT_UNIQUE", async () => {
    const { db, rw } = await sharedDb();
    const seed = await seedTenantV2(db, "LEGACY049b");
    await grantCodes(db, seed, { codes: ["accounting.journal.post"] });
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "legacy049b" };
    const draftAndIssue = async (amount: string): Promise<string> => {
      const id = await uuidv7(db.admin);
      await withTenant(rw, ctx, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${id}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-01-15', 'MYR', ${seed.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${seed.tenant}, ${seed.company}, ${id}, 1, ${seed.cash}, ${amount})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${seed.tenant}, ${seed.company}, ${id}, 2, ${seed.sales}, ${amount})`;
      });
      // Its own transaction: the series lock is released here.
      await withTenant(rw, ctx, (tx) => issueDocument(tx, ctx, { documentId: id }));
      return id;
    };
    const left = await draftAndIssue("100.0000");
    const right = await draftAndIssue("200.0000");
    const one = postgres(db.url("app_rw"), { max: 1, prepare: false });
    const two = postgres(db.url("app_rw"), { max: 1, prepare: false });
    try {
      await Promise.all([
        withTenant(one, ctx, (tx) => postDocument(tx, ctx, { documentId: left })),
        withTenant(two, ctx, (tx) => postDocument(tx, ctx, { documentId: right })),
      ]);
    } finally {
      await one.end();
      await two.end();
    }
    const rows = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ debit: string }[]>`
      select debit::text as debit from app.account_balance
       where account_id = ${seed.cash} and fiscal_period_id = ${seed.period} and currency = 'MYR'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.debit).toBe("300.0000");
  });
});

describe("LEGACY-049 Aggregate tables have no unique key, so the upsert race creates duplicates — 1B", () => {
  let db: Db;
  let a: Seed;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("two interleaved posts to an EXISTING key produce exactly one row and the rebuild agrees", async () => {
    // Warm the key first: MERGE's `when matched then update` branch takes a row lock under READ COMMITTED,
    // so the second transaction blocks and then re-reads. This is the race the old system lost, and the
    // primary key on (company_id, account_id, fiscal_period_id, currency) is what makes it unloseable.
    await postJournal(db, a, [
      { account: a.cash, debit: "1.0000" },
      { account: a.sales, credit: "1.0000" },
    ]);
    await Promise.all([
      postJournal(db, a, [
        { account: a.cash, debit: "2.0000" },
        { account: a.sales, credit: "2.0000" },
      ]),
      postJournal(db, a, [
        { account: a.cash, debit: "3.0000" },
        { account: a.sales, credit: "3.0000" },
      ]),
    ]);
    const ctx = {
      tenantId: a.tenant,
      actorId: a.human,
      requestId: await uuidv7(db.admin),
    };
    const [row] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number; debit: string }[]>`
      select count(*)::int as n, sum(debit)::text as debit from app.account_balance
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    expect(row).toEqual({ n: 1, debit: "6.0000" });
    expect(await withTenant(db.rw, ctx, (tx) => checkAccountBalanceProjection(tx))).toEqual([]);
  });
});

/** This file's 3C context. Module scope, not inside the `describe`: it captures nothing from that closure
 *  and `unicorn/consistent-function-scoping` refuses the inner form (the same reason `costing.ts` gives). */
const ctxOf = (s: { tenant: string; human: string }) => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: "legacy-049-3c",
});

/** A DRAFT shipment with two goods lines and one 300.0000 freight line. `costLineId` is that freight line. */
async function draftShipmentWithFreight(
  f: CostingFixture,
): Promise<{ documentId: string; costLineId: string }> {
  const { db, s, warehouse } = f;
  await seedAccount(db, s, {
    code: "2150",
    nameEn: "Goods received not invoiced",
    type: "liability",
  });
  await grantCodes(db, s, { codes: ["inventory.receipt.create", "inventory.receipt.post"] });
  const partyId = await seedParty(db, s, { kind: "vendor", code: "LEGACY049-VEND" });
  const { itemId, baseUnitId } = await seedItem(db, s, { code: "LEGACY049-ITEM" });
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
  const draft = await draftTypedDocument(db, s, {
    documentTypeId: shipmentType!.id,
    series: "SHP",
    partyId,
    warehouseId: warehouse,
    effectiveDate: "2026-06-15",
    lines: [
      // 1000 : 1000 by value and 100 : 50 by quantity, so the two methods give DIFFERENT splits of the
      // same 300.0000 — which is what makes "one method across both rows" a real assertion below.
      {
        kind: "item",
        itemId,
        unitId: baseUnitId,
        warehouseId: warehouse,
        quantity: "100.000000",
        unitPrice: "10.0000",
        amount: "1000.0000",
      },
      {
        kind: "item",
        itemId,
        unitId: baseUnitId,
        warehouseId: warehouse,
        quantity: "50.000000",
        unitPrice: "20.0000",
        amount: "1000.0000",
      },
      {
        kind: "account",
        accountId: freightAccount!.id,
        description: "ocean freight",
        amount: "300.0000",
      },
    ],
  });
  return { documentId: draft.documentId, costLineId: draft.lineIds[2]! };
}

describe("LEGACY-049 — 3C: the allocation's upsert key survives a concurrent re-allocation", () => {
  it("two transactions allocating the same shipment produce two rows, not four", async () => {
    const f = await ctx3c.inventory();
    const prepared = await draftShipmentWithFreight(f);
    const one = { costLineId: prepared.costLineId, method: "by_value" as const };
    const two = { costLineId: prepared.costLineId, method: "by_quantity" as const };

    // Both start before either commits. One wins the unique key and the other blocks on it, then updates —
    // which is what `on conflict … do update` under a real constraint does, and what LEGACY-049 lacked.
    const results = await Promise.allSettled([
      withTenant(f.db.rw, ctxOf(f.s), (tx) =>
        allocateLandedCostForDocument(tx, ctxOf(f.s), {
          documentId: prepared.documentId,
          allocations: [one],
        }),
      ),
      withTenant(f.db.rw, ctxOf(f.s), (tx) =>
        allocateLandedCostForDocument(tx, ctxOf(f.s), {
          documentId: prepared.documentId,
          allocations: [two],
        }),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);

    const [rows] = await withTenant(
      f.db.rw,
      ctxOf(f.s),
      (tx) => tx<{ n: number; methods: number; total: string }[]>`
      select count(*)::int as n, count(distinct method)::int as methods, sum(allocated_amount)::text as total
        from app.landed_cost_allocation where shipment_document_id = ${prepared.documentId}`,
    );
    // Two goods lines → two rows, whichever transaction won; one method across them; the total is the cost
    // line's own amount to the cent. Four rows, or two methods, is the defect.
    expect(rows).toMatchObject({ n: 2, methods: 1, total: "300.0000" });
  });
});

// ─── 9B ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: appended; no block above is edited. §5.1 #5: the legacy aggregate tables hold duplicate rows, so
// the load is keyed on (source_table, source_key) in app.import_batch (migration 0102, ADR 0084), never a blind insert.

/** A legacy table whose key 1 appears twice with identical data — the LEGACY-049 shape — and once more, differently. */
function duplicatedSource(extra: readonly LegacyRow[] = []): LegacyCorpus {
  const row = { UNTID: "1", UNTNAME: "Piece" };
  return {
    engineVersion: "WI-V2.5.9.27139 Firebird 2.5",
    tables: {
      UNITS: {
        keyColumns: ["UNTID"],
        columns: [
          { name: "UNTID", kind: "integer", scale: 0, nullable: false },
          { name: "UNTNAME", kind: "text", scale: 0, nullable: false },
        ],
        rows: [row, { UNTID: "2", UNTNAME: "Carton" }, row, ...extra],
      },
    },
  };
}

/** Writes one unit per mapped row; the regression's stand-in for Task 4's unit loader. */
const legacy049Loader: Loader<LegacyRow, { code: string; name: string }> = {
  sourceTable: "UNITS",
  targetTable: "unit_of_measure",
  dependsOn: [],
  sourceColumns: [
    { name: "UNTID", required: true, confidence: "hypothesis", note: "the key" },
    { name: "UNTNAME", required: true, confidence: "hypothesis", note: "the name" },
  ],
  sourceKey: (row) => String(row["UNTID"]),
  map: (row) => ({ code: `LEGACY049-U${String(row["UNTID"])}`, name: String(row["UNTNAME"]) }),
  async load(tx, ctx, rows) {
    const batchIds: string[] = [];
    for (const row of rows) {
      const [made] = await tx<{ id: string }[]>`
        insert into app.unit_of_measure (tenant_id, company_id, code, name_en)
        values (app.current_tenant(), ${ctx.companyId}, ${row.code}, ${row.name}) returning id`;
      batchIds.push(made!.id);
    }
    return { inserted: rows.length, skipped: 0, batchIds };
  },
};

describe("LEGACY-049 Duplicate aggregate rows in the legacy source — 9B", () => {
  afterAll(() => setLoadSource(loadSourceFromEnv));

  it("recordBatch: a second identical sighting of a legacy key is a skip, never a second row", async () => {
    const { rw, a } = await sharedDb();
    const runId = crypto.randomUUID();
    await withTenant(
      rw,
      { tenantId: a.tenant, actorId: a.system, requestId: runId },
      async (tx) => {
        const input = {
          companyId: a.company,
          sourceTable: "MATOBJECTS",
          sourceKey: "M-1/W-1",
          targetTable: "item",
          targetId: crypto.randomUUID(),
          sourceHash: sourceHashOf({ qty: "10.000000" }),
          runId,
        };
        expect((await recordBatch(tx, input)).kind).toBe("inserted");
        expect((await recordBatch(tx, input)).kind).toBe("skipped");
        const [n] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.import_batch
         where company_id = ${a.company} and source_table = 'MATOBJECTS' and source_key = 'M-1/W-1'`;
        expect(n!.n).toBe(1);
      },
    );
  });

  it("runLoad: a key the source holds twice loads once and the second sighting reaches the skip register", async () => {
    const { rw, a } = await sharedDb();
    const runId = crypto.randomUUID();
    setLoadSource(async () => {
      const driver = new FixtureLegacyDriver(duplicatedSource());
      return { driver, reader: await createReader(driver), close: () => driver.close() };
    });
    // The registry holds Task 4's real loaders, one of which also targets unit_of_measure: this case runs with the
    // LEGACY-049 loader as the WHOLE registry and restores the real ones after.
    const registered = loaders.splice(0, loaders.length);
    loaders.push(legacy049Loader as unknown as Loader<unknown, unknown>);
    try {
      const ctx = {
        ...(await systemContext(rw, a.tenant, runId)),
        companyId: a.company,
        runId,
        cutOverDate: "2026-01-31",
        dryRun: false,
      };
      const report = await runLoad(rw, ctx);
      expect(report.perLoader["unit_of_measure"]).toEqual({
        inserted: 2,
        skipped: 1,
        conflicts: 0,
      });
      expect(report.skips.map((s) => [s.sourceKey, s.reason])).toEqual([
        ["1", "the source holds this key twice with identical data; it was loaded once (LEGACY-049)"],
      ]);
      const rows = await withTenant(
        rw,
        ctx,
        (tx) =>
          tx<{ code: string; batches: number }[]>`
          select u.code, count(b.id)::int as batches
            from app.unit_of_measure u
            join app.import_batch b on b.target_id = u.id and b.company_id = u.company_id
           where u.company_id = ${a.company} and u.code like 'LEGACY049-U%'
           group by u.code order by u.code`,
      );
      expect(rows).toEqual([
        { code: "LEGACY049-U1", batches: 1 },
        { code: "LEGACY049-U2", batches: 1 },
      ]);

      // The same key a THIRD time with different data is not a duplicate to fold away: the run refuses it.
      setLoadSource(async () => {
        const driver = new FixtureLegacyDriver(duplicatedSource([{ UNTID: "1", UNTNAME: "Box" }]));
        return { driver, reader: await createReader(driver), close: () => driver.close() };
      });
      const again = crypto.randomUUID();
      await expect(runLoad(rw, { ...ctx, runId: again, requestId: again })).rejects.toThrow(
        /^ERR_IMPORT_DUPLICATE_SOURCE_KEY: UNITS\/1 /,
      );
      rmSync(join("artefacts", "legacy", again), { recursive: true, force: true });
    } finally {
      loaders.splice(0, loaders.length, ...registered);
      rmSync(join("artefacts", "legacy", runId), { recursive: true, force: true });
    }
  });
});
