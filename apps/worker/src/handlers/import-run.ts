// The barrel first: it imports `./load/registry` before any loader module (9B T6's note — a loader module imported
// first would build `loaders` with that loader still unset).
import {
  ACCOUNT_MAP_TARGETS,
  assertAccountMap,
  assertImportTarget,
  clearAccountMap,
  clearKeyRing,
  loaders,
  runLoad,
  SENSITIVE_TARGETS,
  setAccountMap,
  setKeyRing,
  type LoadContext,
} from "@dulja/importer";
import {
  claimImportRun,
  completeImportRun,
  failImportRun,
  FAILURE_DETAIL_MAX,
  importRunBusyFollowUpOptions,
  importRunFollowUpOptions,
  JobNotInsertedError,
  importRunLeaseState,
  missingImportWriteCodes,
  renewImportRunLease,
  unmappedImportTargets,
  withTenant,
  type ImportRunRow,
} from "@dulja/db";
import type { JobHandler } from "../handler";
import { hrKeyRing } from "../hr-keys";
import { jobs } from "../jobs";
import { failureDetail } from "../jobs/failure";
import { deferPastLease } from "../jobs/lease";
import { log } from "../log";

/**
 * The run's failure as the status resource shows it: `CODE: detail`, capped at `FAILURE_DETAIL_MAX`. The load's three
 * refusals — `LoadError` (the framework and the loaders), `PostingError` (the posting service under `draftAndPost`)
 * and `ImportBatchError` (a key recorded by a concurrent load) — each carry `code` and `detail` and a message that
 * already STARTS with the code, so they are written from the two fields; 7A/7C's `failureDetail` would print the code
 * twice. Anything else is `failureDetail`'s (`ERR_INTERNAL` unless it carries an `ERR_` code).
 */
export function importFailureDetail(error: unknown): string {
  if (error instanceof Error) {
    const { code, detail } = error as { code?: unknown; detail?: unknown };
    if (typeof code === "string" && code.startsWith("ERR_") && typeof detail === "string")
      return `${code}: ${detail}`.slice(0, FAILURE_DETAIL_MAX);
  }
  return failureDetail(error);
}

/** A refusal raised by the handler itself, before the load starts — `LoadError`'s shape, so it maps alike. */
class RunRefused extends Error {
  constructor(
    readonly detail: string,
    readonly code: "ERR_VALIDATION_FAILED" | "ERR_RBAC_FORBIDDEN" = "ERR_VALIDATION_FAILED",
  ) {
    super(`${code}: ${detail}`);
    this.name = "RunRefused";
  }
}

/** The heartbeat found the run claimed by another delivery (or settled): this load stops, recording nothing. */
class ClaimSuperseded extends Error {
  constructor(runId: string, attempt: number) {
    super(`import run ${runId}: claim ${attempt} was superseded`);
    this.name = "ClaimSuperseded";
  }
}

/** Whether `pick` names a field C3's payload and the row disagree on: the row is authoritative (the payload is in
 *  `pgboss.job`, which any `app_rw` session can write and no RLS bounds). */
function disagreement(run: ImportRunRow, payload: Record<string, unknown>): string | null {
  const only = payload["only"];
  if (payload["companyId"] !== run.companyId) return "companyId";
  if (payload["cutOverDate"] !== run.cutOverDate) return "cutOverDate";
  if (payload["dryRun"] !== run.dryRun) return "dryRun";
  if (JSON.stringify(only ?? null) !== JSON.stringify(run.only)) return "only";
  return null;
}

/** One load per process at a time: `runLoad`'s source, currency, account map and key ring are module state. A second
 *  delivery while one loads — a redelivery of an expired job, a second company's run — is deferred, not thrown. */
let busy = false;

/**
 * `admin.import.run` — the one deployed entry point of the cut-over load (9B Task 9; contracts §4.13.2, round 20 C3,
 * C10, C17). Short transactions, never one long one: claim the `import_run` row, run the load (`runLoad` opens one
 * transaction per page), record the outcome. `ctx` is the tenant's SYSTEM principal — `runJob` built it with
 * `systemContext` — so every `import_batch` row, document, ledger row and audit row carries the system actor, which is
 * what test 13 checks and spec:2179 requires of a job.
 *
 * The RUN fails, not the job (7C's rule for the export): a refusal is recorded on the row with its stable code, and a
 * pg-boss retry would find the row no longer queued and do nothing. A worker that DIES is the lease's case: the
 * redelivery reclaims the row once the lease lapses, and the load resumes (`import_batch` makes a re-run a resume).
 */
