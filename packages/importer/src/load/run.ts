import { join } from "node:path";
import type { Sql } from "postgres";
import { findBatch, recordBatch, sourceHashOf, withTenant } from "@dulja/db";
import { currency, isCalendarDate, type CurrencyCode } from "@dulja/domain";
import { ReportWriter, type ArtefactIndex } from "../artefacts";
import { connectOdbc } from "../drivers/odbc";
import type { LegacyDriver, LegacyRow } from "../legacy/types";
import type { ReconciliationReport } from "../reconcile";
import { createReader, type LegacyReader } from "../reader";
import { preflight } from "./preflight";
import { assertImportTarget, type ImportTarget } from "./target";
import { refResolver } from "./refs";
import { loaders as REGISTERED, orderLoaders } from "./registry";
import {
  LoadError,
  type LoadContext,
  type Loader,
  type LoaderReport,
  type LoadReport,
  type SkipRecord,
  type SourceColumn,
} from "./types";

/** The legacy connection a run reads through: 9A's reader for rows, its driver for the catalogue. */
export interface LoadSource {
  readonly reader: LegacyReader;
  readonly driver: LegacyDriver;
  close(): Promise<void>;
}
/** Called with the tenant and company the run loads into, so the production factory can refuse a source bound to
 *  another (9B review, finding 1). A test's or the CLI's injected factory may ignore it. */
export type LoadSourceFactory = (target: ImportTarget) => Promise<LoadSource>;

/** Rows per read page and per `withTenant` transaction — short transactions (spec:1368), and 3B's
 *  `MOVEMENTS_PER_BATCH` figure, so an operator reading two runbooks sees one number. */
export const READ_BATCH = 500;

/**
 * The all-zero uuid. A loader returns it in `batchIds` for a row that was read, hashed and recorded but produced no
 * target row (Task 6's warehouse whose history nets to zero). It is never a placeholder: the `import_batch` row is
 * written only after `load` returns, with the id `load` answered, in the same transaction (ADR 0084 decision 2), so a
 * committed all-zero target can mean nothing else. Such a row is never retried — its hash is unchanged on a re-run — and
 * neither is a position opening stock reported (9B review, finding 3: its openings are one-shot).
 */
export const EMPTY_TARGET = "00000000-0000-0000-0000-000000000000";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KEY_LIMIT = 512;

let sourceFactory: LoadSourceFactory = loadSourceFromEnv;
let openSource: LoadSource | null = null;
let openBaseCurrency: CurrencyCode | null = null;
let openCutOverDate: string | null = null;

/** What a `sensitive` source column contributes to the PERSISTED source hash when it holds a value (types.ts). */
const SEALED = "[sensitive]";

/** The swappable port (7A's `setObjectStore` shape): §4.13.2 freezes `runLoad(sql, ctx)` at two parameters, so the
 *  legacy connection cannot be one, and a test or the CLI's `--fixture` must still inject `FixtureLegacyDriver`. */
export function setLoadSource(factory: LoadSourceFactory): void {
  sourceFactory = factory;
}

/**
 * The production source: `LEGACY_ODBC_DSN` (contracts §3.11; round 20 C10 gives it to the worker too), opened only for
 * the ONE tenant and company `LEGACY_IMPORT_TARGET` binds it to (round 20 C19). The DSN is process-wide and the worker
 * serves every tenant, so without the binding any holder of the import gate in any company would load this database
 * into their own. The refusal comes before the connection: nothing of the source is read.
 */
export async function loadSourceFromEnv(target: ImportTarget): Promise<LoadSource> {
  const dsn = process.env["LEGACY_ODBC_DSN"];
  if (!dsn)
    throw new LoadError(
      "ERR_IMPORT_SOURCE_UNREADABLE",
      "LEGACY_ODBC_DSN is not set; the load cannot reach the legacy database (contracts §3.11, round 20 C10)",
    );
  assertImportTarget(target);
  const driver = await connectOdbc({ dsn });
  return { driver, reader: await createReader(driver), close: () => driver.close() };
}

