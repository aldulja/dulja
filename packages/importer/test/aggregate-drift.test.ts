import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { AGGREGATE_RULES } from "../src/legacy/aggregates";
import { createReader, type LegacyReader } from "../src/reader";
import { reconcile, RECONCILIATION_KINDS } from "../src/reconcile";
import { hasColumns } from "../src/reconcile/probe";
import { loadCorpus } from "./support/corpus";

const reader = () => createReader(new FixtureLegacyDriver(loadCorpus()));

describe("AGGREGATE_RULES — every recomputed figure carries its own derivation (spec:2295)", () => {
  it("labels each rule verified, hypothesis or not_derivable, and never silently guesses", () => {
    for (const rule of AGGREGATE_RULES) {
      expect(rule.derivation.length).toBeGreaterThan(20);
      expect(rule.legacyDefects.length).toBeGreaterThan(0);
      if (rule.confidence === "not_derivable") expect(rule.sourceTable).toBeNull();
      else expect(rule.sourceTable).not.toBeNull();
    }
    expect(new Set(AGGREGATE_RULES.map((r) => r.id)).size).toBe(AGGREGATE_RULES.length);
    // The columns whose routing lives in the 318 triggers and the fifteen unexamined DLLs (spec:71).
    expect(
      AGGREGATE_RULES.filter((r) => r.confidence === "not_derivable").map((r) => r.id),
    ).toEqual([
      "ACCTOTALS.ADMINDEBIT",
      "ACCTOTALS.ADMINCREDIT",
      "ACCOBJECTS.OPENDEBIT",
      "ACCOBJECTS.OPENCREDIT",
      "MATTOTALS.INTERNALDEBIT",
      "MATTOTALS.INTERNALCREDIT",
      "MATTOTALS.ORDERDEBIT",
      "MATTOTALS.ORDERCREDIT",
      "MATTOTALS.TRANSFERREDDEBIT",
      "MATTOTALS.TRANSFERREDCREDIT",
      "MATCOSTS.COST",
      "MATCOSTS.BUY",
      "MATSTATUS.LASTPRICE",
    ]);
  });
});

describe("hasColumns — the catalogue question LegacyReader cannot ask", () => {
  it("answers true for declared columns, false for an undeclared column or table, and reads no row", async () => {
    const r = await reader();
    expect(await hasColumns(r, "VOUITEMS", ["ACCOUNT", "DEBIT"])).toBe(true);
    expect(await hasColumns(r, "VOUITEMS", ["ACCOUNT", "CUR"])).toBe(false);
    expect(await hasColumns(r, "BILLITEMS", ["QNT"])).toBe(false);
    // A successful probe transfers no row: on the live driver a row-returning probe would read the whole table.
    let yielded = 0;
    const counting: LegacyReader = {
      firebirdVersion: r.firebirdVersion,
      tables: () => r.tables(),
      count: (table) => r.count(table),
      dateRange: (table, column) => r.dateRange(table, column),
      read: <T>(table: string, opts: Parameters<typeof r.read>[1]): AsyncIterable<T[]> => ({
        async *[Symbol.asyncIterator]() {
          for await (const rows of r.read<T>(table, opts)) {
            yielded += rows.length;
            yield rows;
          }
        },
      }),
    };
    expect(await hasColumns(counting, "VOUITEMS", ["ACCOUNT", "DEBIT"])).toBe(true);
    expect(yielded).toBe(0);
    // An empty table still has its columns.
    const corpus = loadCorpus();
    const empty = await createReader(
      new FixtureLegacyDriver({
        ...corpus,
        tables: { ...corpus.tables, VOUITEMS: { ...corpus.tables.VOUITEMS!, rows: [] } },
      }),
    );
    expect(await hasColumns(empty, "VOUITEMS", ["ACCOUNT", "DEBIT"])).toBe(true);
  });

  it('propagates a source that fails for any other reason — a lost connection is not "column absent" (2026-11-15 review, HRP-22)', async () => {
    const r = await reader();
    const failing: LegacyReader = {
      ...r,
      tables: () => r.tables(),
      count: (table) => r.count(table),
      dateRange: (table, column) => r.dateRange(table, column),
      read: <T>(): AsyncIterable<T[]> => ({
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              Promise.reject(new Error("ERR_IMPORT_SOURCE_UNREADABLE: connection lost (08006)")),
          };
        },
      }),
    };
    await expect(hasColumns(failing, "VOUITEMS", ["ACCOUNT", "DEBIT"])).rejects.toThrow(
      /connection lost/,
    );
  });
});