export const importRunHandler: JobHandler<"admin.import.run"> = async (sql, job, ctx) => {
  // §3.7.2's job-isolation harness runs EVERY registered job with `payload: {}`, and a hand-enqueued or truncated job
  // is the same shape in production. Either way the honest answer is a logged no-op — never a load against
  // `company_id = undefined`.
  const payload = (job.payload ?? {}) as unknown as Record<string, unknown>;
  const runId = payload["runId"];
  if (typeof runId !== "string" || typeof payload["companyId"] !== "string") {
    log().info(
      { job: "admin.import.run", tenant_id: ctx.tenantId },
      "no runId or companyId in the payload; nothing to load",
    );
    return;
  }
  const logger = log().child({
    job: "admin.import.run",
    import_run_id: runId,
    tenant_id: job.tenantId,
  });
  if (busy) {
    // 9B review, finding 7: never throw to be retried — that spent one of pg-boss's retries per delivery, and a job
    // that ran out before any claim left the run `queued` for ever, holding the company's one live slot. A NEW job,
    // due after IMPORT_RUN_BUSY_RETRY_SECONDS with its own retry budget, comes back once this process is free (7A's
    // follow-up pattern). A failure to enqueue it throws, so pg-boss retries THIS delivery, which schedules it.
    await deferWhileBusy(sql, ctx, job, runId, logger);
    return;
  }
  busy = true;
  try {
    // 1. claim. Another tenant's run id finds no row under RLS (the JOB_PROBES entry); a FINISHED run is a no-op; a
    //    claim older than the lease belonged to a worker that died and is reclaimed.
    const claimed = await withTenant(sql, ctx, (tx) => claimImportRun(tx, runId));
    if (claimed === null) {
      const current = await withTenant(sql, ctx, (tx) => importRunLeaseState(tx, runId));
      if (current?.status === "running") {
        await deferPastLease(
          sql,
          ctx,
          "admin.import.run",
          job,
          current,
          importRunFollowUpOptions(runId, current),
          logger,
        );
        return;
      }
      logger.info({}, "import run is not queued; nothing to do");
      return;
    }
    if (claimed.status === "failed") {
      logger.error({ attempts: claimed.attempts }, "import run abandoned; failed");
      return;
    }
    await loadClaimed(sql, ctx, payload, claimed, logger);
  } finally {
    busy = false;
  }
};

async function deferWhileBusy(
  sql: Parameters<JobHandler<"admin.import.run">>[0],
  ctx: Parameters<JobHandler<"admin.import.run">>[2],
  job: Parameters<JobHandler<"admin.import.run">>[1],
  runId: string,
  logger: ReturnType<typeof log>,
): Promise<void> {
  const options = importRunBusyFollowUpOptions(runId);
  try {
    await withTenant(sql, ctx, (tx) =>
      jobs().enqueue(
        tx,
        "admin.import.run",
        { tenantId: job.tenantId, requestId: job.requestId, payload: job.payload },
        options,
      ),
    );
    logger.info(
      { start_after_seconds: options.startAfterSeconds },
      "a load is already running in this worker process; a follow-up delivery is scheduled",
    );
  } catch (error) {
    if (!(error instanceof JobNotInsertedError)) throw error;
    logger.info(
      {},
      "a load is already running in this worker process; its follow-up is already scheduled",
    );
  }
}