/** The source the run in progress opened. For a `load` that must read a second table (Task 8's payslip sums), whose
 *  signature carries no reader. Throws outside a run, so it can never open a second connection. */
export function loadSource(): LoadSource {
  if (!openSource)
    throw new LoadError(
      "ERR_IMPORT_SOURCE_UNREADABLE",
      "loadSource() was called outside a runLoad; a loader may only read the source the run opened",
    );
  return openSource;
}

/**
 * The company's base currency for the run in progress, read once when it opens. `Loader.map(row, refs)` has no
 * `LoadContext`, and every `moneyOf` is in a `map`; this is how it mints `Money` in the tenant's own currency rather
 * than an `"MYR"` literal a non-MYR company's `load` could not add to its own `Money.zero(base)` (§4.2.1). Throws
 * outside a run.
 */
export function baseCurrency(): CurrencyCode {
  if (!openBaseCurrency)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      "baseCurrency() was called outside a runLoad; the company's base currency is read once, when the run opens",
    );
  return openBaseCurrency;
}

/**
 * The run's cut-over date, for a `map` that needs it — `baseCurrency()`'s reason exactly: `map(row, refs)` has no
 * `LoadContext`. 9B T8's YTD reconciliation compares a legacy year-to-date figure with the payslips of the cut-over
 * date's tax year, and must do it in `map`, so that a figure which does not reconcile is a `{ skip }` — reported and
 * NOT recorded, and so retried once the customer corrects it. Throws outside a run.
 */
export function cutOverDate(): string {
  if (!openCutOverDate)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      "cutOverDate() was called outside a runLoad; the cut-over date is the run's own",
    );
  return openCutOverDate;
}

/**
 * Package-internal (not in the barrel): runs `fn` with the run's base currency and cut-over date set exactly as
 * `runLoad` sets them, so 9B T10's cut-over reconciliation can parse a source row with a loader's OWN `map` — the
 * recomputation it compares against is then the load's to the line, not a second reading of the same columns. The
 * source port stays unset (`loadSource()` still throws), and the guard is `runLoad`'s: one run-scoped user per process.
 */
export async function withRunScope<T>(
  scope: { baseCurrency: CurrencyCode; cutOverDate: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (openSource || openBaseCurrency || openCutOverDate)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      "a load is already running in this process; the legacy source and the base currency are run-scoped",
    );
  openBaseCurrency = scope.baseCurrency;
  openCutOverDate = scope.cutOverDate;
  try {
    return await fn();
  } finally {
    openBaseCurrency = null;
    openCutOverDate = null;
  }
}

/**
 * OD-27, Part VII #13 (9B T15). An ABSENT source table still fails pre-flight (ADR 0084 decision 3): the loader cannot
 * tell a legacy module the customer never used from a misspelt table (hazard 3), and only the second is a column-map
 * fix. Whether a module is in use is Part VII #13's question, asked by row counts (9A's `questions`); an EMPTY table
 * loads zero rows. So the refusal names the other remedy, which is the operator's to choose: leave the loaders that
 * read the absent table out with `only` (round 20 C14) — for `EMPLOYEES`, `employee` and `employee_ytd_opening`.
 */
function absentTableRemedy(
  pre: { findings: readonly { problem: string; sourceTable: string }[] },
  ordered: readonly Loader<unknown, unknown>[],
): string {
  const absent = [
    ...new Set(pre.findings.filter((f) => f.problem === "absent_table").map((f) => f.sourceTable)),
  ];
  if (absent.length === 0) return "";
  const targets = ordered.filter((l) => absent.includes(l.sourceTable)).map((l) => l.targetTable);
  return `. If the legacy module behind ${absent.join(", ")} is not in use (OD-27; Part VII #13 asks it of EMPLOYEES), re-run with only leaving out ${targets.join(", ")}`;
}

function isSkip(value: unknown): value is { skip: string } {
  return typeof value === "object" && value !== null && "skip" in value;
}

/** What one page's transaction produced, merged into the run only after it commits: `withTenant` retries a deadlock
 *  once, and a retried callback must not count, skip or remember anything twice. */
