import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import { READ_BATCH } from "./aggregate-drift";
import type { ReconciliationReport } from "./index";
import { firstSpelling } from "./probe";

export interface OrphanRule {
  readonly id: string;
  readonly childTable: string;
  readonly childColumns: readonly string[];
  readonly parentTable: string;
  readonly parentColumns: readonly string[];
  /** Sentinels the legacy schema uses for "not set". A `0` Job is not an orphan; it is an absent reference. */
  readonly ignoreValues: readonly string[];
  readonly note: string;
  readonly legacyDefects: readonly string[];
  /** 9B review, finding 8 — further spellings of the child's and the parent's columns, each side tried in order. */
  readonly spellings?: {
    readonly child?: readonly string[];
    readonly parent?: readonly string[];
  }[];
}

const UNSET = ["", "0"] as const;

/**
 * §5.1 #3: "Expect orphaned references. `Job` 82% and `CostCentre` 81% unconstrained (LEGACY-073); the shipped
 * `fixes/fix-Jobs.sql` and `fix-finals.sql` prove orphans occur. **Report orphans; do not silently null them.**"
 * (spec:2333) Every rule is a relationship the dossier names; a rule whose tables are not in this database is
 * reported `source_absent` rather than passing.
 */
export const ORPHAN_RULES: readonly OrphanRule[] = [
  {
    id: "VOUITEMS.JOB",
    childTable: "VOUITEMS",
    childColumns: ["JOB"],
    parentTable: "JOBS",
    parentColumns: ["ID"],
    ignoreValues: [...UNSET],
    note: "Job is 82% unconstrained across the shipped schema (LEGACY-073); the shipped fixes/fix-Jobs.sql exists because orphans occur.",
    legacyDefects: ["LEGACY-073"],
  },
  {
    id: "VOUITEMS.COSTCENTRE",
    childTable: "VOUITEMS",
    childColumns: ["COSTCENTRE"],
    parentTable: "COSTCENTRES",
    parentColumns: ["ID"],
    ignoreValues: [...UNSET],
    note: "CostCentre is 81% unconstrained (LEGACY-073).",
    legacyDefects: ["LEGACY-073"],
  },
  {
    id: "VOUITEMS.ACCOUNT",
    childTable: "VOUITEMS",
    childColumns: ["ACCOUNT"],
    parentTable: "ACCOUNTS",
    parentColumns: ["ID"],
    ignoreValues: [...UNSET],
    note: "Accounts are deletable with postings against them (LEGACY-021), so a line can outlive its account.",
    legacyDefects: ["LEGACY-021", "LEGACY-073"],
  },
  {
    id: "VOUITEMS.VOUCHER",
    childTable: "VOUITEMS",
    childColumns: ["SITE", "ID"],
    parentTable: "VOUCHERS",
    parentColumns: ["SITE", "ID"],
    ignoreValues: [],
    note: "A line whose header no longer exists is invisible to every report that starts from Vouchers.",
    legacyDefects: ["LEGACY-073", "LEGACY-074"],
  },
  {
    id: "BILLITEMS.MATERIAL",
    childTable: "BILLITEMS",
    childColumns: ["MATERIAL"],
    parentTable: "MATERIALS",
    parentColumns: ["ID"],
    ignoreValues: [...UNSET],
    // 9B's spelling: BILLITEMS.BTMMAT holds the MATERIALS key, which 9B's loader reads as MATERIALS.MATID.
    spellings: [{ child: ["BTMMAT"], parent: ["MATID"] }],
    note: "A movement whose item no longer exists cannot be recosted by the 3B engine.",
    legacyDefects: ["LEGACY-073"],
  },
  {
    id: "BILLITEMS.WAREHOUSE",
    childTable: "BILLITEMS",
    childColumns: ["WAREHOUSE"],
    parentTable: "WAREHOUSES",
    parentColumns: ["ID"],
    ignoreValues: [...UNSET],
    // 9B's spelling: BILLITEMS.BTMWAR holds the WAREHOUSES key, which 9B's loader reads as WAREHOUSES.WARID.
    spellings: [{ child: ["BTMWAR"], parent: ["WARID"] }],
    note: "A movement with no warehouse cannot be placed in the opening stock position.",
    legacyDefects: ["LEGACY-073"],
  },
  {
    id: "BILLITEMS.BATCH",
    childTable: "BILLITEMS",
    childColumns: ["BATCH"],
    parentTable: "BATCHES",
    parentColumns: ["ID"],
    ignoreValues: [...UNSET],
    note: "A lot reference with no lot loses the expiry position §5.1 asks 9B to import.",
    legacyDefects: ["LEGACY-073"],
  },
  {
    id: "BILLITEMS.BILL",
    childTable: "BILLITEMS",
    childColumns: ["SITE", "ID"],
    parentTable: "BILLS",
    parentColumns: ["SITE", "ID"],
    ignoreValues: [],
    note: "As VOUITEMS.VOUCHER, on the inventory side.",
    legacyDefects: ["LEGACY-073", "LEGACY-074"],
  },
  {
    id: "JOURNAL.ACCOUNT",
    childTable: "JOURNAL",
    childColumns: ["ACCOUNT"],
    parentTable: "ACCOUNTS",
    parentColumns: ["ID"],
    ignoreValues: [...UNSET],
    note: "Journal is the document-level movement row; an orphan here is a balance with no account.",
    legacyDefects: ["LEGACY-021", "LEGACY-073"],
  },
];

