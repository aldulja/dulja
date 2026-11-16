import { LEGACY_MODULES, moduleOf } from "./legacy/modules";
import { isMposTable } from "./mpos";
import type { LegacyReader } from "./reader";
import { DATE_COLUMN_CANDIDATES } from "./scope";

/** Contracts §4.13.1, verbatim — mutable members and optional `dateRange` included. */
export interface ProfileReport {
  generatedAt: string;
  tables: { name: string; rows: number; dateRange?: { min: string | null; max: string | null } }[];
  modulesInUse: Record<string, boolean>;
}

/**
 * OD-16 (Part VII #10, ⚠️): the §2.12 default is to start the new POS clean, so the `mpos` tables are **not
 * read** unless the operator asks with `--include-mpos`. Their two modules then answer `false` in
 * `modulesInUse` — the honest reading of "not read" — and the CLI's `mpos:` line says why.
 */
export interface ProfileOptions {
  readonly includeMpos?: boolean;
}

/**
 * Part VII #1: "Which modules are actually used? 460 tables is the shipped surface. Run row counts per table
 * against the live database. The hospital (50 tables), academy (44), and aviation modules may be entirely dead
 * weight — this could halve the rebuild." (spec:2465)
 *
 * `LegacyReader` has no catalogue accessor — §4.13.1 froze it without one — so the date range is found by asking
 * for each candidate column in turn and keeping the first that answers. A column the table does not have raises
 * `ERR_IMPORT_SOURCE_UNREADABLE` from the driver's membership gate, which is caught here and means "not this one".
 * `dateRange` is then **omitted**, never set to `{ min: null, max: null }`: an absent property says "this table
 * has no business date", a null range would say "it has one and it is empty", and the two are different answers
 * to Part VII #2.
 */
export async function profile(
  reader: LegacyReader,
  opts: ProfileOptions = {},
): Promise<ProfileReport> {
  const all = await reader.tables();
  const names = opts.includeMpos ? all : all.filter((t) => !isMposTable(t));
  const tables: ProfileReport["tables"] = [];
  const modulesInUse: Record<string, boolean> = Object.fromEntries(
    LEGACY_MODULES.map((m) => [m.id, false]),
  );

  for (const name of names) {
    const rows = await reader.count(name);
    const module = moduleOf(name);
    if (module && rows > 0) modulesInUse[module.id] = true;

    const range = rows > 0 ? await firstRange(reader, name) : undefined;
    tables.push(range ? { name, rows, dateRange: range } : { name, rows });
  }

  return {
    generatedAt: [new Date().toISOString().slice(0, 19), "Z"].join(""),
    tables,
    modulesInUse,
  };
}

async function firstRange(
  reader: LegacyReader,
  table: string,
): Promise<{ min: string | null; max: string | null } | undefined> {
  for (const column of DATE_COLUMN_CANDIDATES) {
    try {
      const range = await reader.dateRange(table, column);
      if (range.min !== null || range.max !== null) return range;
    } catch {
      // Not a column of this table. Try the next candidate.
    }
  }
  return undefined;
}
