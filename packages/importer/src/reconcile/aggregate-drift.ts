import Decimal from "decimal.js";
import { AGGREGATE_RULES, type AggregateRule } from "../legacy/aggregates";
import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import type { ReconciliationReport } from "./index";
import { firstSpelling, hasColumns } from "./probe";

/** Big enough that a million-row BillItems is a couple of hundred round trips, small enough to bound memory. */
export const READ_BATCH = 5_000;

const ZERO = "0.0000";

function keyOf(row: LegacyRow, columns: readonly string[]): string {
  return columns.map((c) => String(row[c] ?? "")).join("|");
}

/** A legacy amount as exact decimal text; NULL and blank count as zero here (NULL itself is T10's null_poison). */
function money(value: LegacyRow[string] | undefined): Decimal {
  return new Decimal(value === null || value === undefined || value === "" ? "0" : String(value));
}

function base(
  rule: AggregateRule,
  key: string,
  extra: Record<string, unknown>,
  stored: readonly string[] | null = null,
): Record<string, unknown> {
  // A row read under one of the rule's further spellings says so, so the artefact never names a column it did not read.
  const spelt =
    stored !== null && stored.at(-1) !== rule.storedColumn
      ? ` (read as ${rule.storedTable}.${stored.at(-1)!} by ${stored.slice(0, -1).join(", ")}, the source's spelling)`
      : "";
  return {
    rule: rule.id,
    key,
    confidence: rule.confidence,
    derivation: rule.derivation + spelt,
    ...extra,
  };
}

/**
 * §5.1 #1. For every rule: recompute the figure from the source, read the stored figure, and report the
 * difference (`stored − recomputed`, signed). Nothing is repaired and nothing is chosen — SAH-079 is a system with
 * 44 repair objects that silently "fixed" numbers, and this report exists so the customer decides instead.
 *
 * The two directions are different defects and stay apart: a key in the stored table that the source never
 * produces is `drift` against `0.0000` (the orphan aggregate row, SAH-050); a key the source produces with no
 * stored row is `missing_stored_row` (the decrement that never fired).
 */
export async function aggregateDrift(reader: LegacyReader): Promise<ReconciliationReport> {
  const rows: Record<string, unknown>[] = [];
  let compared = 0;
  let drifting = 0;
  let missingStoredRows = 0;
  let notDerivable = 0;
  let sourceAbsent = 0;

  for (const rule of AGGREGATE_RULES) {
    const { sourceTable, sourceColumn } = rule;
    if (sourceTable === null || sourceColumn === null) {
      notDerivable += 1;
      rows.push(
        base(rule, "", {
          status: "not_derivable",
          stored: null,
          recomputed: null,
          difference: null,
        }),
      );
      continue;
    }
    const sourceReady = await hasColumns(reader, sourceTable, [...rule.sourceKey, sourceColumn]);
    // 9B review, finding 8: the stored side in whichever of the rule's spellings the source has, as a whole set.
    const stored = await firstSpelling(reader, rule.storedTable, [
      [...rule.storedKey, rule.storedColumn],
      ...(rule.storedSpellings ?? []).map((s) => [...s.key, s.column]),
    ]);
    const storedReady = stored !== null;
    if (!sourceReady || !storedReady) {
      sourceAbsent += 1;
      rows.push(
        base(rule, "", {
          status: "source_absent",
          stored: null,
          recomputed: null,
          difference: null,
          detail: [sourceReady ? null : sourceTable, storedReady ? null : rule.storedTable]
            .filter((t) => t !== null)
            .join(", "),
        }),
      );
      continue;
    }

    const recomputed = new Map<string, Decimal>();
    for await (const batch of reader.read<LegacyRow>(sourceTable, {
      columns: [...rule.sourceKey, sourceColumn],
      batch: READ_BATCH,
    })) {
      for (const row of batch) {
        const k = keyOf(row, rule.sourceKey);
        recomputed.set(k, (recomputed.get(k) ?? new Decimal(0)).plus(money(row[sourceColumn])));
      }
    }

    const storedKey = stored.slice(0, -1);
    const storedColumn = stored.at(-1)!;
    const seen = new Set<string>();
    for await (const batch of reader.read<LegacyRow>(rule.storedTable, {
      columns: [...stored],
      batch: READ_BATCH,
    })) {
      for (const row of batch) {
        const k = keyOf(row, storedKey);
        seen.add(k);
        compared += 1;
        const storedValue = row[storedColumn];
        const storedAmount = money(storedValue);
        const computed = recomputed.get(k) ?? new Decimal(0);
        if (!storedAmount.equals(computed)) {
          drifting += 1;
          rows.push(
            base(
              rule,
              k,
              {
                status: "drift",
                stored:
                  storedValue === null || storedValue === undefined ? ZERO : String(storedValue),
                recomputed: computed.toFixed(4),
                difference: storedAmount.minus(computed).toFixed(4),
              },
              stored,
            ),
          );
        }
      }
    }

    for (const [k, computed] of recomputed) {
      if (seen.has(k)) continue;
      missingStoredRows += 1;
      rows.push(
        base(
          rule,
          k,
          {
            status: "missing_stored_row",
            stored: null,
            recomputed: computed.toFixed(4),
            difference: null,
          },
          stored,
        ),
      );
    }
  }

  return {
    kind: "aggregate_drift",
    rows,
    summary: {
      rules: String(AGGREGATE_RULES.length),
      compared: String(compared),
      drifting: String(drifting),
      missingStoredRows: String(missingStoredRows),
      notDerivable: String(notDerivable),
      sourceAbsent: String(sourceAbsent),
      note: [
        "Recomputed figures are labelled hypothesis until the live database confirms the routing; the",
        String(notDerivable),
        "not_derivable columns need the owner (§5.1 #1).",
      ].join(" "),
    },
  };
}
