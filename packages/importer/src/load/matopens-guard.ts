import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import { LoadError } from "./types";

/** What Part VII #7 found in one table: how many distinct non-zero job values, and up to five of them, sorted. */
export interface JobPartitionFinding {
  table: string;
  column: string;
  distinctNonZero: number;
  sample: string[];
}

/**
 * Part VII #7 names `MatOpens.Job` specifically, and SAH-022 is the defect it decides. No other table is added here
 * without an amendment: the question is about opening stock, and widening it to every `Job` column in the 460-table
 * map would turn a decidable question into noise. `MOPJOB` is the dossier's per-table prefix (`MatOpens`, prefix
 * `MOP`), a `hypothesis` like every 9B column; 9A's probe reads the unprefixed `JOB`, and OD-17's live catalogue
 * settles which spelling is real (docs/owner/od-17-live-database.md).
 */
export const JOB_PARTITIONED_TABLES: readonly { table: string; column: string }[] = [
  { table: "MATOPENS", column: "MOPJOB" },
];

/** A job value of zero in any spelling a Firebird integer or numeric cast to text may take (`0`, `-0`, `0.0000`). */
const ZERO = /^[+-]?0+(?:\.0*)?$/;
const BATCH = 500;
const SAMPLE = 5;

/**
 * Part VII #7: "Does `MatOpens.Job` ever differ from 0 in production? SAH-022 is a hard failure if so, and inert if
 * not." Asked of the customer's own data at load time, so the answer is evidence rather than an assumption — and asked
 * in 9B, because 9B is the slice that would silently merge job-partitioned opening positions into one if the answer
 * were yes and nobody looked.
 *
 * Returns `null` when the question is inert for this source (every value 0, NULL or blank, or the table absent) and the
 * finding otherwise; the caller decides what a finding means. It never decides "inert" for a source it could not ask:
 * a present table whose job column cannot be read raises `ERR_IMPORT_SOURCE_UNREADABLE`, because an unanswerable
 * question is not an answer of zero (OD-27's default is none, and the safe reading of none is to refuse).
 */
export async function assertNoJobPartition(
  reader: LegacyReader,
): Promise<JobPartitionFinding | null> {
  const present = new Set(await reader.tables());
  for (const { table, column } of JOB_PARTITIONED_TABLES) {
    if (!present.has(table)) continue;
    const seen = new Set<string>();
    try {
      for await (const page of reader.read<LegacyRow>(table, { columns: [column], batch: BATCH })) {
        for (const row of page) {
          const value = row[column];
          if (value === null || value === undefined) continue;
          const text = String(value).trim();
          if (text === "" || ZERO.test(text)) continue;
          seen.add(text);
        }
      }
    } catch (cause) {
      throw new LoadError(
        "ERR_IMPORT_SOURCE_UNREADABLE",
        [
          [table, "is in the source but", [table, column].join("."), "could not be read"].join(" "),
          ["(", cause instanceof Error ? cause.message : String(cause), ");"].join(""),
          "Part VII #7 cannot be answered for this source, so opening stock is not loaded —",
          "confirm the column against the live catalogue (OD-17) before loading (SAH-022, OD-27)",
        ].join(" "),
      );
    }
    if (seen.size > 0) {
      return {
        table,
        column,
        distinctNonZero: seen.size,
        sample: [...seen].toSorted().slice(0, SAMPLE),
      };
    }
  }
  return null;
}