function keyOf(row: LegacyRow, columns: readonly string[]): string {
  return columns.map((c) => String(row[c] ?? "")).join("|");
}

/** Numeric-aware, so `1|10` follows `1|9` the way the legacy integer keys order (the T8 rule). */
const byKey = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/**
 * §5.1 #3. Per rule: one pass over the parent's key columns into a set, one pass over the child's, and every
 * child value the set does not hold is counted — distinct dangling values, and the rows that carry each. A rule
 * that ran and found nothing is written `clean`, a rule whose tables or columns are not in this database
 * `source_absent`, so every rule has at least one row and a pass is never merely the absence of a finding.
 */
export async function orphans(reader: LegacyReader): Promise<ReconciliationReport> {
  const rows: Record<string, unknown>[] = [];
  let orphanedValues = 0;
  let orphanedRows = 0;
  let skipped = 0;
  let clean = 0;

  for (const rule of ORPHAN_RULES) {
    const empty = {
      rule: rule.id,
      childTable: rule.childTable,
      value: null,
      occurrences: 0,
      parentTable: rule.parentTable,
    };
    const alternatives = rule.spellings ?? [];
    const childColumns = await firstSpelling(reader, rule.childTable, [
      rule.childColumns,
      ...alternatives.flatMap((a) => (a.child ? [a.child] : [])),
    ]);
    const parentColumns = await firstSpelling(reader, rule.parentTable, [
      rule.parentColumns,
      ...alternatives.flatMap((a) => (a.parent ? [a.parent] : [])),
    ]);
    if (childColumns === null || parentColumns === null) {
      skipped += 1;
      rows.push({ ...empty, status: "source_absent", note: rule.note });
      continue;
    }

    const parents = new Set<string>();
    for await (const batch of reader.read<LegacyRow>(rule.parentTable, {
      columns: [...parentColumns],
      batch: READ_BATCH,
    })) {
      for (const row of batch) parents.add(keyOf(row, parentColumns));
    }

    const dangling = new Map<string, number>();
    for await (const batch of reader.read<LegacyRow>(rule.childTable, {
      columns: [...childColumns],
      batch: READ_BATCH,
    })) {
      for (const row of batch) {
        const value = keyOf(row, childColumns);
        if (childColumns.length === 1 && rule.ignoreValues.includes(value)) continue;
        if (parents.has(value)) continue;
        dangling.set(value, (dangling.get(value) ?? 0) + 1);
      }
    }

    if (dangling.size === 0) {
      clean += 1;
      rows.push({ ...empty, status: "clean", note: rule.note });
      continue;
    }
    for (const [value, occurrences] of [...dangling].toSorted(([a], [b]) => byKey(a, b))) {
      orphanedValues += 1;
      orphanedRows += occurrences;
      rows.push({
        rule: rule.id,
        childTable: rule.childTable,
        value,
        occurrences,
        parentTable: rule.parentTable,
        status: "orphan",
        note: rule.note,
      });
    }
  }

  return {
    kind: "orphans",
    rows,
    summary: {
      rules: String(ORPHAN_RULES.length),
      skipped: String(skipped),
      clean: String(clean),
      orphanedValues: String(orphanedValues),
      orphanedRows: String(orphanedRows),
      note: "Orphans are reported, never nulled and never resolved to a default (§5.1 #3). 9B refuses to load a row whose parent this report lists.",
    },
  };
}