describe("reconcile('aggregate_drift') — §5.1 #1, do not trust stored aggregates", () => {
  it("reports a stored figure that differs from the recomputed one, with the difference signed", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    expect(report.kind).toBe("aggregate_drift");
    expect(report.rows).toContainEqual({
      rule: "ACCTOTALS.DEBIT",
      key: "10",
      stored: "300.0000",
      recomputed: "350.0000",
      difference: "-50.0000",
      status: "drift",
      confidence: "hypothesis",
      derivation: "sum(VOUITEMS.DEBIT) grouped by ACCOUNT, compared with ACCTOTALS.DEBIT",
    });
  });

  it("reads a NULL stored figure as zero against the recomputed one — the poison 9A T10 counts", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    // ACCTOTALS' account 11 CREDIT is NULL in the corpus (LEGACY-011); VOUITEMS recomputes 100.0000.
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        rule: "ACCTOTALS.CREDIT",
        key: "11",
        stored: "0.0000",
        recomputed: "100.0000",
        difference: "-100.0000",
        status: "drift",
      }),
    );
  });

  it("reports a source key with no stored row at all, carrying the figure that was never accumulated", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    // VOUITEMS holds two lines on account 11 within SITE 1 — DEBIT 0.0000 and 250.0000 — and ACCOBJECTS has no
    // (1, 11) row for them at all: the decrement that never fired, not a figure that drifted.
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        rule: "ACCOBJECTS.DEBIT",
        key: "1|11",
        stored: null,
        recomputed: "250.0000",
        status: "missing_stored_row",
      }),
    );
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        rule: "ACCOBJECTS.CREDIT",
        key: "1|11",
        stored: null,
        recomputed: "100.0000",
        status: "missing_stored_row",
      }),
    );
  });

  it("emits one row per not_derivable rule saying exactly what the owner must confirm", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        rule: "ACCTOTALS.ADMINDEBIT",
        status: "not_derivable",
        stored: null,
        recomputed: null,
      }),
    );
  });

  it("marks a rule whose source table or column is absent as unavailable rather than passing", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        rule: "MATTOTALS.DEBIT",
        status: "source_absent",
        detail: "BILLITEMS, MATTOTALS",
      }),
    );
  });

  it("reports a stored key the source never produced as drift against zero", async () => {
    const corpus = loadCorpus();
    const orphan = await createReader(
      new FixtureLegacyDriver({
        ...corpus,
        tables: {
          ...corpus.tables,
          ACCTOTALS: {
            ...corpus.tables.ACCTOTALS!,
            rows: [
              ...corpus.tables.ACCTOTALS!.rows,
              {
                ACCOUNT: "99",
                DEBIT: "7.5000",
                CREDIT: "0.0000",
                ADMINDEBIT: null,
                ADMINCREDIT: null,
              },
            ],
          },
        },
      }),
    );
    const report = await reconcile(orphan, "aggregate_drift");
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        rule: "ACCTOTALS.DEBIT",
        key: "99",
        status: "drift",
        stored: "7.5000",
        recomputed: "0.0000",
        difference: "7.5000",
      }),
    );
  });

  it("summarises in strings, because the summary is read by a person", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    expect(report.summary).toEqual({
      rules: "23",
      compared: "6",
      drifting: "2",
      missingStoredRows: "2",
      notDerivable: "13",
      sourceAbsent: "6",
      note: "Recomputed figures are labelled hypothesis until the live database confirms the routing; the 13 not_derivable columns need the owner (§5.1 #1).",
    });
    expect(report.rows).toHaveLength(23);
  });

  it("knows exactly six kinds — the closed union of contracts §4.13.1", () => {
    expect([...RECONCILIATION_KINDS]).toEqual([
      "aggregate_drift",
      "unbalanced_vouchers",
      "orphans",
      "null_poison",
      "duplicate_aggregates",
      "employee_mapping",
    ]);
  });
});

const cutOver = () => createReader(new FixtureLegacyDriver(loadCorpus("cut-over")));
const of = (rows: readonly Record<string, unknown>[], rule: string) =>
  rows.filter((r) => r["rule"] === rule);

