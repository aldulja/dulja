import { createHash } from "node:crypto";
import type { Sql } from "postgres";

/**
 * 9B T2 — the `import_batch` service (contracts §4.13.3, round 20 C7; the 9B plan's N13). The Phase 9 load's
 * idempotence ledger: one row per (company, source_table, source_key), recording what that legacy key became.
 * `byLegacyRef` is the §4.13.2 `RefResolver`'s one query. Every function takes the caller's `tx` — a transaction
 * opened by `withTenant`, so RLS bounds the tenant and the `company_id` predicate bounds the company.
 */
export interface ImportBatchRow {
  id: string;
  sourceTable: string;
  sourceKey: string;
  targetTable: string;
  targetId: string;
  sourceHash: string;
  runId: string;
  loadedBy: string;
  /** RFC 3339 UTC to the microsecond, the export's and 7A's wire form. */
  createdAt: string;
}

export interface RecordBatchInput {
  companyId: string;
  sourceTable: string;
  sourceKey: string;
  targetTable: string;
  targetId: string;
  sourceHash: string;
  runId: string;
}

export type RecordBatchOutcome =
  | { kind: "inserted"; id: string; targetId: string }
  /** The same key with the same hash: a harmless re-run. `targetId` is the FIRST mapping, never the input's. */
  | { kind: "skipped"; id: string; targetId: string }
  /** The same key with a different hash: the source moved under a frozen load. The caller raises
   *  `ERR_IMPORT_DUPLICATE_SOURCE_KEY`; `targetId` is still the first mapping. */
  | { kind: "conflict"; id: string; targetId: string };

/**
 * `packages/db` may not import `AppError` (§3.1), so a refusal carries its code as a field for the importer and the
 * worker to translate — 8C's `OpeningError` shape (contracts round 20 C16 item 9).
 */
export class ImportBatchError extends Error {
  readonly code = "ERR_IMPORT_DUPLICATE_SOURCE_KEY";
  constructor(readonly detail: string) {
    super(`ERR_IMPORT_DUPLICATE_SOURCE_KEY: ${detail}`);
    this.name = "ImportBatchError";
  }
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  return value;
};

/** sha256 (lower-case hex) of the payload's JSON with every object's keys sorted by code unit, so a re-read that
 *  returns the same values in another column order is not a false conflict. An array's order is data and is kept. */
export function sourceHashOf(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(payload)) ?? "null")
    .digest("hex");
}

/**
 * Insert-or-classify. `on conflict do nothing` plus a read rather than `do update`, because the mapping never moves
 * (and `app_rw` holds no UPDATE on the table — 0102): a legacy key that became a row keeps that row for ever, and a
 * changed source is reported, never silently re-pointed.
 */
export async function recordBatch(tx: Sql, input: RecordBatchInput): Promise<RecordBatchOutcome> {
  const [inserted] = await tx<{ id: string; target_id: string }[]>`
    insert into app.import_batch
      (tenant_id, company_id, source_table, source_key, target_table, target_id, source_hash, run_id)
    values (app.current_tenant(), ${input.companyId}, ${input.sourceTable}, ${input.sourceKey},
            ${input.targetTable}, ${input.targetId}, ${input.sourceHash}, ${input.runId})
    on conflict (company_id, source_table, source_key) do nothing
    returning id, target_id`;
  if (inserted) return { kind: "inserted", id: inserted.id, targetId: inserted.target_id };

  const [existing] = await tx<{ id: string; target_id: string; source_hash: string }[]>`
    select id, target_id, source_hash from app.import_batch
     where company_id = ${input.companyId} and source_table = ${input.sourceTable}
       and source_key = ${input.sourceKey}`;
  if (!existing)
    // The conflicting row is invisible to this transaction: another tenant's company id (RLS hides it), or a
    // concurrent insert that has not committed. Neither is a re-run, and looping would hide it.
    throw new ImportBatchError(
      `${input.sourceTable}/${input.sourceKey} conflicted with a row this transaction cannot see`,
    );
  return {
    kind: existing.source_hash === input.sourceHash ? "skipped" : "conflict",
    id: existing.id,
    targetId: existing.target_id,
  };
}

export async function findBatch(
  tx: Sql,
  input: { companyId: string; sourceTable: string; sourceKey: string },
): Promise<ImportBatchRow | null> {
  const [row] = await tx<ImportBatchRow[]>`
    select id, source_table as "sourceTable", source_key as "sourceKey", target_table as "targetTable",
           target_id as "targetId", source_hash as "sourceHash", run_id as "runId", loaded_by as "loadedBy",
           to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
      from app.import_batch
     where company_id = ${input.companyId} and source_table = ${input.sourceTable}
       and source_key = ${input.sourceKey}`;
  return row ?? null;
}

/** The §4.13.2 `RefResolver`'s one query: what did this legacy key become in `targetTable`? */
export async function byLegacyRef(
  tx: Sql,
  input: { companyId: string; sourceTable: string; sourceKey: string; targetTable: string },
): Promise<string | null> {
  const [row] = await tx<{ target_id: string }[]>`
    select target_id from app.import_batch
     where company_id = ${input.companyId} and source_table = ${input.sourceTable}
       and source_key = ${input.sourceKey} and target_table = ${input.targetTable}`;
  return row?.target_id ?? null;
}

/** Progress: rows loaded per target table for one run, by target table. */
export async function batchCounts(
  tx: Sql,
  input: { companyId: string; runId: string },
): Promise<{ targetTable: string; rows: number }[]> {
  return tx<{ targetTable: string; rows: number }[]>`
    select target_table as "targetTable", count(*)::int as rows
      from app.import_batch
     where company_id = ${input.companyId} and run_id = ${input.runId}
     group by target_table
     order by target_table`;
}
