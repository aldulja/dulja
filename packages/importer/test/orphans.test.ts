import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { createReader } from "../src/reader";
import { reconcile } from "../src/reconcile";
import { ORPHAN_RULES } from "../src/reconcile/orphans";
import { loadCorpus } from "./support/corpus";

const reader = () => createReader(new FixtureLegacyDriver(loadCorpus()));

describe("reconcile('orphans') — §5.1 #3, 'report orphans; do not silently null them'", () => {
  it("names each dangling reference with the child row that holds it", async () => {
    const report = await reconcile(await reader(), "orphans");
    expect(report.kind).toBe("orphans");
    expect(report.rows).toContainEqual({
      rule: "VOUITEMS.JOB",
      childTable: "VOUITEMS",
      value: "99",
      occurrences: 1,
      parentTable: "JOBS",
      status: "orphan",
      note: "Job is 82% unconstrained across the shipped schema (SAH-073); the shipped fixes/fix-Jobs.sql exists because orphans occur.",
    });
  });

  it("treats 0 and the empty string as 'not set', never as a dangling key", async () => {
    const report = await reconcile(await reader(), "orphans");
    expect(report.rows.filter((r) => r.rule === "VOUITEMS.JOB" && r.value === "0")).toEqual([]);
  });

  it("skips a rule whose parent or child table is not in this database, and says which", async () => {
    const report = await reconcile(await reader(), "orphans");
    expect(report.rows).toContainEqual(
      expect.objectContaining({ rule: "BILLITEMS.MATERIAL", status: "source_absent" }),
    );
    expect(report.summary.rules).toBe(String(ORPHAN_RULES.length));
    expect(report.summary.orphanedValues).toBe("1");
    expect(report.summary.orphanedRows).toBe("1");
  });

  it("names a rule that ran and found nothing as clean, so a pass is visible and not merely absent", async () => {
    const report = await reconcile(await reader(), "orphans");
    // Accounts 10 and 11 and vouchers 1|1 and 1|2 all resolve.
    expect(report.rows).toContainEqual(
      expect.objectContaining({ rule: "VOUITEMS.ACCOUNT", value: null, status: "clean" }),
    );
    expect(report.rows).toContainEqual(
      expect.objectContaining({ rule: "VOUITEMS.VOUCHER", value: null, status: "clean" }),
    );
    // Every rule is accounted for: each is source_absent, clean, or has one row per dangling value.
    for (const rule of ORPHAN_RULES) expect(report.rows.some((r) => r.rule === rule.id)).toBe(true);
    const status = (s: string) => String(report.rows.filter((r) => r.status === s).length);
    expect(report.summary.skipped).toBe(status("source_absent"));
    expect(report.summary.clean).toBe(status("clean"));
  });

  it("orders dangling values numerically and checks a composite key as a whole", async () => {
    const corpus = loadCorpus();
    const items = corpus.tables.VOUITEMS!;
    const extra = [
      { ...items.rows[0]!, ID: "10", ROW: "1", JOB: "100" },
      { ...items.rows[0]!, ID: "9", ROW: "1", JOB: "9" },
      { ...items.rows[0]!, ID: "9", ROW: "2", JOB: "9" },
    ];
    const grown = await createReader(
      new FixtureLegacyDriver({
        ...corpus,
        tables: { ...corpus.tables, VOUITEMS: { ...items, rows: [...items.rows, ...extra] } },
      }),
    );
    const report = await reconcile(grown, "orphans");
    const jobs = report.rows.filter((r) => r.rule === "VOUITEMS.JOB");
    expect(jobs.map((r) => [r.value, r.occurrences])).toEqual([
      ["9", 2],
      ["99", 1],
      ["100", 1],
    ]);
    // Vouchers 1|9 and 1|10 have lines and no header: the (SITE, ID) pair is what dangles.
    expect(
      report.rows.filter((r) => r.rule === "VOUITEMS.VOUCHER").map((r) => [r.value, r.occurrences]),
    ).toEqual([
      ["1|9", 2],
      ["1|10", 1],
    ]);
    expect(report.summary.orphanedValues).toBe("5");
    expect(report.summary.orphanedRows).toBe("7");
  });
});