interface PageOutcome {
  inserted: number;
  skipped: number;
  skips: SkipRecord[];
  seen: Map<string, string>;
}

function selectLoaders(ctx: LoadContext): Loader<unknown, unknown>[] {
  const known = REGISTERED.map((l) => l.targetTable);
  if (ctx.only) {
    // A typo in `only` must not read as "load nothing, successfully" (C14).
    const unknown = ctx.only.filter((t) => !known.includes(t));
    if (unknown.length > 0 || ctx.only.length === 0)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `no loader targets ${unknown.join(", ") || "(an empty list)"}; registered target tables are ${known.join(", ") || "(none)"}`,
      );
  }
  for (const loader of REGISTERED)
    if (loader.sourceColumns.length === 0)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `${loader.targetTable} declares no source columns; pre-flight has nothing to check (hazard 3)`,
      );
  // Filtered THEN ordered, so a restricted run still runs in dependency order. A reference into a loader left out
  // resolves only if an earlier run loaded it, which is why `only` is a resume switch, not a scoping feature.
  const only = ctx.only;
  return orderLoaders(only ? REGISTERED.filter((l) => only.includes(l.targetTable)) : REGISTERED);
}

/**
 * 2026-11-15 review, HRP-04 (ADR 0084 decision 28). A real run that leaves out a loader another selected loader
 * depends on is refused when that parent has never recorded a row in the company although its source table has rows:
 * the parent has not been loaded, so every reference into it would fail. For a paged loader that is only wasted map
 * skips, but a skip a loader's `load` reports is recorded and final (decision 27) and the two whole-table openings are
 * one-shot (decision 26) — `only: ["opening_stock"]` on a fresh company recorded every BILLITEMS row against no
 * document, and the later full run, finding them recorded, opened nothing; the only remedy was a fresh company.
 * Checked after pre-flight (every table is there) and before any loader runs, so the refusal writes nothing. A parent
 * whose source table is empty records nothing and is not missing; a dry run, which writes nothing, is not refused.
 */
async function refuseUnloadedParents(
  conn: Sql,
  ctx: LoadContext,
  reader: LegacyReader,
  ordered: readonly Loader<unknown, unknown>[],
): Promise<void> {
  const selected = new Set(ordered.map((l) => l.targetTable));
  const parents = [...new Set(ordered.flatMap((l) => l.dependsOn))].filter((d) => !selected.has(d));
  for (const parent of parents) {
    const loader = REGISTERED.find((l) => l.targetTable === parent);
    const children = ordered.filter((l) => l.dependsOn.includes(parent)).map((l) => l.targetTable);
    if (!loader)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `${children.join(", ")} depends on ${parent}, which no registered loader loads`,
      );
    const recorded = await withTenant(conn, ctx, async (tx) => {
      const [row] = await tx<{ any: boolean }[]>`
        select exists (select 1 from app.import_batch
                        where company_id = ${ctx.companyId} and target_table = ${parent}) as any`;
      return row!.any;
    });
    if (recorded) continue;
    if ((await reader.count(loader.sourceTable)) === 0) continue;
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `this run loads ${children.join(", ")} without ${parent}, which has never been loaded into company ${ctx.companyId} although the source's ${loader.sourceTable} has rows; every reference into it would be reported, and ${children.some((c) => WHOLE_TABLE_ONE_SHOT.has(c)) ? "an opening reported now is one-shot and final" : "a row reported by a load is final"} — run ${parent} first, or include it in this run`,
    );
  }
}

/** The whole-table openings ADR 0084 decision 26 makes one-shot (named in `refuseUnloadedParents`' refusal only). */
const WHOLE_TABLE_ONE_SHOT: ReadonlySet<string> = new Set(["opening_balance", "opening_stock"]);

function assertContext(ctx: LoadContext): void {
  if (!UUID.test(ctx.runId))
    throw new LoadError("ERR_VALIDATION_FAILED", `runId ${ctx.runId} is not a uuid`);
  if (!isCalendarDate(ctx.cutOverDate))
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `cutOverDate ${ctx.cutOverDate} is not a YYYY-MM-DD date; the operator enters it (spec:2039)`,
    );
}

