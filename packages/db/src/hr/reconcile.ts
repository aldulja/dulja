import type { Sql } from "postgres";
import { Money, type CurrencyCode } from "@dulja/domain";
import { payslipRows } from "./payslip";

// 8D T9 (⚠️ OD-23) — the Phase 8 definition of done's FIRST clause, made mechanical: "every gross, statutory and net
// figure matches the legacy run … or every difference is explained in writing and accepted by the owner". This file
// produces the difference list; `renderReconciliation` produces the document the owner signs.
//
// Every comparison is `Money.compare`, never `Number` and never `!==`: a cent is a cent (spec:2041), and a string
// comparison over two amounts would report "1.5" and "1.5000" as different.

export interface LegacyPayslip {
  employeeNumber: string;
  gross: string;
  totalDeductions: string;
  net: string;
  /** scheme code → the employee share the legacy system computed. An absent scheme is a difference. */
  schemes: Readonly<Record<string, string>>;
}

export type DifferenceKind =
  | "missing_in_dulja"
  | "missing_in_legacy"
  | "gross"
  | "deductions"
  | "net"
  | "scheme"
  | "scheme_absent";

export interface Difference {
  employeeNumber: string;
  kind: DifferenceKind;
  field: string;
  legacy: string | null;
  dulja: string | null;
  /** `dulja − legacy`, signed, at 4 dp; null when one side has no figure. */
  delta: string | null;
}

export interface ReconciliationReport {
  payrollDocumentId: string;
  periodStart: string;
  periodEnd: string;
  employeesInDulja: number;
  employeesInLegacy: number;
  matched: number;
  differences: readonly Difference[];
  /** True only when `differences` is empty — the DoD's first branch. */
  cleanToTheCent: boolean;
}

export type ReconcileErrorCode = "ERR_VALIDATION_FAILED" | "ERR_NOT_FOUND";

/** A legacy input the comparison cannot read, or a run it cannot find. The CLI turns it into exit 2. */
export class ReconcileError extends Error {
  readonly code: ReconcileErrorCode;
  constructor(code: ReconcileErrorCode, message: string) {
    super(message);
    this.name = "ReconcileError";
    this.code = code;
  }
}

/** A plain decimal of at most four places — `Money`'s own scale (numeric(19,4)). A legacy export at more places is
 *  refused rather than rounded: rounding it here would decide a difference before the report could show it. */
const AMOUNT = /^-?\d+(\.\d{1,4})?$/;

/**
 * `employee_number,gross,total_deductions,net,<SCHEME>_employee,…` — a header row, then one row per employee. Any
 * column ending `_employee` is a scheme's employee share keyed by the scheme code before the suffix, so a new scheme
 * needs no code change here and no statutory name is written into this file (hazard 1): the codes come from the
 * owner's export. An empty scheme cell means the legacy system did not compute that scheme for that employee.
 * The format is plain comma-separated cells — a cell may not itself hold a comma or a quote.
 */
export function parseLegacyCsv(text: string): LegacyPayslip[] {
  const rows = text
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (rows.length < 2) {
    throw new ReconcileError(
      "ERR_VALIDATION_FAILED",
      "the legacy CSV needs a header row and at least one employee row",
    );
  }
  const header = rows[0]!.split(",").map((h) => h.trim());
  const index = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) {
      throw new ReconcileError(
        "ERR_VALIDATION_FAILED",
        `the legacy CSV has no ${name} column; it needs employee_number, gross, total_deductions and net`,
      );
    }
    return i;
  };
  const iNumber = index("employee_number");
  const iGross = index("gross");
  const iDed = index("total_deductions");
  const iNet = index("net");
  const schemeColumns = header
    .map((h, i) => ({ code: h.endsWith("_employee") ? h.slice(0, -"_employee".length) : "", i }))
    .filter((c) => c.code.length > 0);

  const seen = new Set<string>();
  return rows.slice(1).map((line, n) => {
    const at = `legacy CSV line ${n + 2}`;
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length !== header.length) {
      throw new ReconcileError(
        "ERR_VALIDATION_FAILED",
        `${at} has ${cells.length} cells; the header has ${header.length}`,
      );
    }
    const amount = (i: number, column: string): string => {
      const v = cells[i]!;
      if (!AMOUNT.test(v)) {
        throw new ReconcileError(
          "ERR_VALIDATION_FAILED",
          `${at}: ${column} "${v}" is not a decimal of at most four places`,
        );
      }
      return v;
    };
    const employeeNumber = cells[iNumber]!;
    if (employeeNumber.length === 0) {
      throw new ReconcileError("ERR_VALIDATION_FAILED", `${at} has no employee_number`);
    }
    if (seen.has(employeeNumber)) {
      throw new ReconcileError(
        "ERR_VALIDATION_FAILED",
        `${at} repeats employee ${employeeNumber}; the export has one row per employee`,
      );
    }
    seen.add(employeeNumber);
    const schemes: Record<string, string> = {};
    for (const c of schemeColumns) {
      if (cells[c.i]!.length > 0) schemes[c.code] = amount(c.i, header[c.i]!);
    }
    return {
      employeeNumber,
      gross: amount(iGross, "gross"),
      totalDeductions: amount(iDed, "total_deductions"),
      net: amount(iNet, "net"),
      schemes,
    };
  });
}

