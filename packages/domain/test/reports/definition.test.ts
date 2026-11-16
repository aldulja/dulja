import { describe, expect, it } from "vitest";
import {
  REPORT_CODE_PATTERN,
  REPORT_FILTER_OPS,
  ReportDefinitionError,
  isReportCode,
  moduleOfReportCode,
  parseReportDefinition,
  reportCode,
  validateReportDefinition,
} from "../../src/reports";

const DATASETS = new Set(["account_balance", "ledger_entry", "stock_on_hand"]);
const PERMISSIONS = new Set([
  "accounting.report.read",
  "accounting.report.export",
  "inventory.stock.read",
]);
const SETS = { datasets: DATASETS, permissions: PERMISSIONS };

/** A minimal but complete definition. Every later test derives from it by one edit. */
function base() {
  return {
    version: 1,
    code: "accounting.trial_balance",
    nameEn: "Trial balance",
    nameAr: "ميزان المراجعة",
    module: "accounting",
    permission: "accounting.report.read",
    parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
    dataset: {
      source: "account_balance",
      filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }],
    },
    columns: [
      // `account_type` is FIRST and is a real column, because `groups[0].field` below names it and validator
      // rule 4 refuses a group field that is not one of the definition's own columns. Every later `it` in this
      // file derives from `base()` by one edit and asserts an EXACT `errors` array, so a base definition that
      // was itself invalid would fail roughly eight of them.
      {
        field: "account_type",
        labelEn: "Type",
        labelAr: "النوع",
        format: "text",
        align: "start",
        width: 90,
      },
      {
        field: "account_code",
        labelEn: "Code",
        labelAr: "الرمز",
        format: "text",
        align: "start",
        width: 80,
      },
      { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
      { field: "base_credit", labelEn: "Credit", labelAr: "دائن", format: "money", align: "end" },
    ],
    groups: [{ field: "account_type", subtotal: true }],
    totals: [
      { field: "base_debit", fn: "sum" },
      { field: "base_credit", fn: "sum" },
    ],
    sort: [{ field: "account_code", dir: "asc" }],
    layout: {
      orientation: "portrait",
      paper: "A4",
      header: "{nameEn} — {fiscalPeriodId}",
      footer: "{page}",
    },
    tieOut: { kind: "ledger_sum" },
  };
}

describe("the ReportCode grammar — contracts §4.16.1", () => {
  it("accepts exactly two segments whose first is a module", () => {
    for (const code of [
      "accounting.trial_balance",
      "inventory.stock_on_hand",
      "pos.z_report",
      "hr.payslip",
    ]) {
      expect(REPORT_CODE_PATTERN.test(code), code).toBe(true);
      expect(isReportCode(code), code).toBe(true);
    }
  });

  it("refuses a three-segment permission-shaped code, an unknown module, and a short tail", () => {
    for (const bad of [
      "accounting.report.read", // three segments — a permission code, not a report code
      "admin.data_export", // 'admin' is not a report module (§4.16.1)
      "accounting.ab", // the tail needs at least three characters
      "accounting.Trial_Balance", // upper case
      "accounting.trial-balance", // hyphen
      "accounting.",
      "trial_balance",
    ]) {
      expect(REPORT_CODE_PATTERN.test(bad), bad).toBe(false);
      expect(isReportCode(bad), bad).toBe(false);
      expect(() => reportCode(bad), bad).toThrow(ReportDefinitionError);
    }
  });

  it("reads the module off the code, so a definition can never disagree with it", () => {
    expect(moduleOfReportCode("inventory.stock_ageing")).toBe("inventory");
    expect(() => moduleOfReportCode("nope.x_y")).toThrow(ReportDefinitionError);
  });
});

describe("REPORT_FILTER_OPS", () => {
  it("is the eight operators of §4.11.1 in a fixed order", () => {
    expect([...REPORT_FILTER_OPS]).toEqual(["eq", "ne", "lt", "lte", "gt", "gte", "in", "like"]);
  });
});