/**
 * Contracts §4.13.2. Runs the registered loaders (or `ctx.only`'s) in dependency order, as the caller's principal —
 * which `apps/worker` and the CLI make the tenant's SYSTEM principal (spec:2179, hazard 20) — and never writes a
 * ledger or movement row itself: a loader that opens a balance builds a document and calls `postDocument`.
 *
 * Per source row, in one `withTenant` transaction per page (ADR 0084):
 *  1. its `sourceKey` and the sha256 of exactly the columns its loader declared;
 *  2. a key already seen in THIS run is a duplicate in the source (SAH-049) — a second identical sighting is a skip
 *     in the register, a different one refuses the run;
 *  3. a key an EARLIER run recorded (`findBatch`) is a silent skip with the same hash and refuses the run with a
 *     different one (`ERR_IMPORT_DUPLICATE_SOURCE_KEY`) — before `map` runs and before anything is written;
 *  4. `map`; a `{ skip }` goes to the register and is not recorded, so a corrected source maps it next time — for a
 *     PAGED loader. A whole-table opening (C13) is one-shot (9B review, finding 3): once any run recorded a row of it,
 *     a row that maps later reaches a `load` that refuses (`refusePriorOpening`), because the loader's answer is a
 *     function of the whole table and a re-run would compute it from the late rows alone. A skip `load` itself reports
 *     (C15) is recorded with its row and is final for every loader (ADR 0084 decision 7); the cut-over corrects it
 *     with an ordinary document and the reconciliation names it as explained by the skip register;
 *  5. `load` with every mapped row of the page, then `recordBatch` with the target id `load` answered for each.
 * The batch row is written AFTER the target row and in the same transaction: `app_rw` holds no UPDATE on
 * `import_batch` (0102), so a placeholder could never be filled in, and none is needed — the refusal in step 3 already
 * happens before any write.
 *
 * A dry run performs every read, check and `map`, and never calls `load`; its `inserted` is the count of rows that
 * MAPPED, an upper bound on a real run's (ADR 0084 decision 5). A refusal writes `load-failed.json` beside the
 * pre-flight report; every page committed before it stays committed and recorded, which is what makes re-running the
 * same command a resume.
 */
export async function runLoad(conn: Sql, ctx: LoadContext): Promise<LoadReport> {
  assertContext(ctx);
  const ordered = selectLoaders(ctx);
  if (openSource)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      "a load is already running in this process; the legacy source and the base currency are run-scoped",
    );
  const source = await sourceFactory({ tenantId: ctx.tenantId, companyId: ctx.companyId });
  openSource = source;
  openCutOverDate = ctx.cutOverDate;
  const perLoader: Record<string, LoaderReport> = {};
  const skips: SkipRecord[] = [];
  const reconciliation: ReconciliationReport[] = [];
  let writer: ReportWriter | null = null;

  try {
    writer = new ReportWriter(join("artefacts", "legacy", ctx.runId), {
      source: source.driver.source,
      engineVersion: source.reader.firebirdVersion,
    });
    openBaseCurrency = await withTenant(conn, ctx, async (tx) => {
      const [company] = await tx<{ base_currency: string }[]>`
        select base_currency from app.company where id = ${ctx.companyId}`;
      if (!company)
        throw new LoadError("ERR_VALIDATION_FAILED", `no company ${ctx.companyId} in this tenant`);
      return currency(company.base_currency);
    });

    const pre = await preflight(source.driver, ordered);
    writer.json("preflight.json", pre, pre.findings.length);
    if (!pre.ok) {
      const missing = pre.findings
        .filter((f) => f.required)
        .map((f) => `${f.sourceTable}.${f.column}`)
        .join(", ");
      throw new LoadError(
        "ERR_IMPORT_SOURCE_UNREADABLE",
        `pre-flight failed: the source has no ${missing}. Re-run 9A's scope report and correct the column map before loading${absentTableRemedy(pre, ordered)}`,
      );
    }

    if (!ctx.dryRun) await refuseUnloadedParents(conn, ctx, source.reader, ordered);

    for (const loader of ordered) {
      const report: LoaderReport = { inserted: 0, skipped: 0, conflicts: 0 };
      perLoader[loader.targetTable] = report;
      await runLoader(conn, ctx, source, loader, report, skips);
      writer.json(`loader-${loader.targetTable}.json`, report, report.inserted);
    }

    writer.json(
      "load-summary.json",
      { runId: ctx.runId, cutOverDate: ctx.cutOverDate, dryRun: ctx.dryRun, perLoader },
      Object.keys(perLoader).length,
    );
    writer.csv(
      "skips.csv",
      skips.map((s) => ({ ...s })),
    );
    const artefacts: ArtefactIndex = writer.finish();
    return { perLoader, reconciliation, artefacts, skips };
  } catch (error) {
    if (writer) {
      writer.json(
        "load-failed.json",
        {
          runId: ctx.runId,
          error: error instanceof Error ? error.message : String(error),
          perLoader,
          skips: skips.length,
        },
        1,
      );
      writer.finish();
    }
    throw error;
  } finally {
    openSource = null;
    openBaseCurrency = null;
    openCutOverDate = null;
    await source.close();
  }
}

