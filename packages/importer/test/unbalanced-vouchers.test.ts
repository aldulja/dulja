import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import type { LegacyCorpus } from "../src/drivers/fixture";
import { createReader } from "../src/reader";
import { reconcile } from "../src/reconcile";
import { SUSPENSE_QUESTION } from "../src/reconcile/unbalanced-vouchers";
import { loadCorpus } from "./support/corpus";

/** A one-line credit-only voucher on account 11 — unbalanced by construction. */
const credit = (id: string, amount: string) => ({
  SITE: "1",
  ID: id,
  ROW: "1",
  ACCOUNT: "11",
  JOB: "0",
  COSTCENTRE: null,
  DEBIT: "0.0000",
  CREDIT: amount,
});

const run = async (corpus: LegacyCorpus = loadCorpus()) =>
  reconcile(await createReader(new FixtureLegacyDriver(corpus)), "unbalanced_vouchers");

describe("reconcile('unbalanced_vouchers') — §5.1 #2, LEGACY-003 'nothing enforces debits = credits'", () => {
  it("names each unbalanced voucher, signs the imbalance, and dates it from its header", async () => {
    const report = await run();
    expect(report.kind).toBe("unbalanced_vouchers");
    // Voucher (1,1) balances: 100 debit, 100 credit. Voucher (1,2) is 500 debit, 0 credit.
    expect(report.rows).toEqual([
      {
        voucher: "1|2",
        date: "2024-03-02",
        lines: 2,
        debit: "500.0000",
        credit: "0.0000",
        imbalance: "500.0000",
        accounts: "10,11",
      },
    ]);
  });

  it("quantifies the whole population, because the owner decides on the total and not on one row", async () => {
    const report = await run();
    expect(report.summary.status).toBe("compared");
    expect(report.summary.vouchers).toBe("2");
    expect(report.summary.unbalanced).toBe("1");
    expect(report.summary.absoluteImbalance).toBe("500.0000");
    expect(report.summary.netImbalance).toBe("500.0000");
    expect(report.summary.largest).toBe("1|2 500.0000");
    expect(report.summary.dateRange).toBe("2024-03-02..2024-03-02");
    expect(report.summary.question).toContain("suspense account");
    // Input to OD-25, not the decision: the question is carried verbatim and no treatment is proposed.
    expect(report.summary.question).toBe(SUSPENSE_QUESTION);
    expect(Object.keys(report.summary)).not.toContain("treatment");
    for (const value of Object.values(report.summary)) expect(typeof value).toBe("string");
  });

  it("nets opposite imbalances but sums their absolute size, and names the largest by magnitude", async () => {
    const corpus = loadCorpus();
    const items = corpus.tables.VOUITEMS!;
    const widened: LegacyCorpus = {
      ...corpus,
      tables: {
        ...corpus.tables,
        VOUITEMS: {
          ...items,
          rows: [...items.rows, credit("3", "700.0000"), credit("4", "0.0001")],
        },
      },
    };
    const report = await run(widened);
    expect(report.rows.map((r) => [r.voucher, r.imbalance, r.date])).toEqual([
      ["1|2", "500.0000", "2024-03-02"],
      // No header in VOUCHERS: the line is still reported, undated rather than dropped.
      ["1|3", "-700.0000", ""],
      ["1|4", "-0.0001", ""],
    ]);
    expect(report.summary.absoluteImbalance).toBe("1200.0001");
    expect(report.summary.netImbalance).toBe("-200.0001");
    expect(report.summary.largest).toBe("1|3 -700.0000");
    expect(report.summary.dateRange).toBe("2024-03-02..2024-03-02");
  });

  it("reports nothing unbalanced when every voucher balances, and says so", async () => {
    const corpus = loadCorpus();
    const items = corpus.tables.VOUITEMS!;
    const balanced: LegacyCorpus = {
      ...corpus,
      tables: { ...corpus.tables, VOUITEMS: { ...items, rows: items.rows.slice(0, 2) } },
    };
    const report = await run(balanced);
    expect(report.rows).toEqual([]);
    expect(report.summary.unbalanced).toBe("0");
    expect(report.summary.largest).toBe("none");
    expect(report.summary.dateRange).toBe("unknown");
  });

  it("reports the source as absent rather than reporting zero unbalanced vouchers", async () => {
    const corpus = loadCorpus();
    const without = {
      ...corpus,
      tables: Object.fromEntries(Object.entries(corpus.tables).filter(([t]) => t !== "VOUITEMS")),
    };
    const report = await run(without);
    expect(report.summary.status).toBe("source_absent");
    expect(report.summary.question).toBe(SUSPENSE_QUESTION);
    expect(report.rows).toEqual([]);
  });
});
