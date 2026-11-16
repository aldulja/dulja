import type { Sql } from "postgres";
import { LoadError, type LoadContext, type LoadResult } from "./types";

/** A mapped master row: the legacy key it came from and the natural code it would like in Dulja. */
export interface CodedRow {
  readonly legacyKey: string;
  readonly code: string;
}

export interface Placement<T extends CodedRow> {
  /** The id of the live row already holding `code` for this row's scope (the company, or a lot's item), or null. */
  find(row: T, code: string): Promise<string | null>;
  /** Creates the row under `code` through the tree's own service and answers its id. */
  create(row: T, code: string): Promise<string>;
  /**
   * Before rule 2 adopts the person-made row `existingId`: what about it differs from what the load would have created
   * (the field and both values), or null when it is the same thing. A code alone does not make two rows one — an item
   * adopted in PIECE whose legacy unit is BOX books every opening box as a piece, and the value-only reconciliation
   * stays green (2026-11-15 review, HRP-13).
   */
  mismatch?(row: T, existingId: string): Promise<string | null>;
}

/** Whether an earlier load (any run) recorded `targetId` as what a legacy key of `targetTable` became. Package-internal:
 *  the master loaders here and 9B T8's employee loader, which adopts or refuses by the same rule. */
export async function mappedByLoad(
  tx: Sql,
  companyId: string,
  targetTable: string,
  targetId: string,
): Promise<boolean> {
  const [row] = await tx<{ mapped: boolean }[]>`
    select exists (
      select 1 from app.import_batch
       where company_id = ${companyId} and target_table = ${targetTable} and target_id = ${targetId}
    ) as mapped`;
  return row!.mapped;
}

/**
 * The one create-or-adopt loop of the code-keyed master loaders (unit, warehouse, item, lot, party). A legacy name
 * becomes a Dulja code through `codeFromName`, and free text collides: `Main store` and `MAIN  STORE` are both
 * `MAIN-STORE`. The rules, in order:
 *
 *  1. the code is free → the row is created through the service (`inserted`);
 *  2. the code is held by a row a person made (no `import_batch` row points at it, and this call did not claim it) →
 *     the load ADOPTS it rather than duplicating it (`skipped`): a rehearsal through the API is the case. A row whose
 *     `mismatch` names a difference (an item's unit, kind or lot tracking; a warehouse's branch) is NOT adopted: the run
 *     is refused, naming the field, because neither a silent adoption nor a suffixed twin is right;
 *  3. the code is held by a row ANOTHER legacy key already became — earlier in this call, or recorded by an earlier
 *     page or run → the row takes `<code>-<legacyKey>` instead. Two legacy rows never collapse into one Dulja row:
 *     two items' stock merged into one is a tie-out that can never close, and nothing would say why.
 *
 * `name_en` always keeps the legacy name verbatim, so the suffix loses nothing. A suffixed code that is itself taken
 * refuses the run, naming both codes: there is no third rule to guess with.
 */
export async function placeByCode<T extends CodedRow>(
  tx: Sql,
  ctx: LoadContext,
  targetTable: string,
  rows: readonly T[],
  placement: Placement<T>,
): Promise<LoadResult> {
  const claimed = new Set<string>();
  const batchIds: string[] = [];
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    let code = row.code;
    let existing = await placement.find(row, code);
    if (
      existing !== null &&
      (claimed.has(existing) || (await mappedByLoad(tx, ctx.companyId, targetTable, existing)))
    ) {
      code = `${row.code}-${row.legacyKey}`;
      existing = await placement.find(row, code);
      if (existing !== null)
        throw new LoadError(
          "ERR_VALIDATION_FAILED",
          `${targetTable}: legacy ${row.legacyKey} wants code ${row.code}, which another legacy row already became, and ${code} is taken too; rename one of them in the source`,
        );
    }
    if (existing !== null) {
      const differs = (await placement.mismatch?.(row, existing)) ?? null;
      if (differs !== null)
        throw new LoadError(
          "ERR_VALIDATION_FAILED",
          `${targetTable}: legacy ${row.legacyKey} would adopt the existing ${code}, which a person made, but ${differs}; correct or rename that ${targetTable} before the load`,
        );
      skipped += 1;
      claimed.add(existing);
      batchIds.push(existing);
      continue;
    }
    const id = await placement.create(row, code);
    inserted += 1;
    claimed.add(id);
    batchIds.push(id);
  }
  return { inserted, skipped, batchIds };
}
