import { ALL_LEGACY_TABLES, moduleOf } from "./legacy/modules";
import type { LegacyDriver } from "./legacy/types";

export interface TableScope {
  readonly table: string;
  readonly module: string | null;
  readonly rows: number;
  readonly dateColumn: string | null;
  readonly dateRange: { min: string | null; max: string | null } | null;
  readonly note: string | null;
}

export interface ScopeReport {
  readonly generatedAt: string;
  readonly source: string;
  readonly engineVersion: string | null;
  readonly tables: readonly TableScope[];
  /** In the database, not in the shipped 460-table map — a customisation, or a version drift. */
  readonly unexpectedTables: readonly string[];
  /** In the map, not in the database. */
  readonly missingTables: readonly string[];
  readonly totalRows: number;
}

/**
 * The column a table's date range is taken from, in preference order. Sahlisoft names its business date `DATE`
 * on documents and vouchers and `ENTRYDATE`/`PAYDATE` on a handful of others; a table with none of these gets a
 * null range rather than a guess. Part VII #2 wants the range on `Journal`, `BillItems` and `VouItems`, which
 * inherit theirs from their headers — so a null here is an answer, not a gap.
 */
export const DATE_COLUMN_CANDIDATES: readonly string[] = [
  "DATE",
  "ENTRYDATE",
  "PAYDATE",
  "DUEDATE",
  "CREATED",
];

/** ISO-8601 to the second, in UTC, so two runs of the same command are diffable (spec:2039). */
function stamp(): string {
  return [new Date().toISOString().slice(0, 19), "Z"].join("");
}

const PREFIX = "ERR_IMPORT_SOURCE_UNREADABLE: ";

/**
 * §5.1 #10 — "Scope first, migrate second. Run row counts per table against the live database before designing
 * the importer. 460 tables is the shipped surface, not the used surface." One table that cannot be read is
 * recorded and the run continues: a scoping report that aborts on the first bad table tells the owner nothing.
 */
export async function scope(driver: LegacyDriver): Promise<ScopeReport> {
  const present = await driver.tables();
  const tables: TableScope[] = [];
  let totalRows = 0;

  for (const table of present) {
    const module = moduleOf(table)?.id ?? null;
    try {
      const columns = await driver.columns(table);
      // The two drivers disagree about a table with nothing declared: `OdbcLegacyDriver.columns` raises
      // ("declares no columns"), while `FixtureLegacyDriver.columns` returns `[]`. Both mean the same thing to a
      // scoping report, so the empty list becomes the same note the catch below gives the ODBC form.
      if (columns.length === 0) {
        tables.push({
          table,
          module,
          rows: 0,
          dateColumn: null,
          dateRange: null,
          note: "no columns declared",
        });
        continue;
      }
      const rows = await driver.count(table);
      totalRows += rows;
      const dateColumn =
        DATE_COLUMN_CANDIDATES.find((c) => columns.some((col) => col.name === c)) ?? null;
      const dateRange = dateColumn && rows > 0 ? await driver.minMax(table, dateColumn) : null;
      tables.push({ table, module, rows, dateColumn, dateRange, note: null });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const note = message.includes("declares no columns")
        ? "no columns declared"
        : message.startsWith(PREFIX)
          ? message.slice(PREFIX.length)
          : message;
      tables.push({ table, module, rows: 0, dateColumn: null, dateRange: null, note });
    }
  }

  const seen = new Set(present);
  return {
    generatedAt: stamp(),
    source: driver.source,
    engineVersion: await driver.engineVersion(),
    tables,
    unexpectedTables: present.filter((t) => !ALL_LEGACY_TABLES.has(t)).toSorted(),
    missingTables: [...ALL_LEGACY_TABLES].filter((t) => !seen.has(t)).toSorted(),
    totalRows,
  };
}