describe("9A's rules read 9B's prefixed spelling where the source has it (9B review, finding 8)", () => {
  // The cut-over corpus is spelled as 9B's loaders read it: ACCTOTALS(ACTACC, ACTDEBIT, ACTCREDIT), BILLITEMS(BTMMAT,
  // BTMWAR, BTMQNT…), MATERIALS(MATID…), WAREHOUSES(WARID…). Every name below is one a 9A or 9B plan writes.

  it("compares ACCTOTALS by ACTACC/ACTDEBIT/ACTCREDIT instead of reporting it source_absent", async () => {
    const report = await reconcile(await cutOver(), "aggregate_drift");
    for (const rule of ["ACCTOTALS.DEBIT", "ACCTOTALS.CREDIT"])
      expect(of(report.rows, rule).map((r) => r["status"])).not.toContain("source_absent");
    // The four stored totals agree with their VOUITEMS lines, account by account, on both sides.
    expect(report.summary["compared"]).toBe("8");
    expect(of(report.rows, "ACCTOTALS.DEBIT")).toEqual([]);
    expect(of(report.rows, "ACCTOTALS.CREDIT")).toEqual([]);
  });

  it("reports a stored total that drifts, in 9B's spelling, keyed by the chart code", async () => {
    const corpus = loadCorpus("cut-over");
    const acctotals = corpus.tables["ACCTOTALS"]!;
    const drifted = {
      ...corpus,
      tables: {
        ...corpus.tables,
        ACCTOTALS: {
          ...acctotals,
          rows: acctotals.rows.map((r) =>
            r["ACTACC"] === "1101" ? { ...r, ACTDEBIT: "5050.0000" } : r,
          ),
        },
      },
    };
    const report = await reconcile(
      await createReader(new FixtureLegacyDriver(drifted)),
      "aggregate_drift",
    );
    expect(of(report.rows, "ACCTOTALS.DEBIT")).toEqual([
      expect.objectContaining({
        key: "1101",
        status: "drift",
        stored: "5050.0000",
        recomputed: "5000.0000",
        difference: "50.0000",
        derivation:
          "sum(VOUITEMS.DEBIT) grouped by ACCOUNT, compared with ACCTOTALS.DEBIT (read as ACCTOTALS.ACTDEBIT by ACTACC, the source's spelling)",
      }),
    ]);
  });

  it("still prefers the 9A spelling, and stays source_absent when neither spelling is there", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    expect(of(report.rows, "ACCTOTALS.DEBIT")[0]).toMatchObject({ key: "10", status: "drift" });
    const mpos = await reconcile(
      await createReader(new FixtureLegacyDriver(loadCorpus("mpos"))),
      "aggregate_drift",
    );
    expect(of(mpos.rows, "ACCTOTALS.DEBIT").map((r) => r["status"])).toEqual(["source_absent"]);
  });

  it("counts ACCTOTALS' and BILLITEMS' NULLs under ACTDEBIT, ACTCREDIT and BTMQNT", async () => {
    const report = await reconcile(await cutOver(), "null_poison");
    const row = (table: string, column: string) =>
      report.rows.find((r) => r["table"] === table && r["column"] === column);
    expect(row("ACCTOTALS", "ACTDEBIT")).toMatchObject({ status: "clean", rows: 4 });
    expect(row("ACCTOTALS", "ACTCREDIT")).toMatchObject({ status: "clean", rows: 4 });
    expect(row("BILLITEMS", "BTMQNT")).toMatchObject({ status: "clean" });
    // A column neither spelling names stays reported under the 9A name.
    expect(row("ACCTOTALS", "ADMINDEBIT")).toMatchObject({ status: "source_absent" });
  });

  it("checks ACCTOTALS for duplicate keys by ACTACC", async () => {
    const report = await reconcile(await cutOver(), "duplicate_aggregates");
    expect(report.rows.find((r) => r["table"] === "ACCTOTALS")).toMatchObject({
      status: "clean",
      naturalKey: "ACTACC",
      tableRows: 4,
    });
  });

  it("checks BILLITEMS' material and warehouse against MATERIALS.MATID and WAREHOUSES.WARID", async () => {
    const report = await reconcile(await cutOver(), "orphans");
    const status = (id: string) =>
      report.rows.filter((r) => r["rule"] === id).map((r) => r["status"]);
    expect(status("BILLITEMS.MATERIAL")).toEqual(["clean"]);
    expect(status("BILLITEMS.WAREHOUSE")).toEqual(["clean"]);
  });
});
