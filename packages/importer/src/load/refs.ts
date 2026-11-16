import type { Sql } from "postgres";
import { byLegacyRef } from "@dulja/db";
import { loaders } from "./registry";
import type { RefResolver } from "./types";

/**
 * The §4.13.2 resolver, backed by `app.import_batch` (T2) and nothing else: a loader sees only what a LOAD produced,
 * so a hand-created row that happens to carry the same code is never mistaken for an imported one.
 *
 * §4.13.2's `byLegacyRef(table, legacyRef)` names only the TARGET table, while `import_batch` keys on the source
 * table. The source table is therefore taken from the registered loader that targets `table` — the registry is the one
 * place that pairing is written, so it cannot drift from a second copy (the plan's `SOURCE_OF` list; ADR 0084). A
 * target no registered loader produces resolves nothing (`null`), which the calling loader reports as an orphan; so
 * does an employee's party, which Task 8 records under `employee` only.
 *
 * `legacyRef` must be spelled exactly as that target's loader's `sourceKey` spells it.
 */
export function refResolver(tx: Sql, companyId: string): RefResolver {
  return {
    async byLegacyRef(table: string, legacyRef: string): Promise<string | null> {
      const owner = loaders.find((l) => l.targetTable === table);
      if (owner === undefined) return null;
      return byLegacyRef(tx, {
        companyId,
        sourceTable: owner.sourceTable,
        sourceKey: legacyRef,
        targetTable: table,
      });
    },
  };
}