async function runLoader(
  conn: Sql,
  ctx: LoadContext,
  source: LoadSource,
  loader: Loader<unknown, unknown>,
  report: LoaderReport,
  skips: SkipRecord[],
): Promise<void> {
  const declared = loader.sourceColumns.map((c) => c.name);
  // Pre-flight let a missing OPTIONAL column through; it is not read, and it hashes and maps as NULL.
  const have = new Set((await source.driver.columns(loader.sourceTable)).map((c) => c.name));
  const readable = declared.filter((c) => have.has(c));
  // Every key this run has met for this loader, with its hash: a key and a sha256 per source row. A whole-table
  // loader holds its rows in memory anyway (C13); for a paged one this is the price of SAH-049 being caught across
  // page boundaries and in a dry run, which writes nothing a later page could read back.
  const seen = new Map<string, string>();

  const runPage = async (rows: readonly LegacyRow[]): Promise<void> => {
    // Before the page's transaction: a run whose claim was taken over stops here, having written nothing of it.
    await ctx.heartbeat?.();
    const outcome = await withTenant(conn, ctx, (tx) =>
      mapAndLoad(tx, ctx, loader, rows, seen, report),
    );
    for (const [key, hash] of outcome.seen) seen.set(key, hash);
    report.inserted += outcome.inserted;
    report.skipped += outcome.skipped;
    skips.push(...outcome.skips);
  };

  // C13: a paged loader sees each page as the reader yields it; a whole-table loader sees the concatenation, once.
  // The wire is paged either way — READ_BATCH bounds the driver's fetch.
  const held: LegacyRow[] = [];
  for await (const page of source.reader.read<LegacyRow>(loader.sourceTable, {
    columns: readable,
    batch: READ_BATCH,
  })) {
    if (loader.wholeTable) held.push(...page);
    else await runPage(page);
  }
  if (loader.wholeTable && held.length > 0) await runPage(held);
}

