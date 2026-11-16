import type { Sql } from "postgres";
import type { TenantContext } from "@dulja/db";
import type { ArtefactIndex } from "../artefacts";
import type { ReconciliationReport } from "../reconcile";

/**
 * Contracts §4.13.2 (9B), with round 20's additive widenings C8, C9, C12, C13, C14 and C15. Every write a loader
 * makes runs as the tenant's SYSTEM principal (spec:2179) inside a `withTenant` transaction `runLoad` opens.
 */
export interface LoadContext extends TenantContext {
  companyId: string;
  /** One id per run: every `app.import_batch` row the run writes carries it, and its artefacts land under it. */
  runId: string;
  /** The accounting date every imported document carries. Entered by the operator (spec:2039), never derived from a
   *  legacy timestamp and never from `now()`. */
  cutOverDate: string;
  /** Read and map every row, write nothing (ADR 0084 decision 5). */
  dryRun: boolean;
  /** C14 — restrict the run to these TARGET tables (the resume switch). `runLoad` refuses a name no loader targets
   *  rather than running nothing, and orders whatever survives the filter. Omitted means every registered loader. */
  only?: string[];
  /** 9B review, finding 5 (round 20 C21) — called before every page's transaction. The worker renews its claim on the
   *  run here, and throws to stop the load once another claim has taken the run over, so a superseded load writes no
   *  further page. Omitted (the CLI, the tests) means no claim to keep. */
  heartbeat?: () => Promise<void>;
}

export interface RefResolver {
  /** `table` is the TARGET table (`item`, `party`, …); `legacyRef` is that target's loader's source key, spelled
   *  exactly as its `sourceKey` spells it. Answers only what a load recorded in `app.import_batch`, never a row a
   *  person created by hand that happens to carry the same code. */
  byLegacyRef(table: string, legacyRef: string): Promise<string | null>;
}

/** C8 — a source column is DATA with a confidence, never a transcribed row interface (hazard 3). `verified` only once
 *  a live catalogue has been read and the reading recorded in ADR 0084 (OD-17, 9B Task 14). */
export interface SourceColumn {
  /** Upper case, as Firebird stores it; matched exactly against `LegacyDriver.columns()`. */
  readonly name: string;
  /** A missing required column fails pre-flight; a missing optional one is a finding and is read as NULL. */
  readonly required: boolean;
  readonly confidence: "verified" | "hypothesis";
  /** Why this column, in one sentence, for the pre-flight report. */
  readonly note: string;
  /** 9B T8 — the value lands behind 8A's RESTRICTIVE `sensitive_gate` (§4.12.5), or (9B review, finding 6) is a pay
   *  figure `hr.payroll.read` gates (the YTD opening's gross and net). It enters the persisted
   *  `import_batch.source_hash` as PRESENCE only (NULL or a fixed marker), never as a digest of the value: a sha256 of
   *  a national id or a date of birth is brute-forced from the few unknowns around it, and `import_batch` is behind
   *  tenant RLS alone, so a digest would be a side channel past the gate (acceptance test 32). The in-run duplicate
   *  check (SAH-049) still compares the full row in memory. */
  readonly sensitive?: boolean;
}

export interface SkipRecord {
  loader: string;
  sourceTable: string;
  sourceKey: string;
  reason: string;
}

/** What `load` answers for the rows it was handed (§4.13.2, plus C15's `skips`). */
export interface LoadResult {
  inserted: number;
  skipped: number;
  /** POSITIONAL and TOTAL: one target id per row handed to `load`, in that order. A row that produced no target row
   *  answers `EMPTY_TARGET`; rows that share one document answer that document's id each. */
  batchIds: string[];
  /** C15 — the reasons only `load` can know. `skipped` already counts them. Their rows are RECORDED (`batchIds`), so a
   *  skip reported here is final: no re-run retries it (ADR 0084 decisions 7 and 27). */
  skips?: readonly SkipRecord[];
}

export interface Loader<S, T> {
  readonly sourceTable: string;
  readonly targetTable: string;
  /** TARGET table names this loader resolves references into; `orderLoaders` runs those first. */
  readonly dependsOn: string[];
  /** C8. */
  readonly sourceColumns: readonly SourceColumn[];
  /** C13. Absent or false: `load` is called once per page of at most `READ_BATCH` rows, one transaction each. True:
   *  the loader's answer is a function of the WHOLE table (one suspense residue, one moving average), so every page is
   *  mapped first and `load` is called once, in one transaction. */
  readonly wholeTable?: boolean;
  /** C8 — the `import_batch` natural key of a source row (1–512 characters). */
  readonly sourceKey: (row: S) => string;
  /** No writes, and no reads beyond `refs` and the run's own legacy source (`loadSource()` — 9B T8's payslip
   *  reconciliation, the one cross-table check a row needs before it may be recorded). `{ skip }` is how a row that
   *  cannot be mapped is REPORTED rather than nulled (§5.1 #3), and a skipped row is not recorded, so a corrected
   *  source maps it on the next run — unless the loader is `wholeTable` and an earlier run already recorded its
   *  opening: a whole-table opening is one-shot (9B review, finding 3), and its `load` refuses a late row rather than
   *  computing an opening from it alone. C12: may be async, because `RefResolver` is. */
  map(row: S, refs: RefResolver): T | { skip: string } | Promise<T | { skip: string }>;
  load(tx: Sql, ctx: LoadContext, rows: T[]): Promise<LoadResult>;
}

/** Per-loader counts. `inserted` and `skipped` are §4.13.2's; `conflicts` is how many changed source rows the run
 *  met before it refused (it refuses on the first, so a returned report always carries 0 — `load-failed.json` is
 *  where a non-zero count is written). */
export interface LoaderReport {
  inserted: number;
  skipped: number;
  conflicts: number;
}

export interface LoadReport {
  perLoader: Record<string, LoaderReport>;
  reconciliation: ReconciliationReport[];
  /** C9 — the run's artefact manifest, every entry hashed. */
  artefacts: ArtefactIndex;
  skips: SkipRecord[];
}

/** The codes `LoadError` carries. `ERR_IMPORT_UNBALANCED_SOURCE` joins `ERRORS` with Task 5, which first raises it. */
export type LoadErrorCode =
  | "ERR_IMPORT_DUPLICATE_SOURCE_KEY"
  | "ERR_IMPORT_UNBALANCED_SOURCE"
  | "ERR_IMPORT_SOURCE_UNREADABLE"
  | "ERR_IMPORT_SOURCE_NOT_BOUND"
  | "ERR_VALIDATION_FAILED";

/**
 * The one error `packages/importer/src/load/**` raises. The package may not import `@dulja/contracts`' `AppError`
 * (§3.1 — 9A's `unreadable` has the same constraint), so the code travels as a field and `apps/worker`'s handler
 * maps it; the message starts with the code, which is what 9A's CLI already branches on.
 */
export class LoadError extends Error {
  readonly code: LoadErrorCode;
  readonly detail: string;

  constructor(code: LoadErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "LoadError";
    this.code = code;
    this.detail = detail;
  }
}
