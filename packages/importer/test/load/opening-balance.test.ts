import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { reverseDocument, withTenant } from "@dulja/db";
import { startDb, type Db, type Seed } from "@dulja/db/test";
import { currency, Money } from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixtureLegacyDriver, type LegacyCorpus } from "../../src/drivers/fixture";
import type { LegacyRow } from "../../src/legacy/types";
import { createReader } from "../../src/reader";
import { assertAccountMap, readAccountMap, type AccountMap } from "../../src/load/account-map";
import { clearAccountMap, setAccountMap } from "../../src/load/accounts";
import { OPENING_BRANCH_CODE } from "../../src/load/document";
import { openingBalanceLoader, SUSPENSE_CODE } from "../../src/load/opening-balance";
import { EMPTY_TARGET, runLoad, setLoadSource } from "../../src/load/run";
import { clearKeyRing, setKeyRing } from "../../src/load/employees";
import type { LoadContext, LoadReport } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant, TEST_KEY_RING } from "../support/tenant";

let db: Db;
let s: Seed;
let first: LoadReport;
const MYR = currency("MYR");
const runs: string[] = [];
const MAP = fileURLToPath(new URL("../fixtures/account-map.json", import.meta.url));

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

/** The cut-over corpus with `ACCTOTALS` replaced. */
function withTotals(rows: readonly LegacyRow[]): LegacyCorpus {
  const corpus = loadCorpus("cut-over");
  return {
    ...corpus,
    tables: { ...corpus.tables, ACCTOTALS: { ...corpus.tables["ACCTOTALS"]!, rows } },
  };
}

/** The fixture map plus extra entries — it must keep its one ar_control and one ap_control (§4.8.2). */
function mapPlus(...extra: AccountMap["entries"]): AccountMap {
  const base = readAccountMap(MAP);
  return assertAccountMap({ ...base, entries: [...base.entries, ...extra] }, "test");
}

/** Legacy 4101 → Dulja 4000 (sales), the second `balance` account the fixture chart lacks, and legacy 5101 → 5900
 *  marked `exclude`; both added to `ACCOUNTS` so the account loader links them. */
const SALES: AccountMap["entries"][number] = {
  legacyCode: "4101",
  code: "4000",
  nameEn: "Sales",
  nameAr: null,
  type: "income",
  treatment: "balance",
  note: null,
};
const EXCLUDED: AccountMap["entries"][number] = {
  legacyCode: "5101",
  code: "5900",
  nameEn: "Other operating expense",
  nameAr: null,
  type: "expense",
  treatment: "exclude",
  note: "a closed legacy account",
};
const chartRow = (id: string, code: string, name: string): LegacyRow => ({
  ACCID: id,
  ACCCODE: code,
  ACCNAME: name,
  ACCNAMEAR: null,
  ACCISCUSTOMER: "0",
  ACCISVENDOR: "0",
  ACCTAXNO: null,
  ACCEMAIL: null,
  ACCPHONE: null,
  ACCOPENBAL: "0.0000",
});

/** The cut-over corpus with `ACCTOTALS` replaced and 4101/5101 added to `ACCOUNTS`. */
function withTrialBalance(rows: readonly LegacyRow[]): LegacyCorpus {
  const corpus = withTotals(rows);
  const accounts = corpus.tables["ACCOUNTS"]!;
  return {
    ...corpus,
    tables: {
      ...corpus.tables,
      ACCOUNTS: {
        ...accounts,
        rows: [
          ...accounts.rows,
          chartRow("104", "4101", "Sales"),
          chartRow("105", "5101", "Closed"),
        ],
      },
    },
  };
}

const ctxFor = (seed: Seed, over: Partial<LoadContext> = {}): Promise<LoadContext> =>
  loadContextFor(db, seed, over.runId ?? newRun(), over);

/** Read as the tenant's system principal: `document` and `ledger_entry` are branch-isolated (§4.5.6), and the seed's
 *  human holds no role in the company. */
const read = <T>(seed: Seed, fn: (tx: Sql) => Promise<T>): Promise<T> =>
  withTenant(db.rw, { tenantId: seed.tenant, actorId: seed.system, requestId: randomUUID() }, fn);

interface OpeningDoc {
  id: string;
  status: string;
  series: string;
  number: string | null;
  effective_date: string;
  legacy_ref: string | null;
  branch: string;
  created_by_system: boolean;
}