/** Code-unit order — the same on every machine, unlike `localeCompare`. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `dulja − legacy`, signed, at 4 dp. The sign is the column's whole diagnostic value: a reviewer reads "Dulja paid
 *  less" off it without re-doing the subtraction. */
function delta(dulja: string, legacy: string, base: CurrencyCode): string {
  return Money.of(dulja, base).subtract(Money.of(legacy, base)).toString();
}

/**
 * Compares one POSTED run against the legacy figures the owner supplied. The Dulja side is `payslipRows` and NOT a
 * second query: the report must reconcile the figures the employee received on paper, and a second aggregation here
 * would be a third source of truth for one number (SAH-009). Pure comparison over `Money` once the bundles are read.
 */
export async function reconcileParallelRun(
  tx: Sql,
  params: { companyId: string; payrollDocumentId: string; baseCurrency: CurrencyCode },
  legacy: readonly LegacyPayslip[],
): Promise<ReconciliationReport> {
  const base = params.baseCurrency;
  const bundles = await payslipRows(tx, {
    companyId: params.companyId,
    payrollDocumentId: params.payrollDocumentId,
  });
  // A draft run, an unknown id or another company's run all read as no bundles. Reconciling against nothing would
  // report every legacy employee "missing in Dulja" — a long, wrong report — so it is refused instead.
  if (bundles.length === 0) {
    throw new ReconcileError(
      "ERR_NOT_FOUND",
      `payroll run ${params.payrollDocumentId} is not a posted run of company ${params.companyId}`,
    );
  }

  const byNumber = new Map(bundles.map((b) => [b.header.employeeNumber, b] as const));
  const legacyByNumber = new Map(legacy.map((l) => [l.employeeNumber, l] as const));
  const differences: Difference[] = [];
  let matched = 0;

  for (const l of legacyByNumber.values()) {
    const b = byNumber.get(l.employeeNumber);
    if (b === undefined) {
      // The legacy system paid someone Dulja did not. Reported, never silently dropped — SAH-011's shape.
      differences.push({
        employeeNumber: l.employeeNumber,
        kind: "missing_in_dulja",
        field: "employee",
        legacy: l.net,
        dulja: null,
        delta: null,
      });
      continue;
    }
    matched += 1;
    const h = b.header;
    const pairs: readonly (readonly [DifferenceKind, string, string, string])[] = [
      ["gross", "gross", l.gross, h.gross],
      ["deductions", "totalDeductions", l.totalDeductions, h.totalDeductions],
      ["net", "net", l.net, h.net],
    ];
    for (const [kind, field, left, right] of pairs) {
      if (Money.of(right, base).compare(Money.of(left, base)) !== 0) {
        differences.push({
          employeeNumber: l.employeeNumber,
          kind,
          field,
          legacy: Money.of(left, base).toString(),
          dulja: right,
          delta: delta(right, left, base),
        });
      }
    }

    // Each scheme's EMPLOYEE share, per scheme code, summed from the bundle's own rows — so the payslip and the
    // reconciliation cannot disagree about what was deducted.
    const duljaShares = new Map<string, Money<CurrencyCode>>();
    for (const r of b.rows) {
      if (r["scheme_code"] === null || r["share"] !== "employee") continue;
      const code = String(r["scheme_code"]);
      duljaShares.set(
        code,
        (duljaShares.get(code) ?? Money.zero(base)).add(
          Money.of(String(r["amount"] ?? "0.0000"), base),
        ),
      );
    }
    for (const code of new Set([...Object.keys(l.schemes), ...duljaShares.keys()])) {
      const legacyShare = l.schemes[code];
      const duljaShare = duljaShares.get(code);
      if (legacyShare === undefined || duljaShare === undefined) {
        // Computed on one side only: Dulja deducted a scheme the legacy run did not carry, or the reverse.
        differences.push({
          employeeNumber: l.employeeNumber,
          kind: "scheme_absent",
          field: code,
          legacy: legacyShare === undefined ? null : Money.of(legacyShare, base).toString(),
          dulja: duljaShare === undefined ? null : duljaShare.toString(),
          delta: null,
        });
        continue;
      }
      if (duljaShare.compare(Money.of(legacyShare, base)) !== 0) {
        differences.push({
          employeeNumber: l.employeeNumber,
          kind: "scheme",
          field: code,
          legacy: Money.of(legacyShare, base).toString(),
          dulja: duljaShare.toString(),
          delta: delta(duljaShare.toString(), legacyShare, base),
        });
      }
    }
  }

  for (const b of bundles) {
    if (legacyByNumber.has(b.header.employeeNumber)) continue;
    differences.push({
      employeeNumber: b.header.employeeNumber,
      kind: "missing_in_legacy",
      field: "employee",
      legacy: null,
      dulja: b.header.net,
      delta: null,
    });
  }

  // Sorted by code unit, never by locale: `renderReconciliation` must produce the same bytes for the same data on
  // every machine, so a reviewer diffs the report instead of re-reading it.
  differences.sort(
    (a, b) =>
      cmp(a.employeeNumber, b.employeeNumber) || cmp(a.field, b.field) || cmp(a.kind, b.kind),
  );

  const first = bundles[0]!.header;
  return {
    payrollDocumentId: params.payrollDocumentId,
    periodStart: first.periodStart,
    periodEnd: first.periodEnd,
    employeesInDulja: bundles.length,
    employeesInLegacy: legacy.length,
    matched,
    differences,
    cleanToTheCent: differences.length === 0,
  };
}

