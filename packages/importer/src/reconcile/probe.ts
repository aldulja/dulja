import type { LegacyPredicate } from "../legacy/predicate";
import { isAbsentFromCatalogue } from "../legacy/types";
import type { LegacyReader } from "../reader";

/**
 * Whether a table has every one of these columns. `LegacyReader` (§4.13.1) has no catalogue accessor, so the
 * question is asked the only way the interface allows: request exactly those columns and see whether the driver
 * refuses. A refusal is `ERR_IMPORT_SOURCE_UNREADABLE` from the driver's catalogue-membership gate (ADR 0082),
 * raised before any statement runs and marked by `absentFromCatalogue`; any other error propagates.
 *
 * The read carries a contradiction — `c is null and c is not null` on the first column — so it returns no row on
 * either driver while still passing every column through the gate. Without it a successful probe would transfer
 * the whole table: the live driver reads a result set entire before slicing it (9A Task 3), and BillItems is the
 * largest table in the database.
 *
 * This is what keeps AGGREGATE_RULES honest: its source column names come from a dossier, not from the customer's
 * database, and a rule whose columns are not there is reported `source_absent` rather than quietly producing zero
 * and calling it a match.
 */
export async function hasColumns(
  reader: LegacyReader,
  table: string,
  columns: readonly string[],
): Promise<boolean> {
  const [first] = columns;
  if (first === undefined) return false;
  const never: LegacyPredicate = {
    op: "and",
    operands: [
      { op: "is_null", column: first },
      { op: "is_not_null", column: first },
    ],
  };
  try {
    for await (const _ of reader.read(table, { columns: [...columns], where: never, batch: 1 }))
      break;
    return true;
  } catch (cause) {
    // Only the catalogue gate's "not declared here" is a "no"; anything else — a dropped connection, a malformed
    // name — is the source failing and propagates as itself (2026-11-15 review, HRP-22).
    if (isAbsentFromCatalogue(cause)) return false;
    throw cause;
  }
}

/**
 * 9B review, finding 8 — the first of several complete spellings of one set of columns that the table has, or `null`.
 * 9A's rules were written in the dossier's unprefixed spelling (`ACCTOTALS.DEBIT`) and 9B's loaders in the prefixed one
 * the dossier's one verified naming fact implies (`ACCTOTALS.ACTDEBIT`, the plan's "per-table Prefix"); which the live
 * catalogue holds is OD-17's answer. A rule lists its spellings, first preferred, and reads whichever the source has —
 * always a WHOLE set, never one column from each, so a rule never joins a key of one spelling to a figure of another.
 */
export async function firstSpelling(
  reader: LegacyReader,
  table: string,
  spellings: readonly (readonly string[])[],
): Promise<readonly string[] | null> {
  for (const columns of spellings) if (await hasColumns(reader, table, columns)) return columns;
  return null;
}
