import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { postDocument, reverseDocument, valuationAsOf, withTenant } from "@dulja/db";
import {
  draftTypedDocument,
  grantCodes,
  seedDocumentType,
  startDb,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { currency, Money } from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixtureLegacyDriver, type LegacyCorpus } from "../../src/drivers/fixture";
import type { LegacyRow } from "../../src/legacy/types";
import { createReader } from "../../src/reader";
import { readAccountMap } from "../../src/load/account-map";
import { clearAccountMap, setAccountMap } from "../../src/load/accounts";
// The registry BEFORE the loader module: a loader imports `./run` and `./refs`, which import the registry, so a test
// that entered the cycle through `opening-stock` itself would build `loaders` while this module's binding is still
// unset. The barrel enters through the registry too.
import { loaders } from "../../src/load/registry";
import { OPENING_STOCK_LINES_PER_DOCUMENT, openingStockLoader } from "../../src/load/opening-stock";
import { EMPTY_TARGET, runLoad, setLoadSource } from "../../src/load/run";
import { clearKeyRing, setKeyRing } from "../../src/load/employees";
import type { LoadContext, LoadReport } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant, TEST_KEY_RING } from "../support/tenant";

let db: Db;
let s: Seed;
let first: LoadReport;
const runs: string[] = [];
const MYR = currency("MYR");
const MAP = fileURLToPath(new URL("../fixtures/account-map.json", import.meta.url));
const OPENING_STOCK_JSON = fileURLToPath(
  new URL("../../../db/seed/my/document-types/OPENING_STOCK.json", import.meta.url),
);

function newRun(): string {
  const id = randomUUID();
  runs.push(id);
  return id;
}

function useCorpus(corpus: LegacyCorpus): void {
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(corpus);
    return { driver, reader: await createReader(driver), close: () => driver.close() };
  });
}

/** The cut-over corpus with some tables' rows replaced. */
function withTables(replace: Record<string, readonly LegacyRow[]>): LegacyCorpus {
  const corpus = loadCorpus("cut-over");
  const tables = { ...corpus.tables };
  for (const [name, rows] of Object.entries(replace))
    tables[name] = { ...tables[name]!, rows: [...rows] };
  return { ...corpus, tables };
}

const move = (
  id: string,
  mat: string,
  war: string,
  bat: string | null,
  date: string,
  seq: string,
  dir: "1" | "0",
  qnt: string,
  val: string | null,
): LegacyRow => ({
  BTMID: id,
  BTMMAT: mat,
  BTMWAR: war,
  BTMBAT: bat,
  BTMDATE: date,
  BTMSEQ: seq,
  BTMROW: "1",
  BTMIN: dir,
  BTMQNT: qnt,
  BTMVAL: val,
});

const ctxFor = (seed: Seed, over: Partial<LoadContext> = {}): Promise<LoadContext> =>
  loadContextFor(db, seed, over.runId ?? newRun(), over);

/** Read as the tenant's system principal: `document` and `ledger_entry` are branch-isolated (§4.5.6), and the seed's
 *  human holds no role in the company. */
const read = <T>(seed: Seed, fn: (tx: Sql) => Promise<T>): Promise<T> =>
  withTenant(db.rw, { tenantId: seed.tenant, actorId: seed.system, requestId: randomUUID() }, fn);

/** `import_batch`'s natural key has no run scoping, so every case whose evidence comes from `load` needs a tenant of
 *  its own (T5's reasoning, verbatim). */
const ownTenant = (name: string): Promise<Seed> =>
  seedLoadableTenant(db, `${name}-${randomUUID().slice(0, 8)}`);

interface StockDoc {
  id: string;
  series: string;
  number: string;
  status: string;
  effective_date: string;
  warehouse: string;
  branch: string;
  lines: number;
  created_by_system: boolean;
}

