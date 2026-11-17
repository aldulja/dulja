import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { createReader } from "../src/reader";
import { reconcile } from "../src/reconcile";
import { NULL_POISON_TARGETS } from "../src/reconcile/null-poison";
import { loadCorpus } from "./support/corpus";

const reader = () => createReader(new FixtureLegacyDriver(loadCorpus()));

describe("reconcile('null_poison') — §5.1 #4, LEGACY-007 and LEGACY-011", () => {
  it("counts NULLs in every figure column that a report would silently render as zero", async () => {
    const report = await reconcile(await reader(), "null_poison");
    expect(report.kind).toBe("null_poison");
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        table: "ACCTOTALS",
        column: "CREDIT",
        nulls: 1,
        rows: 2,
        status: "poisoned",
      }),
    );
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        table: "MATOBJECTS",
        column: "QNT",
        nulls: 1,
        rows: 3,
        status: "poisoned",
      }),
    );
    // Task 7's ACCOBJECTS row carries null opening figures, which is the same defect on the opening side —
    // and the reason `poisonedColumns` is four and not two.
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        table: "ACCOBJECTS",
        column: "OPENDEBIT",
        nulls: 1,
        rows: 1,
        status: "poisoned",
      }),
    );
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        table: "ACCOBJECTS",
        column: "OPENCREDIT",
        nulls: 1,
        rows: 1,
        status: "poisoned",
      }),
    );
    expect(report.rows).toContainEqual(
      expect.objectContaining({ table: "ACCTOTALS", column: "DEBIT", nulls: 0, status: "clean" }),
    );
    // A target table the corpus does not hold is named, never silently counted clean.
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        table: "MATCOSTS",
        column: "COST",
        nulls: 0,
        rows: 0,
        status: "source_absent",
      }),
    );
    // A column missing from a table that is present is absent on its own; its siblings are still counted.
    expect(report.rows).toContainEqual(
      expect.objectContaining({ table: "VOUITEMS", column: "LOCALDEBIT", status: "source_absent" }),
    );
    expect(report.rows).toContainEqual(
      expect.objectContaining({ table: "VOUITEMS", column: "DEBIT", rows: 4, status: "clean" }),
    );
  });

  it("has exactly one row per target column, in the declared order", async () => {
    const report = await reconcile(await reader(), "null_poison");
    expect(report.rows.map((r) => [r.table, r.column].join("."))).toEqual(
      NULL_POISON_TARGETS.flatMap((t) => t.columns.map((c) => [t.table, c].join("."))),
    );
  });

  it("summarises the blast radius in strings", async () => {
    const report = await reconcile(await reader(), "null_poison");
    // ACCTOTALS.CREDIT (nulled in Step 1), ACCOBJECTS.OPENDEBIT, ACCOBJECTS.OPENCREDIT (Task 7's corpus row)
    // and MATOBJECTS.QNT — one NULL each.
    expect(report.summary.poisonedColumns).toBe("4");
    expect(report.summary.poisonedValues).toBe("4");
    expect(report.summary.columns).toBe(String(report.rows.length));
    expect(report.summary.note).toContain("blank or zero, not as errors");
    expect(Object.values(report.summary).every((v) => typeof v === "string")).toBe(true);
  });
});
