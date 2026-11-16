import type { LegacyDriver } from "../legacy/types";
import type { Loader, SourceColumn } from "./types";

export interface PreflightFinding {
  loader: string;
  sourceTable: string;
  /** The declared column, or `*` when the whole table is absent. */
  column: string;
  problem: "missing" | "absent_table";
  required: boolean;
  confidence: SourceColumn["confidence"];
  note: string;
}

export interface PreflightReport {
  /** False when any REQUIRED column, or any source table, is absent. */
  ok: boolean;
  findings: PreflightFinding[];
  /** Every PRESENT source table checked, once each, in the order first met. */
  checkedTables: string[];
}

/**
 * §5.1 #10, "scope first, migrate second", applied per column. Hazard 3 forbids a transcribed row interface, so every
 * loader declares its columns as data and this turns that data into a checkable claim against the customer's own
 * catalogue BEFORE a single row is read. It asks the DRIVER: `LegacyReader` (§4.13.1) is the row surface and has no
 * `columns()`.
 *
 * An absent table is reported once per TABLE: two loaders legitimately share a source table (Task 4's account and
 * party loaders), and two findings differing only in `loader` would read as two problems. The first loader in
 * `selected` order is named. A present table's columns are checked once per loader, since each declares its own.
 */
export async function preflight(
  driver: LegacyDriver,
  selected: readonly Loader<unknown, unknown>[],
): Promise<PreflightReport> {
  const present = new Set(await driver.tables());
  const findings: PreflightFinding[] = [];
  const checkedTables: string[] = [];
  const reportedAbsent = new Set<string>();
  const catalogue = new Map<string, ReadonlySet<string>>();

  for (const loader of selected) {
    if (!present.has(loader.sourceTable)) {
      if (reportedAbsent.has(loader.sourceTable)) continue;
      reportedAbsent.add(loader.sourceTable);
      findings.push({
        loader: loader.targetTable,
        sourceTable: loader.sourceTable,
        column: "*",
        problem: "absent_table",
        required: true,
        confidence: "hypothesis",
        note: "the loader's source table is not in the catalogue",
      });
      continue;
    }
    let have = catalogue.get(loader.sourceTable);
    if (!have) {
      have = new Set((await driver.columns(loader.sourceTable)).map((c) => c.name));
      catalogue.set(loader.sourceTable, have);
      checkedTables.push(loader.sourceTable);
    }
    for (const column of loader.sourceColumns) {
      if (have.has(column.name)) continue;
      findings.push({
        loader: loader.targetTable,
        sourceTable: loader.sourceTable,
        column: column.name,
        problem: "missing",
        required: column.required,
        confidence: column.confidence,
        note: column.note,
      });
    }
  }

  return { ok: findings.every((f) => !f.required), findings, checkedTables };
}