const stockDocuments = (seed: Seed): Promise<StockDoc[]> =>
  read(
    seed,
    (tx) => tx<StockDoc[]>`
      select d.id::text as id, d.series, d.number::text as number, d.status::text as status,
             to_char(d.effective_date, 'YYYY-MM-DD') as effective_date, w.code as warehouse, v.code as branch,
             (select count(*)::int from app.document_line l where l.document_id = d.id) as lines,
             d.created_by = ${seed.system} as created_by_system
        from app.document d
        join app.document_type t on t.id = d.document_type_id
        join app.warehouse w on w.id = d.warehouse_id
        join app.dimension_value v on v.id = d.branch_id
       where d.company_id = ${seed.company} and t.code = 'OPENING_STOCK'
       order by d.number`,
  );

const stockBatches = (seed: Seed) =>
  read(
    seed,
    (tx) => tx<{ source_key: string; target_id: string }[]>`
      select source_key, target_id::text as target_id from app.import_batch
       where company_id = ${seed.company} and source_table = 'BILLITEMS'
       order by length(source_key), source_key`,
  );

beforeAll(async () => {
  db = await startDb();
  s = await seedLoadableTenant(db, "opening-stock");
  setAccountMap(readAccountMap(MAP));
  setKeyRing(TEST_KEY_RING);
  useCorpus(loadCorpus("cut-over"));
  first = await runLoad(db.rw, await ctxFor(s));
}, 300_000);

afterAll(async () => {
  clearAccountMap();
  clearKeyRing();
  for (const id of runs) rmSync(join("artefacts", "legacy", id), { recursive: true, force: true });
  await db?.stop();
});

