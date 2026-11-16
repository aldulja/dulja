import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withTenant } from "@dulja/db";
import { startDb, type Db, type Seed } from "@dulja/db/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ArtefactIndex } from "../../src/artefacts";
import { main } from "../../src/cli";
import { FixtureLegacyDriver, type LegacyCorpus } from "../../src/drivers/fixture";
import type { LegacyRow } from "../../src/legacy/types";
import { createReader } from "../../src/reader";
import type { ReconciliationReport } from "../../src/reconcile";
// `./run` (which imports the registry) BEFORE any loader module (9B T6's note).
import { runLoad, setLoadSource } from "../../src/load/run";
import { readAccountMap } from "../../src/load/account-map";
import { accountMap, clearAccountMap, setAccountMap } from "../../src/load/accounts";
import { clearKeyRing, setKeyRing } from "../../src/load/employees";
import {
  explain,
  reconcileCutOver,
  type Comparison,
  type CutOverReconciliation,
} from "../../src/load/reconcile-cut-over";
import type { LoadContext } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant, TEST_KEY_RING } from "../support/tenant";

// ── explain: pure ────────────────────────────────────────────────────────────────────────────────────────────────

/** 9A's real shapes (`reconcile/aggregate-drift.ts`, `reconcile/unbalanced-vouchers.ts`), not the plan's sketch. */
const drift = (rows: Record<string, unknown>[]): ReconciliationReport => ({
  kind: "aggregate_drift",
  rows,
  summary: { rules: "23", compared: "4", drifting: String(rows.length) },
});
const unbalanced = (net: string, count = "1"): ReconciliationReport => ({
  kind: "unbalanced_vouchers",
  rows: [{ voucher: "1|17", imbalance: net }],
  summary: { status: "compared", vouchers: "4", unbalanced: count, netImbalance: net },
});
const debitDrift = drift([
  {
    rule: "ACCTOTALS.DEBIT",
    key: "100",
    status: "drift",
    stored: "5000.0000",
    recomputed: "4900.0000",
    difference: "100.0000",
  },
  // ACCOBJECTS restates the same drift per site; the trial balance does not read it, so it moves nothing.
  {
    rule: "ACCOBJECTS.DEBIT",
    key: "1|100",
    status: "drift",
    stored: "5000.0000",
    recomputed: "4900.0000",
    difference: "100.0000",
  },
]);

