import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import { READ_BATCH } from "./aggregate-drift";
import type { ReconciliationReport } from "./index";
import { firstSpelling } from "./probe";

export interface DuplicateTarget {
  readonly table: string;
  readonly naturalKey: readonly string[];
  readonly why: string;
  readonly legacyDefects: readonly string[];
  /** 9B review, finding 8 — further spellings of the whole natural key, tried in order after it. */
  readonly spellings?: readonly (readonly string[])[];
}

const RACE = [
  "MatObjects and MatQuantity have no key columns, and the non-atomic UPDATE-then-INSERT upsert duplicates",
  "under concurrency; every later posting then updates both rows (LEGACY-049).",
].join(" ");

/**
 * §5.1 #5: "Expect duplicate aggregate rows for MatObjects/MatQuantity (LEGACY-049)." (spec:2335) The natural key
 * is what the trigger's WHERE clause *meant*; the table has no unique index enforcing it, which is the defect.
 */
export const DUPLICATE_TARGETS: readonly DuplicateTarget[] = [
  { table: "MATOBJECTS", naturalKey: ["MATERIAL", "WAREHOUSE"], why: RACE, legacyDefects: ["LEGACY-049"] },
  {
    table: "MATQUANTITY",
    naturalKey: ["MATERIAL", "WAREHOUSE", "BATCH"],
    why: RACE,
    legacyDefects: ["LEGACY-049"],
  },
  {
    table: "ACCOBJECTS",
    naturalKey: ["SITE", "ACCOUNT"],
    why: "AccObjects does have key columns, so a duplicate here would mean the index is absent in this database — worth knowing before the load (LEGACY-049, Part VII #6).",
    legacyDefects: ["LEGACY-049"],
  },
  {
    table: "ACCTOTALS",
    naturalKey: ["ACCOUNT"],
    why: "As ACCOBJECTS.",
    legacyDefects: ["LEGACY-049"],
    // 9B's trial-balance loader keys ACCTOTALS by ACTACC.
    spellings: [["ACTACC"]],
  },
  {
    table: "MATTOTALS",
    naturalKey: ["MATERIAL"],
    why: "As ACCOBJECTS, on the inventory side.",
    legacyDefects: ["LEGACY-049"],
  },
];

/** Numeric-aware, so `10|1` follows `5|1` the way the legacy integer keys order (the T8 rule). */
const byKey = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/**
 * §5.1 #5. One pass per table over its natural-key columns, counting occurrences per key. Every target has at
 * least one row: each duplicated key with its occurrences, or one `clean` row, or `source_absent` — and every row
 * carries the table's row count (`tableRows`, null when absent), so a clean table is visibly clean and the excess
 * can be read against the table's size.
 */
export async function duplicateAggregates(reader: LegacyReader): Promise<ReconciliationReport> {
  const rows: Record<string, unknown>[] = [];
  let duplicatedKeys = 0;
  let excessRows = 0;
  let clean = 0;
  let sourceAbsent = 0;

  for (const target of DUPLICATE_TARGETS) {
    const key = await firstSpelling(reader, target.table, [
      target.naturalKey,
      ...(target.spellings ?? []),
    ]);
    const naturalKey = (key ?? target.naturalKey).join(",");
    if (key === null) {
      sourceAbsent += 1;
      rows.push({
        table: target.table,
        key: null,
        naturalKey,
        occurrences: 0,
        tableRows: null,
        status: "source_absent",
        why: target.why,
      });
      continue;
    }
    const counts = new Map<string, number>();
    let tableRows = 0;
    for await (const batch of reader.read<LegacyRow>(target.table, {
      columns: [...key],
      batch: READ_BATCH,
    })) {
      for (const row of batch) {
        tableRows += 1;
        const k = key.map((c) => String(row[c] ?? "")).join("|");
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    const duplicated = [...counts]
      .filter(([, occurrences]) => occurrences > 1)
      .toSorted(([a], [b]) => byKey(a, b));
    if (duplicated.length === 0) {
      clean += 1;
      rows.push({
        table: target.table,
        key: null,
        naturalKey,
        occurrences: 0,
        tableRows,
        status: "clean",
        why: target.why,
      });
      continue;
    }
    for (const [k, occurrences] of duplicated) {
      duplicatedKeys += 1;
      excessRows += occurrences - 1;
      rows.push({
        table: target.table,
        key: k,
        naturalKey,
        occurrences,
        tableRows,
        status: "duplicate",
        why: target.why,
      });
    }
  }

  return {
    kind: "duplicate_aggregates",
    rows,
    summary: {
      tables: String(DUPLICATE_TARGETS.length),
      clean: String(clean),
      sourceAbsent: String(sourceAbsent),
      duplicatedKeys: String(duplicatedKeys),
      excessRows: String(excessRows),
      note: "Every duplicated key has been counted twice by every posting since it appeared (LEGACY-049), so the drift report's figure for that key is wrong on the stored side by exactly the excess. Read the two reports together.",
    },
  };
}