/** The trial-balance opening only: Task 7's open items are `OPENING_BALANCE` documents too, each with a `legacy_ref`. */
const openingDocuments = (seed: Seed): Promise<OpeningDoc[]> =>
  read(
    seed,
    (tx) => tx<OpeningDoc[]>`
      select d.id::text as id, d.status::text as status, d.series, d.number::text as number,
             to_char(d.effective_date, 'YYYY-MM-DD') as effective_date, d.legacy_ref, v.code as branch,
             d.created_by = ${seed.system} as created_by_system
        from app.document d
        join app.document_type t on t.id = d.document_type_id
        join app.dimension_value v on v.id = d.branch_id
       where d.company_id = ${seed.company} and t.code = 'OPENING_BALANCE' and d.legacy_ref is null
       order by d.created_at`,
  );

const openingLedger = (seed: Seed) =>
  read(
    seed,
    (tx) => tx<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.base_debit::text as debit, l.base_credit::text as credit
        from app.ledger_entry l
        join app.account a on a.id = l.account_id
        join app.document d on d.id = l.document_id
        join app.document_type t on t.id = d.document_type_id
       where d.company_id = ${seed.company} and t.code = 'OPENING_BALANCE' and d.legacy_ref is null
       order by a.code`,
  );

/**
 * `app.import_batch`'s natural key is `(company_id, source_table, source_key)` with no run scoping, and a key a run has
 * recorded is a silent skip on every later run: once `s` has loaded `ACCTOTALS`, another run against it maps nothing
 * and posts nothing. Every case whose evidence comes from `load` — a closed period, an archived suspense account, a
 * different trial balance — therefore needs a tenant of its own. That is what this is; it is not a convenience.
 */
async function ownTenant(name: string): Promise<Seed> {
  return seedLoadableTenant(db, `${name}-${randomUUID().slice(0, 8)}`);
}

beforeAll(async () => {
  db = await startDb();
  s = await seedLoadableTenant(db, "opening");
  setAccountMap(readAccountMap(MAP));
  setKeyRing(TEST_KEY_RING);
  useCorpus(loadCorpus("cut-over"));
  first = await runLoad(db.rw, await ctxFor(s));
}, 240_000);

afterAll(async () => {
  clearAccountMap();
  clearKeyRing();
  for (const id of runs) rmSync(join("artefacts", "legacy", id), { recursive: true, force: true });
  await db?.stop();
});

describe("the trial-balance opening (contracts §4.14 OPENING_BALANCE; spec §5.1 #1, #2)", () => {
  it("is registered after the master loaders it resolves through, as ONE whole-table load", () => {
    expect(openingBalanceLoader.targetTable).toBe("opening_balance");
    expect(openingBalanceLoader.sourceTable).toBe("ACCTOTALS");
    expect(openingBalanceLoader.wholeTable).toBe(true);
    expect(openingBalanceLoader.dependsOn).toEqual(["account"]);
    expect(SUSPENSE_CODE).toBe("3900");
    expect(OPENING_BRANCH_CODE).toBe("HQ");
    for (const column of openingBalanceLoader.sourceColumns)
      expect(column.confidence).toBe("hypothesis");
  });

  it("posts ONE OPENING_BALANCE document, numbered OB 1 on the cut-over date, as the system principal", async () => {
    const docs = await openingDocuments(s);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      status: "posted",
      series: "OB",
      number: "1",
      effective_date: "2026-01-31",
      legacy_ref: null,
      branch: "HQ",
      created_by_system: true,
    });
  });

  it("posts only `balance` accounts — the three control treatments are the sub-ledger loads' — and the residue on 3900", async () => {
    // 1101 → 1000 nets 5000 Dr. 1301/1401/2101 are the ar/inventory/ap controls: their openings come from the open-item
    // (T7) and opening-stock (T6) loads, so they are absent here, and the 5000 the balance lines leave lands on 3900.
    expect(await openingLedger(s)).toEqual([
      { code: "1000", debit: "5000.0000", credit: "0.0000" },
      { code: "3900", debit: "0.0000", credit: "5000.0000" },
    ]);
  });

  it("records the loaded key against the document and reports every control account, with its reason", async () => {
    const [doc] = await openingDocuments(s);
    const batches = await read(
      s,
      (tx) => tx<{ source_key: string; target_table: string; target_id: string }[]>`
        select source_key, target_table, target_id::text as target_id from app.import_batch
         where company_id = ${s.company} and source_table = 'ACCTOTALS' order by source_key`,
    );
    expect(batches).toEqual([
      { source_key: "1101", target_table: "opening_balance", target_id: doc!.id },
    ]);
    expect(first.perLoader["opening_balance"]).toEqual({ inserted: 1, skipped: 3, conflicts: 0 });
    expect(first.skips.filter((k) => k.loader === "opening_balance")).toEqual([
      {
        loader: "opening_balance",
        sourceTable: "ACCTOTALS",
        sourceKey: "1301",
        reason:
          "legacy account 1301 is the ar_control; its opening is supplied by the sub-ledger load, not by the trial-balance opening",
      },
      {
        loader: "opening_balance",
        sourceTable: "ACCTOTALS",
        sourceKey: "1401",
        reason:
          "legacy account 1401 is the inventory_control; its opening is supplied by the sub-ledger load, not by the trial-balance opening",
      },
      {
        loader: "opening_balance",
        sourceTable: "ACCTOTALS",
        sourceKey: "2101",
        reason:
          "legacy account 2101 is the ap_control; its opening is supplied by the sub-ledger load, not by the trial-balance opening",
      },
    ]);
  });

  it("re-running the load posts no second opening", async () => {
    const again = await runLoad(db.rw, await ctxFor(s));
    expect(again.perLoader["opening_balance"]).toEqual({ inserted: 0, skipped: 4, conflicts: 0 });
    expect(await openingDocuments(s)).toHaveLength(1);
  });

  it("refuses a source that grew after its opening was posted, rather than posting a second opening", async () => {
    const own = await ownTenant("opening-grown");
    await runLoad(db.rw, await ctxFor(own));
    setAccountMap(mapPlus(SALES));
    const grown = loadCorpus("cut-over").tables["ACCTOTALS"]!.rows;
    useCorpus(
      withTrialBalance([...grown, { ACTACC: "4101", ACTDEBIT: "0.0000", ACTCREDIT: "300.0000" }]),
    );
    try {
      await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(
        /^ERR_IMPORT_DUPLICATE_SOURCE_KEY: the trial-balance opening was already loaded as OB 1 by run [0-9a-f-]{36}, and ACCTOTALS now holds 4101, which that load did not read or did not map\. The importer's opening is one-shot/,
      );
      expect(await openingDocuments(own)).toHaveLength(1);
    } finally {
      setAccountMap(readAccountMap(MAP));
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("stays one-shot after its opening is reversed: a grown source is refused, the frozen one reloads nothing (9B review, finding 3)", async () => {
    const own = await ownTenant("opening-reversed");
    await runLoad(db.rw, await ctxFor(own));
    const [posted] = await openingDocuments(own);
    await withTenant(
      db.rw,
      { tenantId: own.tenant, actorId: own.system, requestId: randomUUID() },
      (tx) =>
        reverseDocument(
          tx,
          { tenantId: own.tenant, actorId: own.system, requestId: randomUUID() },
          { documentId: posted!.id, effectiveDate: "2026-01-31", reason: "the source grew" },
        ),
    );
    // Failure mode A: the reversal leaves every ACCTOTALS key recorded, so a re-run would hand `load` only 4101 and
    // post an OPENING_BALANCE of that one account plus a 3900 residue. It is refused instead.
    setAccountMap(mapPlus(SALES));
    const grown = loadCorpus("cut-over").tables["ACCTOTALS"]!.rows;
    useCorpus(
      withTrialBalance([...grown, { ACTACC: "4101", ACTDEBIT: "0.0000", ACTCREDIT: "300.0000" }]),
    );
    try {
      await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(
        /^ERR_IMPORT_DUPLICATE_SOURCE_KEY: the trial-balance opening was already loaded as OB 1, since reversed, by run [0-9a-f-]{36}, and ACCTOTALS now holds 4101, .*Correct a balance after cut-over with a JOURNAL .*load into a fresh company/,
      );
    } finally {
      setAccountMap(readAccountMap(MAP));
      useCorpus(loadCorpus("cut-over"));
    }
    // Failure mode C, now stated: the frozen source re-run after the reversal reloads nothing, silently or otherwise.
    const again = await runLoad(db.rw, await ctxFor(own, { only: ["opening_balance"] }));
    expect(again.perLoader["opening_balance"]).toEqual({ inserted: 0, skipped: 4, conflicts: 0 });
    // OB 1 reversed, and its reversal (numbered after the open items' OB documents) — no second opening.
    expect((await openingDocuments(own)).map((d) => d.status)).toEqual(["reversed", "posted"]);
  });

  it("a dry run maps the trial balance and posts nothing", async () => {
    // A dry run writes nothing, so it resolves accounts only through a link an earlier, real run recorded: the
    // rehearsal loads the chart first (`only: ["account"]`), then dry-runs the rest.
    const own = await ownTenant("opening-dry");
    await runLoad(db.rw, await ctxFor(own, { only: ["account"] }));
    const report = await runLoad(db.rw, await ctxFor(own, { dryRun: true }));
    expect(report.perLoader["opening_balance"]).toEqual({ inserted: 1, skipped: 3, conflicts: 0 });
    expect(await openingDocuments(own)).toEqual([]);
  });
});

describe("what the opening refuses, reports or leaves off the ledger", () => {
  it("refuses to post into a closed period through the import path (acceptance test 9, re-run)", async () => {
    // 0A's seedTenant makes 2026-02 a CLOSED period, which is why the code is ERR_PERIOD_NOT_OPEN, not _NOT_FOUND.
    const own = await ownTenant("opening-closed-period");
    await expect(runLoad(db.rw, await ctxFor(own, { cutOverDate: "2026-02-15" }))).rejects.toThrow(
      /^ERR_PERIOD_NOT_OPEN: fiscal period \S+ is closed$/,
    );
    // The refused page's transaction rolled back whole: no document, no batch row, so a corrected date can re-run it.
    expect(await openingDocuments(own)).toEqual([]);
    const [n] = await read(
      own,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.import_batch
         where company_id = ${own.company} and source_table = 'ACCTOTALS'`,
    );
    expect(n!.n).toBe(0);
  });

  it("refuses a residue when 3900 is archived or absent, and never quietly drops it (§5.1 #2, OD-25)", async () => {
    const own = await ownTenant("opening-archived-suspense");
    await read(
      own,
      (tx) =>
        tx`update app.account set archived_at = now() where company_id = ${own.company} and code = '3900'`,
    );
    await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(
      /^ERR_IMPORT_UNBALANCED_SOURCE: the opening is out by 5000\.0000 and account 3900 is archived or absent/,
    );
    expect(await openingDocuments(own)).toEqual([]);
  });

  it("a balanced opening carries no 3900 line, and each account opens at its NET", async () => {
    const own = await ownTenant("opening-balanced");
    // 1101 nets 5000 Dr (6000 Dr, 1000 Cr) against 4101's 5000 Cr: the balance lines balance, so there is no residue.
    setAccountMap(mapPlus(SALES));
    useCorpus(
      withTrialBalance([
        { ACTACC: "1101", ACTDEBIT: "6000.0000", ACTCREDIT: "1000.0000" },
        { ACTACC: "4101", ACTDEBIT: "0.0000", ACTCREDIT: "5000.0000" },
      ]),
    );
    try {
      await runLoad(db.rw, await ctxFor(own));
      expect(await openingLedger(own)).toEqual([
        { code: "1000", debit: "5000.0000", credit: "0.0000" },
        { code: "4000", debit: "0.0000", credit: "5000.0000" },
      ]);
    } finally {
      setAccountMap(readAccountMap(MAP));
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("a credit-heavy trial balance puts its residue on the DEBIT side of 3900", async () => {
    const own = await ownTenant("opening-debit-residue");
    setAccountMap(mapPlus(SALES));
    useCorpus(withTrialBalance([{ ACTACC: "4101", ACTDEBIT: "0.0000", ACTCREDIT: "900.0000" }]));
    try {
      await runLoad(db.rw, await ctxFor(own));
      expect(await openingLedger(own)).toEqual([
        { code: "3900", debit: "900.0000", credit: "0.0000" },
        { code: "4000", debit: "0.0000", credit: "900.0000" },
      ]);
    } finally {
      setAccountMap(readAccountMap(MAP));
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("a trial balance that nets flat posts nothing and records its keys as seen, not as a document", async () => {
    const own = await ownTenant("opening-flat");
    useCorpus(withTotals([{ ACTACC: "1101", ACTDEBIT: "250.0000", ACTCREDIT: "250.0000" }]));
    try {
      const report = await runLoad(db.rw, await ctxFor(own));
      expect(report.perLoader["opening_balance"]).toEqual({
        inserted: 0,
        skipped: 1,
        conflicts: 0,
      });
      expect(await openingDocuments(own)).toEqual([]);
      const batches = await read(
        own,
        (tx) => tx<{ source_key: string; target_id: string }[]>`
          select source_key, target_id::text as target_id from app.import_batch
           where company_id = ${own.company} and source_table = 'ACCTOTALS'`,
      );
      expect(batches).toEqual([{ source_key: "1101", target_id: EMPTY_TARGET }]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("reports an unmapped and an excluded legacy account, and refuses a NULL total (SAH-007)", async () => {
    const own = await ownTenant("opening-unmapped");
    setAccountMap(mapPlus(EXCLUDED));
    useCorpus(
      withTrialBalance([
        { ACTACC: "1101", ACTDEBIT: "5000.0000", ACTCREDIT: "0.0000" },
        { ACTACC: "5101", ACTDEBIT: "12.0000", ACTCREDIT: "0.0000" },
        { ACTACC: "9999", ACTDEBIT: "7.0000", ACTCREDIT: "0.0000" },
      ]),
    );
    try {
      const report = await runLoad(db.rw, await ctxFor(own));
      expect(report.skips.filter((k) => k.loader === "opening_balance")).toEqual([
        {
          loader: "opening_balance",
          sourceTable: "ACCTOTALS",
          sourceKey: "5101",
          reason:
            "legacy account 5101 is mapped exclude; its 12.0000/0.0000 total is reported, not loaded",
        },
        {
          loader: "opening_balance",
          sourceTable: "ACCTOTALS",
          sourceKey: "9999",
          reason: "legacy account 9999 has a stored total but is not in the account map",
        },
      ]);
      // Neither reported account reaches the ledger; 1101's 5000 is the whole residue.
      expect(await openingLedger(own)).toEqual([
        { code: "1000", debit: "5000.0000", credit: "0.0000" },
        { code: "3900", debit: "0.0000", credit: "5000.0000" },
      ]);
      // A tenant of its own: `own` has recorded 1101, so a changed 1101 there is refused as a changed source first.
      const nulls = await ownTenant("opening-null-total");
      useCorpus(withTotals([{ ACTACC: "1101", ACTDEBIT: null, ACTCREDIT: "0.0000" }]));
      await expect(runLoad(db.rw, await ctxFor(nulls))).rejects.toThrow(
        /^ERR_VALIDATION_FAILED: ACCTOTALS\/1101: ACTDEBIT is NULL; a NULL legacy amount is never read as zero/,
      );
      expect(await openingDocuments(nulls)).toEqual([]);
    } finally {
      setAccountMap(readAccountMap(MAP));
      useCorpus(loadCorpus("cut-over"));
    }
  });
});

describe("OD-25 ⚠️ — the suspense treatment and the cut-over date are the owner's (9B T11)", () => {
  it("OD-25 default: the residue STANDS on 3900 and the import writes no clearing JOURNAL", async () => {
    // A PINNING test, not a red-then-green one: with OD-25 unanswered the import leaves `3900` as the load made it,
    // and nothing it writes is anything but a cut-over document. A later change that clears the account
    // automatically — a JOURNAL, a third document type, a reclassification inside the load — fails here, visibly.
    // `s` is the whole committed `cut-over` corpus, loaded once in `beforeAll`.
    const written = await read(
      s,
      (tx) => tx<{ code: string }[]>`
        select distinct t.code from app.document d join app.document_type t on t.id = d.document_type_id
         where d.company_id = ${s.company} order by t.code`,
    );
    expect(written.map((r) => r.code)).toEqual(["OPENING_BALANCE", "OPENING_STOCK"]);
    const [suspense] = await read(
      s,
      (tx) => tx<{ balance: string }[]>`
        select coalesce(sum(l.base_debit - l.base_credit), 0)::numeric(19,4)::text as balance
          from app.ledger_entry l join app.account a on a.id = l.account_id
         where l.company_id = ${s.company} and a.code = ${SUSPENSE_CODE}`,
    );
    // `Money.isZero()`, never `Number(...)` — Global Constraint 2 binds a test as hard as a loader. Every fixture
    // company is MYR (0A). The figure is ADR 0086's decomposition on the corpus: 2220.0000 (the recost on 1300) less
    // 8300.0000 (the legacy imbalance), debit-positive.
    const balance = Money.of(suspense!.balance, MYR);
    expect(balance.isZero()).toBe(false);
    expect(balance.toString()).toBe("-6080.0000");
  });
});