describe("explain — a difference is matched exactly by 9A's reports, or it is not (ADR 0086)", () => {
  it("returns null for a zero difference — nothing to explain", () => {
    expect(explain("0.0000", [debitDrift, unbalanced("100.0000")])).toBeNull();
  });

  it("names the report whose trial-balance effect equals the difference", () => {
    expect(explain("100.0000", [unbalanced("100.0000")])).toBe(
      "unbalanced_vouchers: 1 of 4 vouchers does not balance, netting 100.0000 (LEGACY-003) — posted to 3900",
    );
  });

  it("names BOTH reports when their effects sum to the difference, in kind order", () => {
    expect(explain("200.0000", [unbalanced("100.0000", "2"), debitDrift])).toBe(
      "aggregate_drift: ACCTOTALS' stored totals less their VOUITEMS recomputation net 100.0000 across 1 account (LEGACY-001) — posted to 3900; unbalanced_vouchers: 2 of 4 vouchers do not balance, netting 100.0000 (LEGACY-003) — posted to 3900",
    );
  });

  it("returns null — NOT a guess — when no combination accounts for the difference", () => {
    expect(explain("777.0000", [debitDrift, unbalanced("100.0000")])).toBeNull();
  });

  it("matches SIGNED effects: a report that moves the trial balance by +100 does not explain −100", () => {
    expect(explain("-100.0000", [unbalanced("100.0000")])).toBeNull();
    expect(explain("-100.0000", [unbalanced("-100.0000")])).toContain("unbalanced_vouchers");
    // +100 and −100 together move it by nothing, so their pair explains no 200.
    expect(explain("200.0000", [debitDrift, unbalanced("-100.0000")])).toBeNull();
  });

  it("reads a credit drift as a debit-negative effect and a missing stored row as a stored zero", () => {
    const credit = drift([
      {
        rule: "ACCTOTALS.CREDIT",
        key: "103",
        status: "drift",
        stored: "900.0000",
        recomputed: "850.0000",
        difference: "50.0000",
      },
      {
        rule: "ACCTOTALS.DEBIT",
        key: "104",
        status: "missing_stored_row",
        stored: null,
        recomputed: "30.0000",
        difference: null,
      },
    ]);
    // −50 (the stored credit is 50 higher) − 30 (a debit the stored table never got) = −80.
    expect(explain("-80.0000", [credit])).toBe(
      "aggregate_drift: ACCTOTALS' stored totals less their VOUITEMS recomputation net -80.0000 across 2 accounts (LEGACY-001) — posted to 3900",
    );
  });

  it("never names a report that carries no money, or one that compared nothing", () => {
    const orphans: ReconciliationReport = {
      kind: "orphans",
      rows: [{ difference: "100.0000" }],
      summary: {},
    };
    const absent: ReconciliationReport = {
      kind: "unbalanced_vouchers",
      rows: [],
      summary: { status: "source_absent", netImbalance: "100.0000" },
    };
    expect(explain("100.0000", [orphans, absent])).toBeNull();
    expect(explain("100.0000", [orphans, unbalanced("100.0000")])).not.toContain("orphans");
  });
});

// ── reconcileCutOver: against PostgreSQL 18, after the whole cut-over corpus is loaded ──────────────────────────────

let db: Db;
let s: Seed;
let clean: CutOverReconciliation;
const runs: string[] = [];
const MAP = fileURLToPath(new URL("../fixtures/account-map.json", import.meta.url));

function useCorpus(corpus: LegacyCorpus): void {
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(corpus);
    return { driver, reader: await createReader(driver), close: () => driver.close() };
  });
}

const ctxFor = (seed: Seed, over: Partial<LoadContext> = {}): Promise<LoadContext> => {
  const runId = randomUUID();
  runs.push(runId);
  return loadContextFor(db, seed, runId, over);
};

/** The reconciliation of `seed`'s ledger against `corpus` — the same tenant can be compared with a changed source. */
async function reconcileWith(seed: Seed, corpus: LegacyCorpus): Promise<CutOverReconciliation> {
  const ctx = await ctxFor(seed);
  const driver = new FixtureLegacyDriver(corpus);
  try {
    const reader = await createReader(driver);
    return await withTenant(db.rw, ctx, (tx) => reconcileCutOver(tx, reader, ctx));
  } finally {
    await driver.close();
  }
}

/** The cut-over corpus with one table's rows replaced, or (rows `null`) the table removed. */
function withTable(
  name: string,
  rows: readonly LegacyRow[] | null,
  from = loadCorpus("cut-over"),
): LegacyCorpus {
  const tables = { ...from.tables };
  if (rows === null) delete tables[name];
  else tables[name] = { ...tables[name]!, rows: [...rows] };
  return { ...from, tables };
}
const rowsOf = (name: string): LegacyRow[] => [...loadCorpus("cut-over").tables[name]!.rows];