async function mapAndLoad(
  tx: Sql,
  ctx: LoadContext,
  loader: Loader<unknown, unknown>,
  rows: readonly LegacyRow[],
  runSeen: ReadonlyMap<string, string>,
  report: LoaderReport,
): Promise<PageOutcome> {
  const site = `${loader.targetTable} (${loader.sourceTable})`;
  const outcome: PageOutcome = { inserted: 0, skipped: 0, skips: [], seen: new Map() };
  const skip = (sourceKey: string, reason: string): void => {
    outcome.skipped += 1;
    outcome.skips.push({
      loader: loader.targetTable,
      sourceTable: loader.sourceTable,
      sourceKey,
      reason,
    });
  };
  const refs = refResolver(tx, ctx.companyId);
  const mapped: unknown[] = [];
  const keys: string[] = [];
  const hashes: string[] = [];

  for (const row of rows) {
    const key = loader.sourceKey(row);
    if (key.length === 0 || key.length > SOURCE_KEY_LIMIT)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `${site}: a source key must be 1–${SOURCE_KEY_LIMIT} characters, got ${key.length}`,
      );
    // Exactly the declared columns, so a column added to the source after the freeze is not a change to a row. Two
    // digests: the in-run one covers every value and never leaves memory; the persisted one carries a `sensitive`
    // column as presence only (types.ts), so `import_batch` holds nothing derived from a value behind sensitive_gate or a pay figure.
    const values = (c: SourceColumn): LegacyRow[string] => row[c.name] ?? null;
    const full = sourceHashOf(
      Object.fromEntries(loader.sourceColumns.map((c) => [c.name, values(c)])),
    );
    const hash = sourceHashOf(
      Object.fromEntries(
        loader.sourceColumns.map((c) => [
          c.name,
          c.sensitive === true && values(c) !== null ? SEALED : values(c),
        ]),
      ),
    );

    const earlier = outcome.seen.get(key) ?? runSeen.get(key);
    if (earlier !== undefined) {
      if (earlier !== full) {
        report.conflicts += 1;
        throw new LoadError(
          "ERR_IMPORT_DUPLICATE_SOURCE_KEY",
          `${loader.sourceTable}/${key} appears twice in the source with different data; the loader's key does not identify a row (SAH-049)`,
        );
      }
      skip(
        key,
        "the source holds this key twice with identical data; it was loaded once (SAH-049)",
      );
      continue;
    }
    outcome.seen.set(key, full);

    const prior = await findBatch(tx, {
      companyId: ctx.companyId,
      sourceTable: loader.sourceTable,
      sourceKey: key,
    });
    if (prior) {
      if (prior.sourceHash !== hash || prior.targetTable !== loader.targetTable) {
        report.conflicts += 1;
        throw new LoadError(
          "ERR_IMPORT_DUPLICATE_SOURCE_KEY",
          prior.targetTable === loader.targetTable
            ? `${loader.sourceTable}/${key} was loaded with different data on an earlier run; freeze the source and re-run. A recorded row is never loaded again — reversing what it became does not change that — so correct it in Dulja with an ordinary document, or load the whole source into a fresh company`
            : `${loader.sourceTable}/${key} is already mapped to ${prior.targetTable}; two loaders of one source table need disjoint keys`,
        );
      }
      outcome.skipped += 1;
      continue;
    }

    const result = await loader.map(row, refs);
    if (isSkip(result)) {
      skip(key, result.skip);
      continue;
    }
    mapped.push(result);
    keys.push(key);
    hashes.push(hash);
  }

  if (mapped.length === 0) return outcome;
  if (ctx.dryRun) {
    outcome.inserted += mapped.length;
    return outcome;
  }

  const out = await loader.load(tx, ctx, mapped);
  // POSITIONAL and TOTAL: keys[i] and batchIds[i] are one source row. A short or long answer has lost track of which
  // row became which target, and pairing the first N would point import_batch rows at the wrong targets for ever.
  if (out.batchIds.length !== mapped.length)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: load returned ${out.batchIds.length} target ids for ${mapped.length} mapped rows; a loader returns one per row, in order`,
    );
  for (const [i, key] of keys.entries()) {
    const targetId = out.batchIds[i]!;
    if (!UUID.test(targetId))
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `${site}: load returned ${JSON.stringify(targetId)} for ${key}, which is not a uuid`,
      );
    const recorded = await recordBatch(tx, {
      companyId: ctx.companyId,
      sourceTable: loader.sourceTable,
      sourceKey: key,
      targetTable: loader.targetTable,
      targetId,
      sourceHash: hashes[i]!,
      runId: ctx.runId,
    });
    // findBatch saw nothing for this key a moment ago, in this transaction: another load committed it since.
    if (recorded.kind !== "inserted")
      throw new LoadError(
        "ERR_IMPORT_DUPLICATE_SOURCE_KEY",
        `${loader.sourceTable}/${key} was recorded by a concurrent load of this company; run one load at a time`,
      );
  }
  outcome.inserted += out.inserted;
  outcome.skipped += out.skipped;
  if (out.skips) outcome.skips.push(...out.skips);
  return outcome;
}