describe("OPENING_STOCK — recomputed cost, posted through the posting service (§5.1 #6)", () => {
  it("is a whole-table loader over BILLITEMS that resolves items, warehouses and lots", () => {
    expect(openingStockLoader.targetTable).toBe("opening_stock");
    expect(openingStockLoader.sourceTable).toBe("BILLITEMS");
    expect(openingStockLoader.wholeTable).toBe(true);
    expect(openingStockLoader.dependsOn).toEqual(["item", "warehouse", "lot"]);
    expect(OPENING_STOCK_LINES_PER_DOCUMENT).toBe(200);
    for (const column of openingStockLoader.sourceColumns)
      expect(column.confidence).toBe("hypothesis");
  });

  it("declares exactly two whole-table loaders — this one and the ledger opening (amendment C13)", () => {
    // Which loaders opt out of `runLoad`'s 500-row paging is a decision, invisible on a fixture smaller than a page: a
    // new loader must not join or leave this set without a reviewer seeing this line change.
    expect(loaders.filter((l) => l.wholeTable).map((l) => l.targetTable)).toEqual([
      "opening_balance",
      "opening_stock",
    ]);
  });

  it("the seed file is the §4.3.7 envelope the plan fixes: series OS, inventory receipt, 3900 credit leg (C11)", () => {
    const envelope = JSON.parse(readFileSync(OPENING_STOCK_JSON, "utf8")) as {
      code: string;
      module: string;
      policy: {
        numbering: { series: string };
        inventory: { effect: string; allowNegative: boolean };
        lines: { side: string; account: unknown }[];
        approval: { required: boolean; post: string };
      };
    };
    expect(envelope.code).toBe("OPENING_STOCK");
    expect(envelope.module).toBe("inventory");
    expect(envelope.policy.numbering.series).toBe("OS");
    expect(envelope.policy.inventory).toMatchObject({ effect: "receipt", allowNegative: false });
    expect(envelope.policy.lines.map((l) => [l.side, l.account])).toEqual([
      ["debit", { from: "item.inventory_account" }],
      ["credit", { code: "3900" }],
    ]);
    expect(envelope.policy.approval).toMatchObject({
      required: false,
      post: "inventory.receipt.post",
    });
  });

  it("posts one OPENING_STOCK per warehouse, in series OS, on the cut-over date, in HQ, as the system principal", async () => {
    // `MAIN-STORE` is `codeFromName("Main store")`. `SHOP-1` opens nothing, so it has no OPENING_STOCK at all.
    const docs = await stockDocuments(s);
    expect(docs).toEqual([
      expect.objectContaining({
        series: "OS",
        number: "1",
        status: "posted",
        effective_date: "2026-01-31",
        warehouse: "MAIN-STORE",
        branch: "HQ",
        lines: 1,
        created_by_system: true,
      }),
    ]);
    expect(first.perLoader["opening_stock"]).toEqual({ inserted: 1, skipped: 0, conflicts: 0 });
    expect(first.skips.filter((k) => k.loader === "opening_stock")).toEqual([]);
  });

  it("points every BILLITEMS batch row at the OPENING_STOCK document of that row's OWN position", async () => {
    // Three movement rows collapse into one position in MAIN-STORE, so all three point at its opening document.
    const [doc] = await stockDocuments(s);
    expect(await stockBatches(s)).toEqual([
      { source_key: "1", target_id: doc!.id },
      { source_key: "2", target_id: doc!.id },
      { source_key: "3", target_id: doc!.id },
    ]);
  });

  it("creates the cost layer through applyMovements, in the legacy batch — never a hand-written layer", async () => {
    const layers = await read(
      s,
      (tx) => tx<
        { qty_in: string; unit_cost: string; value: string; qty_remaining: string; lot: string }[]
      >`
        select c.qty_in::text as qty_in, c.unit_cost::text as unit_cost, c.value::text as value,
               c.qty_remaining::text as qty_remaining, l.code as lot
          from app.cost_layer c
          join app.lot l on l.id = c.lot_id
          join app.inventory_movement m on m.id = c.movement_id
          join app.document d on d.id = m.document_id
          join app.document_type t on t.id = d.document_type_id
         where d.company_id = ${s.company} and t.code = 'OPENING_STOCK'`,
    );
    expect(layers).toEqual([
      {
        qty_in: "15.000000",
        unit_cost: "12.0000",
        value: "180.0000",
        qty_remaining: "15.000000",
        lot: "B-2401",
      },
    ]);
  });

  it("makes valuationAsOf(cut-over) equal the recomputed opening value to the cent — the phase's DoD", async () => {
    const rows = await read(s, (tx) =>
      valuationAsOf(tx, { companyId: s.company, asOf: "2026-01-31", limit: 1000 }),
    );
    expect(rows.map((r) => [r.itemCode, r.warehouseCode, r.quantity, r.value])).toEqual([
      ["WIDGET", "MAIN-STORE", "15.000000", "180.0000"],
    ]);
    const total = rows.reduce((sum, r) => sum.add(Money.of(r.value, MYR)), Money.zero(MYR));
    expect(total.toString()).toBe("180.0000");
  });

  it("debits inventory control and credits 3900, so the opening TB and the opening stock meet on one account (C11)", async () => {
    const lines = await read(
      s,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, l.base_debit::text as debit, l.base_credit::text as credit
          from app.ledger_entry l join app.account a on a.id = l.account_id
          join app.document d on d.id = l.document_id
          join app.document_type t on t.id = d.document_type_id
         where d.company_id = ${s.company} and t.code = 'OPENING_STOCK' order by a.code`,
    );
    expect(lines).toEqual([
      { code: "1300", debit: "180.0000", credit: "0.0000" },
      { code: "3900", debit: "0.0000", credit: "180.0000" },
    ]);
  });

  it("re-running the load posts no second opening", async () => {
    const again = await runLoad(db.rw, await ctxFor(s));
    expect(again.perLoader["opening_stock"]).toEqual({ inserted: 0, skipped: 3, conflicts: 0 });
    expect(await stockDocuments(s)).toHaveLength(1);
  });

  it("a dry run replays nothing into the ledger", async () => {
    const own = await ownTenant("opening-stock-dry");
    const report = await runLoad(db.rw, await ctxFor(own, { dryRun: true }));
    expect(report.perLoader["opening_stock"]).toEqual({ inserted: 3, skipped: 0, conflicts: 0 });
    expect(await stockDocuments(own)).toEqual([]);
  });
});

describe("what the opening refuses or reports", () => {
  it("refuses a job-partitioned source before computing anything, and leaves no opening and no BILLITEMS key (Part VII #7, LEGACY-022)", async () => {
    // 9B T15 — ⚠️ OD-27. The committed sibling corpus is `cut-over` plus a MATOPENS whose MOPJOB holds 7 and 9.
    const own = await ownTenant("opening-stock-partitioned");
    useCorpus(loadCorpus("matopens-partitioned"));
    try {
      await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(
        "ERR_IMPORT_SOURCE_UNREADABLE: MATOPENS.MOPJOB has 2 distinct non-zero values (for example 7, 9); the legacy opening stock is partitioned by job",
      );
      expect(await stockDocuments(own)).toEqual([]);
      expect(await stockBatches(own)).toEqual([]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("never opens a negative position and reports it instead (acceptance test 18, re-run through the import path)", async () => {
    const own = await ownTenant("opening-stock-negative");
    useCorpus(
      withTables({
        BILLITEMS: [
          move("1", "11", "1", null, "2025-07-01", "1", "1", "1.000000", "10.0000"),
          move("2", "11", "1", null, "2025-07-02", "2", "0", "4.000000", null),
        ],
      }),
    );
    try {
      const report = await runLoad(db.rw, await ctxFor(own));
      // The reason reaches `report.skips` through amendment C15's `load` channel — `map` sees one row at a time and
      // could never have known the position went negative.
      expect(report.skips.filter((k) => k.loader === "opening_stock")).toEqual([
        {
          loader: "opening_stock",
          sourceTable: "BILLITEMS",
          sourceKey: "11/1",
          reason:
            "the legacy history drives item 11 in warehouse 1 to -3.000000; a negative opening is never loaded — it needs an inventory.negative_stock.override recorded by a second principal, which an importer running as one system principal cannot supply (acceptance test 18, hazard 17)",
        },
      ]);
      expect(await stockDocuments(own)).toEqual([]);
      // Both rows were read and hashed and produced no document: "seen, no target row".
      expect(await stockBatches(own)).toEqual([
        { source_key: "1", target_id: EMPTY_TARGET },
        { source_key: "2", target_id: EMPTY_TARGET },
      ]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("reports every position it cannot open against a real parent, and opens the rest", async () => {
    const own = await ownTenant("opening-stock-reports");
    useCorpus(
      withTables({
        BILLITEMS: [
          move("1", "12", "1", null, "2025-07-01", "1", "1", "1.000000", "5.0000"), // a service
          move("2", "999", "1", null, "2025-07-01", "2", "1", "1.000000", "1.0000"), // no such material
          move("3", "10", "1", "9001", "2025-07-01", "3", "1", "1.000000", "1.0000"), // batch never imported
          move("4", "10", "1", null, "2025-07-01", "4", "1", "2.000000", "20.0000"), // batch-tracked, no batch
          move("5", "11", "1", "9000", "2025-07-01", "5", "1", "1.000000", "3.0000"), // another item's batch
          move("6", "11", "2", null, "2025-07-01", "6", "1", "3.000000", "30.0000"), // opens in SHOP-1
        ],
      }),
    );
    try {
      const report = await runLoad(db.rw, await ctxFor(own));
      expect(
        report.skips
          .filter((k) => k.loader === "opening_stock")
          .map((k) => `${k.sourceKey}: ${k.reason}`)
          .toSorted(),
      ).toEqual([
        "10/1/9001: the opening position for legacy material 10 in warehouse 1 batch 9001 references an item, warehouse or lot that did not import; the position is reported, never opened against a guessed parent (§5.1 #3, LEGACY-073)",
        "10/1: legacy material 10 in warehouse 1 holds 2.000000 with no batch, but item WIDGET is batch-tracked; a batch-less receipt of it is refused (ADR 0034), so the position is reported, not opened",
        "11/1/9000: legacy batch 9000 is not a batch of material 11; the position is reported, never opened against another item's batch",
        "12/1: legacy material 12 in warehouse 1 is a service item; a service holds no stock, so its 1.000000 is reported, never opened against inventory control",
        "999/1: the opening position for legacy material 999 in warehouse 1 references an item, warehouse or lot that did not import; the position is reported, never opened against a guessed parent (§5.1 #3, LEGACY-073)",
      ]);
      expect(report.perLoader["opening_stock"]).toEqual({ inserted: 1, skipped: 5, conflicts: 0 });
      const docs = await stockDocuments(own);
      expect(docs.map((d) => [d.warehouse, d.lines])).toEqual([["SHOP-1", 1]]);
      // A row whose position was reported points at the opening of its own warehouse when there is one, else at
      // nothing — MAIN-STORE opened nothing here.
      expect(await stockBatches(own)).toEqual([
        { source_key: "1", target_id: EMPTY_TARGET },
        { source_key: "2", target_id: EMPTY_TARGET },
        { source_key: "3", target_id: EMPTY_TARGET },
        { source_key: "4", target_id: EMPTY_TARGET },
        { source_key: "5", target_id: EMPTY_TARGET },
        { source_key: "6", target_id: docs[0]!.id },
      ]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("opens more than 200 positions of one warehouse as documents of at most 200 lines, each row pointing at its own", async () => {
    const own = await ownTenant("opening-stock-split");
    const count = OPENING_STOCK_LINES_PER_DOCUMENT + 1;
    const ids = Array.from({ length: count }, (_, i) => String(10_001 + i));
    useCorpus(
      withTables({
        MATBATCHES: ids.map((id) => ({
          BATID: id,
          BATMAT: "10",
          BATCODE: `L-${id}`,
          BATEXPIRY: null,
          BATMFG: null,
        })),
        BILLITEMS: ids.map((id, i) =>
          move(id, "10", "1", id, "2025-07-01", String(i + 1), "1", "1.000000", "2.0000"),
        ),
      }),
    );
    try {
      await runLoad(db.rw, await ctxFor(own));
      const docs = await stockDocuments(own);
      expect(docs.map((d) => [d.number, d.lines])).toEqual([
        ["1", OPENING_STOCK_LINES_PER_DOCUMENT],
        ["2", 1],
      ]);
      const targets = new Map((await stockBatches(own)).map((b) => [b.source_key, b.target_id]));
      expect(targets.get(ids[0]!)).toBe(docs[0]!.id);
      expect(targets.get(ids[count - 1]!)).toBe(docs[1]!.id);
      const rows = await read(own, (tx) =>
        valuationAsOf(tx, { companyId: own.company, asOf: "2026-01-31", limit: 1000 }),
      );
      expect(rows.map((r) => [r.quantity, r.value])).toEqual([["201.000000", "402.0000"]]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("refuses a legacy movement dated after the cut-over date — the opening is the position ON that date", async () => {
    const own = await ownTenant("opening-stock-late");
    useCorpus(
      withTables({
        BILLITEMS: [
          ...loadCorpus("cut-over").tables["BILLITEMS"]!.rows,
          move("7", "10", "1", "9000", "2026-02-01", "7", "1", "1.000000", "1.0000"),
        ],
      }),
    );
    try {
      await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(
        /^ERR_VALIDATION_FAILED: BILLITEMS\/7 is dated 2026-02-01, after the cut-over date 2026-01-31; /,
      );
      expect(await stockDocuments(own)).toEqual([]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("refuses a source that grew after its opening was posted — and still refuses once the opening is reversed (one-shot, 9B review finding 3)", async () => {
    const own = await ownTenant("opening-stock-grown");
    await runLoad(db.rw, await ctxFor(own));
    const [posted] = await stockDocuments(own);
    const grown = [
      ...loadCorpus("cut-over").tables["BILLITEMS"]!.rows,
      move("4", "11", "1", null, "2025-12-01", "4", "1", "2.000000", "8.0000"),
    ];
    useCorpus(withTables({ BILLITEMS: grown }));
    const oneShot =
      /^ERR_IMPORT_DUPLICATE_SOURCE_KEY: opening stock was already loaded as OS 1(, since reversed,)? by run [0-9a-f-]{36}, and BILLITEMS now holds 4, which that load did not read or did not map\. The importer's opening is one-shot: a reversal does not reopen it, because a re-run would compute it out of these rows alone\. Correct a position after cut-over with a STOCK_COUNT/;
    try {
      await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(oneShot);
      // Reversal undoes the opening in the books (Global Constraint 5); it does NOT un-record its rows, so a re-run
      // would hand `load` only key 4 and replay item 11 from one movement — the partial replay the review found.
      await withTenant(
        db.rw,
        { tenantId: own.tenant, actorId: own.system, requestId: randomUUID() },
        (tx) =>
          reverseDocument(tx, systemCtx(own), {
            documentId: posted!.id,
            effectiveDate: "2026-01-31",
            reason: "the source grew",
          }),
      );
      await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(
        /^ERR_IMPORT_DUPLICATE_SOURCE_KEY: opening stock was already loaded as OS 1, since reversed, by run /,
      );
      expect((await stockDocuments(own)).map((d) => [d.number, d.status])).toEqual([
        ["1", "reversed"],
        ["2", "posted"],
      ]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
    // And the frozen source re-run after the reversal reloads nothing: every row is recorded, and a reversal is a
    // correction in Dulja, not an instruction to the importer.
    const again = await runLoad(db.rw, await ctxFor(own, { only: ["opening_stock"] }));
    expect(again.perLoader["opening_stock"]).toEqual({ inserted: 0, skipped: 3, conflicts: 0 });
    expect(await stockDocuments(own)).toHaveLength(2);
  });

  it("refuses another opening on an earlier cut-over date after the first is reversed — one-shot, never a second history", async () => {
    const own = await ownTenant("opening-stock-backdated");
    await runLoad(db.rw, await ctxFor(own));
    const [posted] = await stockDocuments(own);
    await withTenant(
      db.rw,
      { tenantId: own.tenant, actorId: own.system, requestId: randomUUID() },
      (tx) =>
        reverseDocument(tx, systemCtx(own), {
          documentId: posted!.id,
          effectiveDate: "2026-01-31",
          reason: "rehearse an earlier cut-over date",
        }),
    );
    useCorpus(
      withTables({
        BILLITEMS: [move("8", "11", "1", null, "2025-12-01", "1", "1", "1.000000", "4.0000")],
      }),
    );
    try {
      await expect(
        runLoad(db.rw, await ctxFor(own, { cutOverDate: "2026-01-15", only: ["opening_stock"] })),
      ).rejects.toThrow(
        /^ERR_IMPORT_DUPLICATE_SOURCE_KEY: opening stock was already loaded as OS 1, since reversed, by run [0-9a-f-]{36}, and BILLITEMS now holds 8, .*load into a fresh company \(the runbook's rehearsal company\)$/,
      );
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("keeps a reported position final: importing its missing item later never opens it (9B review, finding 3)", async () => {
    const own = await ownTenant("opening-stock-final");
    const unknown = move("4", "13", "1", null, "2025-12-01", "4", "1", "2.000000", "8.0000");
    const billitems = [...loadCorpus("cut-over").tables["BILLITEMS"]!.rows, unknown];
    useCorpus(withTables({ BILLITEMS: billitems }));
    try {
      const report = await runLoad(db.rw, await ctxFor(own));
      expect(
        report.skips.filter((k) => k.loader === "opening_stock").map((k) => k.sourceKey),
      ).toEqual(["13/1"]);
      // The source gains material 13; the item loads, and opening stock — whose rows are all recorded — opens nothing.
      const materials = [
        ...loadCorpus("cut-over").tables["MATERIALS"]!.rows,
        {
          MATID: "13",
          MATCODE: "SPROCKET",
          MATNAME: "Sprocket",
          MATNAMEAR: null,
          MATUNIT: "2",
          MATISSERVICE: "0",
          MATISBATCH: "0",
        },
      ];
      useCorpus(withTables({ BILLITEMS: billitems, MATERIALS: materials }));
      const again = await runLoad(db.rw, await ctxFor(own));
      expect(again.perLoader["item"]!.inserted).toBe(1);
      expect(again.perLoader["opening_stock"]).toEqual({ inserted: 0, skipped: 4, conflicts: 0 });
      const lines = await read(
        own,
        (tx) => tx<{ code: string }[]>`
          select i.code from app.document_line l join app.item i on i.id = l.item_id
           join app.document d on d.id = l.document_id join app.document_type t on t.id = d.document_type_id
           where l.company_id = ${own.company} and t.code = 'OPENING_STOCK' order by i.code`,
      );
      expect(lines.map((l) => l.code)).not.toContain("SPROCKET");
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("refuses to open into a company that already holds stock some other document moved", async () => {
    const own = await ownTenant("opening-stock-held");
    await runLoad(
      db.rw,
      await ctxFor(own, { only: ["unit_of_measure", "warehouse", "item", "lot"] }),
    );
    // A minimal inventory receipt type of the test's own, on OPENING_STOCK's policy shape.
    const envelope = JSON.parse(readFileSync(OPENING_STOCK_JSON, "utf8")) as {
      policy: Record<string, unknown>;
    };
    const typeId = await seedDocumentType(db, own, {
      code: "STOCK_IN",
      module: "inventory",
      policy: {
        ...envelope.policy,
        documentType: "STOCK_IN",
        numbering: { series: "SI", assignAt: "issue" },
        reversal: { allowed: true, producesType: "STOCK_IN" },
      },
    });
    const ids = await read(
      own,
      (tx) => tx<{ item: string; warehouse: string }[]>`
        select (select id::text from app.item where company_id = ${own.company} and code = 'GADGET') as item,
               (select id::text from app.warehouse where company_id = ${own.company} and code = 'MAIN-STORE') as warehouse`,
    );
    // The seed's human drafts (draftTypedDocument writes as `s.human`), so it needs a role in the company first.
    await grantCodes(db, own, { codes: ["inventory.receipt.post"] });
    const { documentId } = await draftTypedDocument(db, own, {
      documentTypeId: typeId,
      series: "SI",
      warehouseId: ids[0]!.warehouse,
      lines: [
        {
          kind: "item",
          description: "a receipt typed before the load",
          itemId: ids[0]!.item,
          warehouseId: ids[0]!.warehouse,
          quantity: "1.000000",
          unitPrice: "2.0000",
          amount: "2.0000",
        },
      ],
    });
    await withTenant(
      db.rw,
      { tenantId: own.tenant, actorId: own.system, requestId: randomUUID() },
      (tx) => postDocument(tx, systemCtx(own), { documentId }),
    );
    // `only` opening stock: a full load would stop earlier, at the trial-balance opening's own refusal of a company
    // that already posted a document the load did not create (9B review, finding 4).
    await expect(runLoad(db.rw, await ctxFor(own, { only: ["opening_stock"] }))).rejects.toThrow(
      /^ERR_VALIDATION_FAILED: the company already holds stock moved by STOCK_IN SI 1 on \d{4}-\d{2}-\d{2}; opening stock is the first stock a cut-over company holds, so load into a fresh company/,
    );
    await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(
      /already holds STOCK_IN SI 1, posted outside the cut-over load; the trial-balance opening is an opening/,
    );
    expect(await stockDocuments(own)).toEqual([]);
  });
});

/** The posting services take a `TenantContext`; the system principal's, as the load itself runs. */
function systemCtx(seed: Seed) {
  return { tenantId: seed.tenant, actorId: seed.system, requestId: randomUUID() };
}