const find = (rows: readonly Comparison[], key: string): Comparison => {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row ${key} in ${rows.map((r) => r.key).join(", ")}`);
  return row;
};

beforeAll(async () => {
  db = await startDb();
  s = await seedLoadableTenant(db, "reconcile-cut-over");
  setAccountMap(readAccountMap(MAP));
  setKeyRing(TEST_KEY_RING);
  useCorpus(loadCorpus("cut-over"));
  await runLoad(db.rw, await ctxFor(s));
  clean = await reconcileWith(s, loadCorpus("cut-over"));
}, 300_000);

afterAll(async () => {
  clearAccountMap();
  clearKeyRing();
  for (const id of runs) rmSync(join("artefacts", "legacy", id), { recursive: true, force: true });
  await db?.stop();
});

/** A one-unit receipt of `mat` into warehouse 1, in the cut-over corpus's BILLITEMS shape. */
const oneUnitIn = (id: string, mat: string): LegacyRow => ({
  BTMID: id,
  BTMMAT: mat,
  BTMWAR: "1",
  BTMBAT: null,
  BTMDATE: "2025-12-01",
  BTMSEQ: id,
  BTMROW: "1",
  BTMIN: "1",
  BTMQNT: "1.000000",
  BTMVAL: "12.0000",
});
describe("reconcileCutOver — Phase 9's definition of done, computed (spec:2295, ADR 0086)", () => {
  it("leaves nothing unexplained after the whole corpus load", () => {
    expect(clean.unexplained).toEqual([]);
    expect(clean.ok).toBe(true);
    expect(clean.cutOverDate).toBe("2026-01-31");
  });

  it("compares the trial balance per Dulja account, every figure debit-positive", () => {
    expect(clean.trialBalance.map((r) => [r.key, r.source, r.dulja, r.difference])).toEqual([
      ["1000", "5000.0000", "5000.0000", "0.0000"],
      ["1200", "1800.0000", "1800.0000", "0.0000"],
      ["1300", "2400.0000", "180.0000", "2220.0000"],
      ["2100", "-900.0000", "-900.0000", "0.0000"],
    ]);
    expect(find(clean.trialBalance, "1000").explanation).toBeNull();
    expect(find(clean.trialBalance, "1200").explanation).toBe(
      "supplied by the open-item load, one OPENING_BALANCE per open legacy receivable (ADR 0085): the legacy BILLS total 1800.0000, as the control does",
    );
    // The recost: the legacy inventory control against the recomputation of the movement history (§5.1 #6).
    expect(find(clean.trialBalance, "1300").explanation).toBe(
      "supplied by OPENING_STOCK at the cost 3B's engine recomputes by replaying the legacy movement history (§5.1 #6): 180.0000, while the legacy control holds 2400.0000 — the 2220.0000 between them is the recost — the stored figure, which §5.1 #6 forbids importing, less the recomputation — standing on 3900",
    );
  });

  it("decomposes 3900 into named parts: the legacy imbalance, explained by 9A's report, less the recost", () => {
    // 3900 = Σ differences − legacy imbalance = 2220 − 8300 = −6080 (a credit of 6080): the imbalance 5000 + 1800 +
    // 2400 − 900, less the 2220 the recomputation does not carry.
    expect(clean.suspenseBalance).toBe("-6080.0000");
    const [imbalance, closing] = clean.suspense;
    expect([imbalance!.key, imbalance!.source, imbalance!.difference]).toEqual([
      "legacy imbalance",
      "8300.0000",
      "8300.0000",
    ]);
    expect(imbalance!.explanation).toBe(
      "unbalanced_vouchers: 3 of 3 vouchers do not balance, netting 8300.0000 (LEGACY-003) — posted to 3900",
    );
    expect([closing!.key, closing!.source, closing!.dulja, closing!.difference]).toEqual([
      "3900",
      "-6080.0000",
      "-6080.0000",
      "0.0000",
    ]);
    expect(closing!.explanation).toBe(
      "3900 holds -6080.0000: the trial-balance differences (1300 2220.0000) less the legacy imbalance 8300.0000, each explained on its own row",
    );
  });

  it("compares the stock valuation with the recomputation of the source's own history, not with itself", () => {
    expect(clean.stockValuation.map((r) => [r.key, r.source, r.dulja, r.difference])).toEqual([
      ["WIDGET/MAIN-STORE", "180.0000", "180.0000", "0.0000"],
    ]);
  });

  it("reconciles each employee's YTD to their own payslips without printing a single pay figure (9B T8)", () => {
    expect(clean.employeeYtd.map((r) => [r.key, r.source, r.difference])).toEqual([
      ["YTD:5001", "1 payslip in 2026", "0.0000"],
      ["YTD:5002", "1 payslip in 2026", "0.0000"],
    ]);
    expect(clean.employeeYtd[0]!.dulja).toMatch(/^opening loaded \(legacy:[0-9a-f-]{36}\)$/);
    const text = JSON.stringify(clean.employeeYtd);
    for (const figure of ["36000", "31200", "24000", "21600"]) expect(text).not.toContain(figure);
  });

  it("fails when the legacy imbalance has no report that accounts for it (no VOUITEMS to read)", async () => {
    const rec = await reconcileWith(s, withTable("VOUITEMS", null));
    expect(rec.ok).toBe(false);
    expect(rec.unexplained.map((r) => [r.key, r.difference, r.explanation])).toEqual([
      ["legacy imbalance", "8300.0000", null],
    ]);
  });

  it("explains a control's own legacy drift from its open items, and refuses a difference the open items do not account for", async () => {
    // The legacy control holds 50 more than its open items; VOUITEMS carries the same 50, so the imbalance still matches.
    const acctotals = rowsOf("ACCTOTALS").map((r) =>
      r["ACTACC"] === "1301" ? { ...r, ACTDEBIT: "1850.0000" } : r,
    );
    const vouitems = rowsOf("VOUITEMS").map((r) =>
      r["ACCOUNT"] === "1301" ? { ...r, DEBIT: "1850.0000" } : r,
    );
    const drifted = await reconcileWith(
      s,
      withTable("VOUITEMS", vouitems, withTable("ACCTOTALS", acctotals)),
    );
    expect(drifted.ok).toBe(true);
    expect(find(drifted.trialBalance, "1200").explanation).toBe(
      "supplied by the open-item load, one OPENING_BALANCE per open legacy receivable (ADR 0085): the legacy BILLS total 1800.0000 while the legacy control holds 1850.0000 — the 50.0000 between them is the legacy control's own drift against its open items (LEGACY-001), standing on 3900",
    );
    expect(find(drifted.suspense, "3900").difference).toBe("0.0000");

    // An open item the load did not open (here, one the source holds that Dulja does not) is not explained.
    const bills = [
      ...rowsOf("BILLS"),
      {
        BILID: "5002",
        BILNUMBER: "INV/2025/0500",
        BILACC: "999",
        BILDATE: "2025-12-30",
        BILOPEN: "100.0000",
        BILKIND: "1",
      },
    ];
    const orphaned = await reconcileWith(s, withTable("BILLS", bills));
    expect(orphaned.ok).toBe(false);
    expect(orphaned.unexplained.map((r) => [r.key, r.difference])).toEqual([["1200", "0.0000"]]);
  });

  it("explains the part of 3900 that is ACCTOTALS' own drift from VOUITEMS, read in 9B's spelling (9B review, finding 8)", async () => {
    // The stored total of 1101 says 5050 where its VOUITEMS lines sum to 5000. The load opens what ACCTOTALS says, so
    // the legacy imbalance is 8350: the vouchers' own 8300 (LEGACY-003) plus that 50 of drift (LEGACY-001). Only
    // aggregate_drift can name the 50, and it reads ACCTOTALS by ACTACC/ACTDEBIT/ACTCREDIT, the load's spelling.
    const drifted = withTable(
      "ACCTOTALS",
      rowsOf("ACCTOTALS").map((r) =>
        r["ACTACC"] === "1101" ? { ...r, ACTDEBIT: "5050.0000" } : r,
      ),
    );
    const other = await seedLoadableTenant(db, `reconcile-drift-${randomUUID().slice(0, 8)}`);
    useCorpus(drifted);
    try {
      await runLoad(db.rw, await ctxFor(other));
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
    const rec = await reconcileWith(other, drifted);
    expect(rec.unexplained).toEqual([]);
    expect(rec.ok).toBe(true);
    expect(find(rec.trialBalance, "1000").difference).toBe("0.0000");
    const imbalance = find(rec.suspense, "legacy imbalance");
    expect(imbalance.difference).toBe("8350.0000");
    expect(imbalance.explanation).toBe(
      "aggregate_drift: ACCTOTALS' stored totals less their VOUITEMS recomputation net 50.0000 across 1 account (LEGACY-001) — posted to 3900; unbalanced_vouchers: 3 of 3 vouchers do not balance, netting 8300.0000 (LEGACY-003) — posted to 3900",
    );
    expect(rec.suspenseBalance).toBe("-6130.0000");
    expect(find(rec.suspense, "3900").difference).toBe("0.0000");
  });

  it("refuses a legacy account the map does not name, and keeps the decomposition exact", async () => {
    const acctotals = [
      ...rowsOf("ACCTOTALS"),
      { ACTACC: "9999", ACTDEBIT: "70.0000", ACTCREDIT: "0.0000" },
    ];
    const vouitems = [
      ...rowsOf("VOUITEMS"),
      { SITE: "1", ID: "4", ROW: "1", ACCOUNT: "9999", DEBIT: "70.0000", CREDIT: "0.0000" },
    ];
    const rec = await reconcileWith(
      s,
      withTable("VOUITEMS", vouitems, withTable("ACCTOTALS", acctotals)),
    );
    expect(rec.unexplained.map((r) => [r.key, r.source, r.dulja, r.difference])).toEqual([
      ["legacy 9999", "70.0000", "0.0000", "70.0000"],
    ]);
    expect(find(rec.suspense, "legacy imbalance").explanation).toContain("netting 8370.0000");
    expect(find(rec.suspense, "3900").difference).toBe("0.0000");
  });

  it("refuses a recomputed position Dulja does not hold, and lists a negative pool without failing on it", async () => {
    const receipt = {
      BTMID: "4",
      BTMMAT: "10",
      BTMWAR: "1",
      BTMBAT: "9000",
      BTMDATE: "2025-12-01",
      BTMSEQ: "4",
      BTMROW: "1",
      BTMIN: "1",
      BTMQNT: "1.000000",
      BTMVAL: "12.0000",
    };
    const grown = await reconcileWith(s, withTable("BILLITEMS", [...rowsOf("BILLITEMS"), receipt]));
    expect(grown.unexplained.map((r) => [r.key, r.source, r.dulja, r.difference])).toEqual([
      ["1300", "2400.0000", "180.0000", "2220.0000"],
      ["WIDGET/MAIN-STORE", "192.0000", "180.0000", "12.0000"],
    ]);

    const unknown = { ...receipt, BTMID: "5", BTMMAT: "77", BTMBAT: null };
    const issue = {
      ...receipt,
      BTMID: "6",
      BTMMAT: "11",
      BTMWAR: "2",
      BTMBAT: null,
      BTMIN: "0",
      BTMQNT: "3.000000",
      BTMVAL: null,
    };
    const rec = await reconcileWith(
      s,
      withTable("BILLITEMS", [...rowsOf("BILLITEMS"), unknown, issue]),
    );
    expect(rec.unexplained.map((r) => r.key)).toEqual([
      "1300",
      "legacy material 77 in warehouse 1",
    ]);
    const negative = find(rec.stockValuation, "legacy material 11 in warehouse 2");
    expect([negative.source, negative.dulja, negative.difference]).toEqual([
      "0.0000",
      "0.0000",
      "0.0000",
    ]);
    expect(negative.explanation).toContain("drives it to -3");
  });

  it("explains a position the load read and reported by the skip register — opening stock is one-shot (9B review, finding 3)", async () => {
    // A material that never imported (77) and a service (12): the load reads both and opens neither.
    const source = withTable("BILLITEMS", [
      ...rowsOf("BILLITEMS"),
      oneUnitIn("4", "77"),
      { ...oneUnitIn("5", "12"), BTMVAL: "5.0000" },
    ]);
    const other = await seedLoadableTenant(db, `reconcile-reported-${randomUUID().slice(0, 8)}`);
    useCorpus(source);
    try {
      const report = await runLoad(db.rw, await ctxFor(other));
      expect(
        report.skips
          .filter((k) => k.loader === "opening_stock")
          .map((k) => k.sourceKey)
          .toSorted(),
      ).toEqual(["12/1", "77/1"]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
    const rec = await reconcileWith(other, source);
    expect(rec.unexplained).toEqual([]);
    const unknown = find(rec.stockValuation, "legacy material 77 in warehouse 1");
    expect([unknown.source, unknown.dulja, unknown.difference]).toEqual([
      "12.0000",
      "0.0000",
      "12.0000",
    ]);
    expect(unknown.explanation).toBe(
      "the opening-stock load read this position (77/1) and reported rather than opened it — the skip register (skips.csv) names each and why. Opening stock is one-shot, so a re-run never opens it: count it with a STOCK_COUNT after cut-over (9B review, finding 3)",
    );
    const service = find(rec.stockValuation, "DELIVERY/MAIN-STORE");
    expect([
      service.difference,
      service.explanation?.startsWith("the opening-stock load read"),
    ]).toEqual(["5.0000", true]);
    // The inventory control: Dulja holds the recomputation less exactly what the skip register names.
    expect(find(rec.trialBalance, "1300").explanation).toContain(
      "; 17.0000 of the recomputation is in positions the load reported and did not open (the skip register; see stockValuation), which a STOCK_COUNT opens after cut-over",
    );
    expect(find(rec.suspense, "3900").difference).toBe("0.0000");
  });

  it("refuses a YTD that does not reconcile to the payslips, naming the figure and never its value", async () => {
    const payitems = rowsOf("PAYITEMS").map((r) =>
      r["PITEMP"] === "5001" ? { ...r, PITGROSS: "35000.0000" } : r,
    );
    const rec = await reconcileWith(s, withTable("PAYITEMS", payitems));
    expect(rec.unexplained.map((r) => [r.key, r.difference])).toEqual([["YTD:5001", "gross"]]);
    const text = JSON.stringify(rec);
    for (const figure of ["35000", "36000", "31200"]) expect(text).not.toContain(figure);
  });

  it("refuses a balance account the opening did not post, and a withheld YTD opening (a second tenant)", async () => {
    const other = await seedLoadableTenant(db, `reconcile-partial-${randomUUID().slice(0, 8)}`);
    const employees = rowsOf("EMPLOYEES").map((r) =>
      r["EMPID"] === "5001" ? { ...r, EMPYTDGROSS: "35000.0000" } : r,
    );
    const source = withTable("EMPLOYEES", employees);
    useCorpus(source);
    try {
      const only = [
        "unit_of_measure",
        "warehouse",
        "account",
        "party",
        "employee",
        "item",
        "open_item",
        "employee_ytd_opening",
        "lot",
        "opening_stock",
      ];
      await runLoad(db.rw, await ctxFor(other, { only }));
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
    const rec = await reconcileWith(other, source);
    expect(rec.ok).toBe(false);
    expect(rec.unexplained.map((r) => [r.key, r.difference])).toEqual([
      ["1000", "5000.0000"],
      ["YTD:5001", "no opening"],
    ]);
    expect(find(rec.employeeYtd, "YTD:5001").dulja).toBe(
      "no opening (withheld — the skip register names it)",
    );
    // 3900 holds only what the sub-ledgers put there, and the decomposition still closes to the cent.
    expect(rec.suspenseBalance).toBe("-1080.0000");
    expect(find(rec.suspense, "3900").difference).toBe("0.0000");
  });

  it("refuses an account map that puts a legacy account on 3900, and a source without the open items it needs", async () => {
    const map = accountMap();
    setAccountMap({
      ...map,
      entries: [
        ...map.entries,
        {
          legacyCode: "3999",
          code: "3900",
          nameEn: "Opening-balance suspense",
          nameAr: null,
          type: "equity",
          treatment: "balance",
          note: null,
        },
      ],
    });
    try {
      await expect(reconcileWith(s, loadCorpus("cut-over"))).rejects.toThrow(
        /^ERR_VALIDATION_FAILED: legacy account 3999 is mapped onto 3900/,
      );
    } finally {
      setAccountMap(map);
    }
    await expect(reconcileWith(s, withTable("BILLS", null))).rejects.toThrow(
      /^ERR_IMPORT_SOURCE_UNREADABLE: the source has no BILLS/,
    );
  });
});

describe("the CLI's reconcile-cut-over — exit 0 when everything is explained, 4 when anything is not (9B plan N9)", () => {
  /** Runs the command against `seed` and the committed `cut-over` corpus; answers its exit code, what it printed, and
   *  the artefact directory it wrote (removed afterwards with the load runs). */
  async function command(seed: Seed): Promise<{ code: number; printed: string[]; dir: string }> {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const saved = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = db.url("app_rw");
    try {
      const code = await main([
        "reconcile-cut-over",
        "--fixture",
        "cut-over",
        "--tenant-id",
        seed.tenant,
        "--company-id",
        seed.company,
        "--cut-over-date",
        "2026-01-31",
        "--account-map",
        MAP,
      ]);
      const printed = log.mock.calls.map((call) => call.map(String).join(" "));
      const dir = (printed.at(-1) ?? "").split(" -> ")[1] ?? "";
      runs.push(dir.split("/").at(-1) ?? "");
      return { code, printed, dir };
    } finally {
      log.mockRestore();
      if (saved === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = saved;
      // The command clears the map it read; the suite's own map is put back for the cases after it.
      setAccountMap(readAccountMap(MAP));
    }
  }

  it("exits 0 after a clean load and writes the sign-off artefact with its sha256 in index.json", async () => {
    const { code, printed, dir } = await command(s);
    expect(code).toBe(0);
    expect(printed[0]).toBe(
      "cut-over 2026-01-31 — 4 trial-balance rows, 1 stock rows, 2 employees; 3900 = -6080.0000 (debit-positive); 0 unexplained",
    );
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as ArtefactIndex;
    expect(index.artefacts.map((a) => a.name)).toEqual([
      "cut-over-reconciliation.json",
      "cut-over-reconciliation.csv",
      "index.json",
    ]);
    expect(index.artefacts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const written = JSON.parse(
      readFileSync(join(dir, "cut-over-reconciliation.json"), "utf8"),
    ) as CutOverReconciliation;
    expect(written.ok).toBe(true);
    const csv = readFileSync(join(dir, "cut-over-reconciliation.csv"), "utf8");
    for (const figure of ["36000", "31200", "24000", "21600"]) expect(csv).not.toContain(figure);
  });

  it("exits 4 and names every unexplained row when the tenant holds nothing the source does", async () => {
    const empty = await seedLoadableTenant(db, `reconcile-empty-${randomUUID().slice(0, 8)}`);
    const { code, printed } = await command(empty);
    expect(code).toBe(4);
    expect(
      printed.filter((line) => line.startsWith("unexplained: ")).map((line) => line.split(" ")[1]),
    ).toEqual(["1000", "1200", "1300", "2100", "legacy", "YTD:5001", "YTD:5002"]);
    // Nothing loaded, so 3900 holds nothing — and that is exactly Σ differences − the imbalance (8300 − 8300): the
    // decomposition still closes, and every part of it is a row above that is not explained.
    expect(printed[0]).toMatch(/; 3900 = 0\.0000 \(debit-positive\); 7 unexplained$/);
  });
});
