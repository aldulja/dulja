import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import { READ_BATCH } from "./aggregate-drift";
import type { ReconciliationReport } from "./index";
import { firstSpelling } from "./probe";

export interface NullPoisonTarget {
  readonly table: string;
  readonly columns: readonly string[];
  readonly why: string;
  readonly sah: readonly string[];
  /** 9B review, finding 8 — further spellings of a column, tried in order after it; the row names the one read. */
  readonly spellings?: Readonly<Record<string, readonly string[]>>;
}

/**
 * §5.1 #4: "Expect NULL-poisoned balances and costs (SAH-007, 011). These will appear as blank or zero, not as
 * errors." (spec:2334) The list is every figure column a legacy report would render as a blank and a loader
 * would coerce to zero — which is the same defect arriving in the new system.
 */
export const NULL_POISON_TARGETS: readonly NullPoisonTarget[] = [
  {
    table: "ACCTOTALS",
    columns: ["DEBIT", "CREDIT", "ADMINDEBIT", "ADMINCREDIT"],
    why: "NULL arithmetic irreversibly nulls balances (SAH-011): one NULL operand in the trigger's -old + new expression wipes the accumulated figure and nothing raises.",
    sah: ["SAH-011"],
    // 9B's trial-balance loader reads the totals as ACTDEBIT/ACTCREDIT and refuses a NULL one (SAH-007).
    spellings: { DEBIT: ["ACTDEBIT"], CREDIT: ["ACTCREDIT"] },
  },
  {
    table: "ACCOBJECTS",
    columns: ["DEBIT", "CREDIT", "OPENDEBIT", "OPENCREDIT"],
    why: "As ACCTOTALS.",
    sah: ["SAH-011"],
  },
  {
    table: "ACCCURTOTALS",
    columns: ["DEBIT", "CREDIT"],
    why: "As ACCTOTALS, per currency (SAH-001).",
    sah: ["SAH-001", "SAH-011"],
  },
  {
    table: "MATCOSTS",
    columns: ["COST", "BUY", "BUYPRICE", "SALEPRICE"],
    why: "Value-less production movements NULL-poison cost forever (SAH-007) and there is no rebuild path (SAH-004). A NULL here is why §5.1 #6 forbids importing cost at all.",
    sah: ["SAH-004", "SAH-007"],
  },
  {
    table: "MATOBJECTS",
    columns: ["QNT"],
    why: "A NULL quantity reads as zero stock and hides a position (SAH-050).",
    sah: ["SAH-050"],
  },
  {
    table: "MATQUANTITY",
    columns: ["QNT"],
    why: "As MATOBJECTS, per batch.",
    sah: ["SAH-049", "SAH-050"],
  },
  {
    table: "VOUITEMS",
    columns: ["DEBIT", "CREDIT", "LOCALDEBIT", "LOCALCREDIT"],
    why: "A NULL on a line is what poisons every aggregate downstream; LocalDebit/LocalCredit additionally were never derived from value × rate (SAH-012).",
    sah: ["SAH-011", "SAH-012"],
  },
  {
    table: "BILLITEMS",
    columns: ["QNT", "DEBIT", "CREDIT", "LOCALCOST", "ACTUALCOST"],
    why: "As VOUITEMS, on the inventory side; the three cost columns feed MatCosts.",
    sah: ["SAH-007", "SAH-011"],
    // 9B's opening-stock loader reads the quantity as BTMQNT; a NULL count does not depend on its sign convention.
    spellings: { QNT: ["BTMQNT"] },
  },
];

function isNull(value: LegacyRow[string] | undefined): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * §5.1 #4. Each column is probed on its own, so a column missing from this database is `source_absent` without
 * hiding its siblings; the present columns of one table are then counted in a single pass, because BillItems is
 * the largest table in the database and five scans of it would buy nothing. One row per target column, in the
 * declared order.
 */
export async function nullPoison(reader: LegacyReader): Promise<ReconciliationReport> {
  const rows: Record<string, unknown>[] = [];
  let poisonedColumns = 0;
  let poisonedValues = 0;

  for (const target of NULL_POISON_TARGETS) {
    // Each target column under the first of its spellings the table has (9B review, finding 8), or absent.
    const read = new Map<string, string>();
    for (const column of target.columns) {
      const spelt = await firstSpelling(
        reader,
        target.table,
        [column, ...(target.spellings?.[column] ?? [])].map((c) => [c]),
      );
      if (spelt !== null) read.set(column, spelt[0]!);
    }
    const present = [...read.values()];
    const nulls = new Map<string, number>(present.map((c) => [c, 0]));
    let total = 0;
    if (present.length > 0) {
      for await (const batch of reader.read<LegacyRow>(target.table, {
        columns: present,
        batch: READ_BATCH,
      })) {
        for (const row of batch) {
          total += 1;
          for (const column of present)
            if (isNull(row[column])) nulls.set(column, (nulls.get(column) ?? 0) + 1);
        }
      }
    }
    for (const canonical of target.columns) {
      const column = read.get(canonical) ?? canonical;
      const counted = read.has(canonical) ? nulls.get(column) : undefined;
      if (counted === undefined) {
        rows.push({
          table: target.table,
          column,
          nulls: 0,
          rows: 0,
          status: "source_absent",
          why: target.why,
        });
        continue;
      }
      if (counted > 0) {
        poisonedColumns += 1;
        poisonedValues += counted;
      }
      rows.push({
        table: target.table,
        column,
        nulls: counted,
        rows: total,
        status: counted > 0 ? "poisoned" : "clean",
        why: target.why,
      });
    }
  }

  return {
    kind: "null_poison",
    rows,
    summary: {
      columns: String(rows.length),
      poisonedColumns: String(poisonedColumns),
      poisonedValues: String(poisonedValues),
      note: "These appear as blank or zero, not as errors (§5.1 #4). 9B refuses to coerce a NULL figure to zero: a row listed here is loaded only after the owner supplies the value or agrees to omit it.",
    },
  };
}
