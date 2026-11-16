import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Decimal from "decimal.js";
import { evaluatePredicate, predicateColumns, type LegacyPredicate } from "../legacy/predicate";
import {
  absentFromCatalogue,
  unreadable,
  type LegacyColumn,
  type LegacyColumnKind,
  type LegacyConstraint,
  type LegacyDriver,
  type LegacyRow,
  type LegacyScalar,
  type SelectSpec,
} from "../legacy/types";

interface CorpusTable {
  readonly columns: readonly LegacyColumn[];
  readonly keyColumns: readonly string[];
  /** Declared constraints beyond the PRIMARY KEY `keyColumns` implies (Task 13); absent means none. */
  readonly constraints?: readonly LegacyConstraint[];
  readonly rows: readonly LegacyRow[];
}

export interface LegacyCorpus {
  readonly engineVersion: string | null;
  readonly tables: Readonly<Record<string, CorpusTable>>;
}

interface CatalogFile {
  readonly engineVersion: string | null;
  readonly tables: Record<
    string,
    { keyColumns: string[]; columns: LegacyColumn[]; constraints?: LegacyConstraint[] }
  >;
}

/**
 * Reads a committed corpus directory — `catalog.json` plus one `<TABLE>.json` row file per catalogued table —
 * into the shape `FixtureLegacyDriver` takes. The one reader of the on-disk format: the test loader
 * (`test/support/corpus.ts`) and the CLI's `--fixture` both call it, so the two cannot drift. A row file with no
 * catalogue entry is refused rather than ignored, because a table nobody declared is a table nobody checked.
 */
export function readCorpus(dir: string): LegacyCorpus {
  const catalog = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8")) as CatalogFile;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file === "catalog.json") continue;
    const name = file.slice(0, -".json".length);
    if (!catalog.tables[name]) throw unreadable([name, "has rows but no catalog entry"].join(" "));
  }
  const tables: Record<string, CorpusTable> = {};
  for (const [table, meta] of Object.entries(catalog.tables)) {
    tables[table] = {
      columns: meta.columns,
      keyColumns: meta.keyColumns,
      constraints: meta.constraints ?? [],
      rows: JSON.parse(readFileSync(join(dir, [table, "json"].join(".")), "utf8")) as LegacyRow[],
    };
  }
  return { engineVersion: catalog.engineVersion, tables };
}

const NUMERIC: ReadonlySet<LegacyColumnKind> = new Set(["integer", "decimal", "float"]);

/**
 * The order a value takes in its column. Firebird orders a numeric column by its value and NULLs first in an
 * ascending sort; comparing the text form would put "10" before "9" and disagree with the live driver on the
 * first table whose keys are not all one digit wide. Everything else compares by code unit, which is what an
 * ISO date and an equal-width code need. `Decimal`, never `Number`: a NUMERIC(18,4) is not a double (spec:99).
 */
function compareValues(
  a: LegacyScalar | undefined,
  b: LegacyScalar | undefined,
  kind: LegacyColumnKind,
): number {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  if (NUMERIC.has(kind) && typeof left === "string" && typeof right === "string") {
    return new Decimal(left).comparedTo(new Decimal(right));
  }
  const x = String(left);
  const y = String(right);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The local equivalent OD-17's task names (contracts §2.12 default: no access). It evaluates a `SelectSpec`
 * **structurally** over arrays — it parses no SQL and renders none, so it can never disagree with the ODBC
 * driver about a dialect it does not speak. A `where` is evaluated with SQL's three-valued logic
 * (`evaluatePredicate`) after every column it names is proved to exist, never ignored: a silently ignored filter
 * is how a reconciliation report lies.
 */
export class FixtureLegacyDriver implements LegacyDriver {
  readonly kind = "fixture" as const;
  readonly source: string;
  private readonly corpus: LegacyCorpus;

  constructor(corpus: LegacyCorpus, source = "fixture corpus") {
    this.corpus = corpus;
    this.source = source;
  }

  engineVersion(): Promise<string | null> {
    return Promise.resolve(this.corpus.engineVersion);
  }

  tables(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.corpus.tables).toSorted());
  }

  async columns(table: string): Promise<LegacyColumn[]> {
    return [...this.table(table).columns];
  }

  async keyColumns(table: string): Promise<string[]> {
    return [...this.table(table).keyColumns];
  }

  /**
   * Declared constraints, plus a synthesised PRIMARY KEY when the corpus gives key columns and declares no
   * PRIMARY KEY. The synthesis is what keeps the two drivers agreeing: `OdbcLegacyDriver.keyColumns` *derives*
   * its answer from `RDB$RELATION_CONSTRAINTS`, so on a live source a table with key columns necessarily has
   * a PRIMARY KEY constraint. Without it, a corpus table with `keyColumns` and no `constraints` entry would
   * report "no key declared" here and "PRIMARY KEY" there, and Task 13's report would read differently against
   * the fixture than against the database it exists to describe.
   */
  async constraints(table: string): Promise<LegacyConstraint[]> {
    const entry = this.table(table);
    const declared = [...(entry.constraints ?? [])];
    if (entry.keyColumns.length > 0 && !declared.some((c) => c.kind === "PRIMARY KEY")) {
      declared.unshift({
        table,
        name: ["PK", table].join("_"),
        kind: "PRIMARY KEY",
        columns: [...entry.keyColumns],
        referencedTable: null,
      });
    }
    return declared;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  async count(table: string, where?: LegacyPredicate): Promise<number> {
    return this.filtered(table, where).length;
  }

  async minMax(table: string, column: string): Promise<{ min: string | null; max: string | null }> {
    const kind = this.column(table, column).kind;
    const values = this.table(table)
      .rows.map((r) => r[column])
      .filter((v): v is string => typeof v === "string" && v !== "")
      .toSorted((a, b) => compareValues(a, b, kind));
    return { min: values[0] ?? null, max: values.at(-1) ?? null };
  }

  async *cursor(spec: SelectSpec, batch: number): AsyncIterable<LegacyRow[]> {
    if (!Number.isSafeInteger(batch) || batch < 1)
      throw unreadable(["batch size", String(batch), "is not a positive integer"].join(" "));
    const wanted =
      spec.columns.length > 0 ? spec.columns : this.table(spec.table).columns.map((c) => c.name);
    for (const name of wanted) this.column(spec.table, name);
    let rows = this.filtered(spec.table, spec.where);
    const keys = (spec.orderBy ?? []).map((name) => this.column(spec.table, name));
    if (keys.length > 0) {
      rows = rows.toSorted((a, b) => {
        for (const key of keys) {
          const cmp = compareValues(a[key.name], b[key.name], key.kind);
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }
    for (let i = 0; i < rows.length; i += batch) {
      yield rows
        .slice(i, i + batch)
        .map((row) => Object.fromEntries(wanted.map((c) => [c, row[c] ?? null])) as LegacyRow);
    }
  }

  private table(name: string): CorpusTable {
    const found = this.corpus.tables[name];
    if (!found) throw absentFromCatalogue(["table", name, "is not in the corpus"].join(" "));
    return found;
  }

  private column(table: string, column: string): LegacyColumn {
    const found = this.table(table).columns.find((c) => c.name === column);
    if (!found)
      throw absentFromCatalogue(
        ["column", [table, column].join("."), "is not in the corpus"].join(" "),
      );
    return found;
  }

  private filtered(table: string, where?: LegacyPredicate): readonly LegacyRow[] {
    const rows = this.table(table).rows;
    if (!where) return rows;
    for (const column of predicateColumns(where)) this.column(table, column);
    return rows.filter((row) => evaluatePredicate(row, where));
  }
}