describe("validateReportDefinition — contracts §4.11.1", () => {
  it("accepts the base definition", () => {
    expect(validateReportDefinition(base(), SETS)).toEqual({ ok: true, errors: [] });
  });

  it("refuses a dataset id outside the closed registry, naming the JSON path", () => {
    const def = base();
    def.dataset.source = "invoices";
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        path: "/dataset/source",
        message:
          "dataset 'invoices' is not a member of the closed DatasetId registry (contracts §4.16.2)",
      },
    ]);
  });

  it("refuses a permission code no slice has seeded (F-21)", () => {
    const def = base();
    def.permission = "accounting.report.print";
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        path: "/permission",
        message: "permission 'accounting.report.print' is not in the permission catalogue",
      },
    ]);
  });

  it("refuses a module that disagrees with the code's first segment", () => {
    const def = base();
    def.module = "inventory";
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        path: "/module",
        message:
          "module 'inventory' disagrees with code 'accounting.trial_balance' (contracts §4.16.1)",
      },
    ]);
  });

  it("refuses a filter naming a parameter the definition does not declare", () => {
    const def = base();
    def.dataset.filters = [{ field: "fiscal_period_id", op: "eq", param: "periodId" }];
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        path: "/dataset/filters/0/param",
        message: "filter references parameter 'periodId', which the definition does not declare",
      },
    ]);
  });

  it("refuses a group or total field that is not a declared column", () => {
    const def = base();
    def.groups = [{ field: "branch_code", subtotal: true }];
    def.totals = [{ field: "quantity", fn: "sum" }];
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    // `validateReportDefinition` ends with `errors.sort((x, y) => …)` on `path`, so the order asserted here is
    // ALPHABETICAL by JSON Pointer ('g' < 't'), not the order the rules pushed in.
    expect(result.errors.map((e) => e.path)).toEqual(["/groups/0/field", "/totals/0/field"]);
    expect(result.errors[0]!.message).toBe(
      "group field 'branch_code' is not one of this definition's columns",
    );
  });

  // Phase 7 remediation (ADR 0065 amendment): a report may order by a field it does not print — the ageing's
  // `bucket_rank`, a statement's `section_rank`. The dataset decides whether the key exists, so the refusal
  // lives in packages/db's `assertDefinitionFields` (apps/api's report-definitions test proves it at save).
  it("accepts a sort key that is not a displayed column", () => {
    const def = base();
    def.sort = [{ field: "posted_at", dir: "desc" }];
    expect(validateReportDefinition(def, SETS)).toEqual({ ok: true, errors: [] });
  });

  it("refuses a sum or avg over a non-numeric column", () => {
    const def = base();
    def.totals = [{ field: "account_code", fn: "sum" }];
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        path: "/totals/0/fn",
        message:
          "total fn 'sum' needs a money, quantity, integer or percent column; 'account_code' is text",
      },
    ]);
  });

  it("refuses an enum parameter with no options and duplicate parameter or column names", () => {
    const def = base();
    def.parameters = [
      { name: "kind", kind: "enum", required: true },
      { name: "kind", kind: "text", required: false },
    ];
    // `base()`'s ONE filter names `fiscalPeriodId`, which the line above has just un-declared, so rule 5
    // would push a fourth error at `/dataset/filters/0/param` and this exact-array assertion would fail.
    // The subject of this `it` is parameters and columns, so the filter is cleared rather than expected:
    // the rule-5 refusal has its own `it` above, and an empty `filters` array is valid — the schema sets
    // no `minItems` on it.
    def.dataset.filters = [];
    def.columns = [...def.columns, { ...def.columns[0]! }];
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    // `base()` declares FOUR columns, so the appended duplicate is index 4.
    expect(result.errors.map((e) => e.path).toSorted()).toEqual([
      "/columns/4/field",
      "/parameters/0/options",
      "/parameters/1/name",
    ]);
  });

  it("refuses a paper token outside §4.5.9's registered three", () => {
    const def = base();
    (def.layout as { paper: string }).paper = "letter";
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.path).toBe("/layout/paper");
  });

  it("refuses a tieOut of kind projection with no projection name", () => {
    const a = base();
    a.tieOut = { kind: "projection" };
    expect(validateReportDefinition(a, SETS).errors).toEqual([
      {
        path: "/tieOut/projection",
        message: "tieOut kind 'projection' requires a projection name",
      },
    ]);
  });

  it("refuses a tieOut of kind ledger_sum with neither an account nor a total, and accepts it with a total", () => {
    // Rule 6 deliberately admits `ledger_sum` with no account WHEN `totals` is non-empty — which is exactly
    // what `STATEMENT_LAYOUTS` relies on (Task 9): a statement's tie-out compares its grand total, not one
    // account code. The refusal is only for a definition that offers the harness nothing to compare.
    const empty = base();
    empty.tieOut = { kind: "ledger_sum" };
    empty.totals = [];
    expect(validateReportDefinition(empty, SETS).errors).toEqual([
      {
        path: "/tieOut/account",
        message:
          "tieOut kind 'ledger_sum' requires an account code or at least one total to compare",
      },
    ]);

    const withTotal = base();
    withTotal.tieOut = { kind: "ledger_sum" };
    expect(validateReportDefinition(withTotal, SETS)).toEqual({ ok: true, errors: [] });
  });

  it("refuses additional properties anywhere (the anti-blob rule of spec:1246, SAH-078)", () => {
    const def = { ...base(), sqlOverride: "select * from app.ledger_entry" };
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.path).toBe("/sqlOverride");

    const nested = base();
    (nested.dataset as Record<string, unknown>)["sql"] = "select 1";
    expect(validateReportDefinition(nested, SETS).errors.map((e) => e.path)).toEqual([
      "/dataset/sql",
    ]);
  });
});

describe("parseReportDefinition", () => {
  it("returns the typed definition", () => {
    expect(parseReportDefinition(base()).code).toBe("accounting.trial_balance");
  });

  it("throws ReportDefinitionError carrying JSON-Pointer paths, and checks no set membership", () => {
    const def = base();
    def.dataset.source = "not_a_dataset_but_grammatical";
    // parse checks the schema and the grammar only — membership belongs to validate, because a stored
    // definition was validated when it was written and the registry may have grown since (§4.16.2).
    expect(parseReportDefinition(def).dataset.source).toBe("not_a_dataset_but_grammatical");
    try {
      parseReportDefinition({ ...base(), version: 2 });
      expect.unreachable("version 2 must be refused");
    } catch (e) {
      expect(e).toBeInstanceOf(ReportDefinitionError);
      expect((e as ReportDefinitionError).code).toBe("ERR_VALIDATION_FAILED");
      expect((e as ReportDefinitionError).errors[0]!.path).toBe("/version");
    }
  });
});