async function loadClaimed(
  sql: Parameters<JobHandler<"admin.import.run">>[0],
  ctx: Parameters<JobHandler<"admin.import.run">>[2],
  payload: Record<string, unknown>,
  run: ImportRunRow,
  logger: ReturnType<typeof log>,
): Promise<void> {
  const attempt = run.attempts;
  try {
    const field = disagreement(run, payload);
    if (field !== null)
      throw new RunRefused(
        `the admin.import.run payload disagrees with import run ${run.id} on ${field}; the run row is authoritative and nothing was loaded`,
      );
    // The deployment's ONE legacy source is bound to one tenant and company (LEGACY_IMPORT_TARGET, round 20 C19): a run
    // of any other is refused here, before the source is opened — whatever factory `runLoad` holds — and again by
    // `loadSourceFromEnv` before it connects. 9B review, finding 1.
    assertImportTarget({ tenantId: ctx.tenantId, companyId: run.companyId });
    // 9B review, finding 4 (ADR 0084 decision 22): the REQUESTER must still hold, company-wide, the write code of every
    // loader this run executes — the route asked when the run was requested; a role revoked or expired since is caught
    // here, before the source is opened. A registered loader with no row in IMPORT_LOADER_WRITE_CODES fails closed.
    const targets = run.only ?? loaders.map((l) => l.targetTable);
    const unmapped = unmappedImportTargets(
      targets.filter((t) => loaders.some((l) => l.targetTable === t)),
    );
    if (unmapped.length > 0)
      throw new RunRefused(
        `import run ${run.id} executes ${unmapped.join(", ")}, which no row of IMPORT_LOADER_WRITE_CODES gates; nothing was loaded`,
        "ERR_RBAC_FORBIDDEN",
      );
    const missing = await withTenant(sql, ctx, (tx) =>
      missingImportWriteCodes(tx, {
        principalId: run.requestedBy,
        companyId: run.companyId,
        only: run.only,
      }),
    );
    if (missing.length > 0)
      throw new RunRefused(
        `principal ${run.requestedBy}, who requested import run ${run.id}, no longer holds ${missing.join(", ")} company-wide in company ${run.companyId}; nothing was loaded`,
        "ERR_RBAC_FORBIDDEN",
      );
    // 2. the run's inputs, before the legacy source is opened — a forgotten map costs nothing (the CLI's rule).
    const reading = targets.filter((t) => ACCOUNT_MAP_TARGETS.includes(t));
    if (run.accountMap !== null)
      setAccountMap(assertAccountMap(run.accountMap, `import run ${run.id}`));
    else if (reading.length > 0)
      throw new RunRefused(
        `import run ${run.id} includes ${reading.join(", ")}, which read the OWNER's account map, and the request carried none; start it again with accountMap, or with only leaving ${ACCOUNT_MAP_TARGETS.join(", ")} out`,
      );
    // The worker's own HR ring (8D A12; refused at boot outside dev without HR_FIELD_ENCRYPTION_KEY), so an imported
    // employee's sealed fields open under the key the API and the rotation use.
    if (targets.some((t) => SENSITIVE_TARGETS.includes(t))) setKeyRing(hrKeyRing());

    // 3. load. The source is `runLoad`'s factory — `loadSourceFromEnv` (LEGACY_ODBC_DSN, round 20 C10, opened only for
    //    the company LEGACY_IMPORT_TARGET binds, C19) unless a test injected one with `setLoadSource`.
    const loadCtx: LoadContext = {
      ...ctx,
      companyId: run.companyId,
      runId: run.id,
      cutOverDate: run.cutOverDate,
      dryRun: run.dryRun,
      ...(run.only === null ? {} : { only: [...run.only] }),
      // 9B review, finding 5: before every page, renew this claim (throttled) — a load longer than the lease keeps it
      // while it makes progress, so a redelivery defers instead of reclaiming — and stop once it is no longer ours.
      heartbeat: async () => {
        const renewal = await withTenant(sql, ctx, (tx) =>
          renewImportRunLease(tx, run.id, attempt),
        );
        if (renewal === "superseded") throw new ClaimSuperseded(run.id, attempt);
      },
    };
    const report = await runLoad(sql, loadCtx);

    // 4. record, fenced by this claim's number.
    const recorded = await withTenant(sql, ctx, (tx) =>
      completeImportRun(tx, {
        id: run.id,
        perLoader: report.perLoader,
        skipCount: report.skips.length,
        artefactCount: report.artefacts.artefacts.length,
        attempt,
      }),
    );
    if (!recorded) {
      logger.warn({ attempt }, "import run claim superseded; its outcome was not recorded");
      return;
    }
    logger.info(
      {
        company_id: run.companyId,
        dry_run: run.dryRun,
        per_loader: report.perLoader,
        skips: report.skips.length,
        artefacts: report.artefacts.artefacts.length,
      },
      "import run finished",
    );
  } catch (error) {
    if (error instanceof ClaimSuperseded) {
      // Another claim holds the run (or it is settled): its outcome is that claim's to record, and a fail write here
      // would be fenced out anyway. Nothing of the next page was written.
      logger.warn(
        { attempt },
        "import run claim superseded; the load stopped before its next page",
      );
      return;
    }
    // The code travels as a field (`packages/importer` may not import AppError, §3.1); the worker is where it becomes
    // the run's legible failure. The DSN never reaches it: the driver's messages name tables and keys, and the artefact
    // header carries only `redactDsn`'s form.
    const detail = importFailureDetail(error);
    const recorded = await withTenant(sql, ctx, (tx) =>
      failImportRun(tx, { id: run.id, error: detail, attempt }),
    );
    logger.error(
      { company_id: run.companyId, code: detail.slice(0, detail.indexOf(":")), recorded },
      "import run failed",
    );
  } finally {
    clearAccountMap();
    clearKeyRing();
  }
}