/** Deterministic Markdown — the document the owner signs. Same input, same bytes: no clock read, no locale-dependent
 *  formatting, and the rows are already sorted by `reconcileParallelRun`. */
export function renderReconciliation(report: ReconciliationReport): string {
  const lines: string[] = [
    `# Payroll parallel run — reconciliation`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Payroll document | \`${report.payrollDocumentId}\` |`,
    `| Period | ${report.periodStart} … ${report.periodEnd} |`,
    `| Employees in Dulja | ${report.employeesInDulja} |`,
    `| Employees in the legacy run | ${report.employeesInLegacy} |`,
    `| Matched by employee number | ${report.matched} |`,
    `| Differences | ${report.differences.length} |`,
    ``,
    report.cleanToTheCent
      ? `**Clean to the cent.** Every gross, statutory and net figure matches the legacy run.`
      : `**${report.differences.length} difference(s).** Each row below is a Dulja defect, a legacy defect, or a rule difference the accountant explains. The owner's written acceptance of this list is what closes the Phase 8 definition of done — a zero is not required.`,
    ``,
  ];
  if (report.differences.length > 0) {
    lines.push(`| Employee | Field | Legacy | Dulja | Delta |`, `|---|---|---|---|---|`);
    for (const d of report.differences) {
      lines.push(
        `| ${d.employeeNumber} | ${d.field} (${d.kind}) | ${d.legacy ?? "—"} | ${d.dulja ?? "—"} | ${d.delta ?? "—"} |`,
      );
    }
    lines.push(``);
  }
  lines.push(
    `## Accepted differences`,
    ``,
    `_One line per row above: the reason, and the owner's initials. A row with no reason is not accepted._`,
    ``,
  );
  return lines.join("\n");
}
