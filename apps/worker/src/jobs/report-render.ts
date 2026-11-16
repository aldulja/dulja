import { createHash } from "node:crypto";
import {
  claimReportRun,
  completeReportRun,
  failReportRun,
  loadRunDefinition,
  reportDisplayParameters,
  reportObjectKeyFor,
  reportRunFollowUpOptions,
  reportRunLeaseState,
  rowsForDefinition,
  withTenant,
} from "@dulja/db";
import { parseReportDefinition, renderReport } from "@dulja/domain";
import type { JobHandler } from "../handler";
import { log } from "../log";
import { failureDetail } from "./failure";
import { deferPastLease } from "./lease";
import { objectStore } from "../object-store";
import { i18nFormatters } from "../reports/formatters";
import { REPORT_EXTENSION, rendererFor } from "../reports/renderers";

/** The row ceiling one run reads: the registry's own `MAX_DATASET_ROWS` default, stated where it is used. A run
 *  whose rows would exceed it FAILS with `ERR_VALIDATION_FAILED` ("narrow the parameters") — `rowsForDefinition`
 *  reads one row past its cap and refuses, so no partial report is ever rendered (Phase 7 review, finding 3). */
const RUN_ROW_LIMIT = 100_000;

/**
 * The `reporting.render` job (contracts §4.11.2, ADR 0066/0067). Three short transactions, never one long one
 * (hazard 20, spec:1368): a render drives a PDF engine and must not hold a transaction open across it. `ctx` is
 * the tenant's SYSTEM principal — `runJob` built it with `systemContext` — so every status move is audited
 * under the system principal.
 */
export const reportRender: JobHandler<"reporting.render"> = async (sql, job, ctx) => {
  const { runId } = job.payload;
  const logger = log().child({ job: "reporting.render", run_id: runId, tenant_id: job.tenantId });

  // 1. claim. A pg-boss re-delivery of a FINISHED job finds a settled row and returns — the idempotency story,
  //    with no flag and no advisory lock. Another tenant's run id finds no row at all: RLS hides it, so the
  //    claim is a no-op there too (the JOB_PROBES entry). A run whose claim outlived REPORT_RUN_LEASE_SECONDS
  //    belonged to a worker that died, and is reclaimed (Phase 7 review, finding 2).
  const claimed = await withTenant(sql, ctx, (tx) => claimReportRun(tx, runId));
  if (claimed === null) {
    const current = await withTenant(sql, ctx, (tx) => reportRunLeaseState(tx, runId));
    if (current?.status === "running") {
      // A LIVE claim — a duplicate delivery, or this delivery's predecessor threw after claiming (its failure
      // write failed). Completing the job here would leave the run `running` with no job left to finish it, and
      // THROWING spent a pg-boss retry per delivery, which ran out before the lease lapsed (second review,
      // finding 1). So the claim's one follow-up delivery is scheduled after its lease, and this one returns.
      await deferPastLease(
        sql,
        ctx,
        "reporting.render",
        job,
        current,
        reportRunFollowUpOptions(runId, current),
        logger,
      );
      return;
    }
    logger.info({}, "report run is not queued; nothing to do");
    return;
  }
  if (claimed.status === "failed") {
    // The claim itself failed the run: REPORT_RUN_MAX_CLAIMS workers claimed it and none finished.
    logger.error({ attempts: claimed.attempts }, "report run abandoned; failed");
    return;
  }
  const attempt = claimed.attempts;

  try {
    // 2. load and read. Stored definitions were validated when written, and this is a schema parse — but the
    //    GATE is re-checked before any row is read (second review, finding 8): `rowsForDefinition` runs
    //    `assertDatasetGate`, so a definition written before a gate rule existed, or by a path that bypassed
    //    the store, fails the run (ERR_VALIDATION_FAILED, `/permission`) instead of reading under a wider gate.
    //    `rowsForDefinition` (Task 9) is the ONE row provider — it dispatches a STATEMENT_CODES
    //    key to `statementRows` and every other code to `datasetFor(source).run` — so this handler never
    //    calls `datasetFor` itself; a second dispatch here is how the two paths would drift.
    //    The run's language reaches the row provider because a statement's section heading is a row field
    //    (`section_label`); the header's parameters are the PRINTED ones — a fiscal period as its `YYYY-MM`
    //    code, never its uuid (`reportDisplayParameters`). The rows were read with the raw values.
    const { loaded, definition, rows, shown } = await withTenant(sql, ctx, async (tx) => {
      const found = await loadRunDefinition(tx, runId);
      if (found === null) throw new Error(`report run ${runId} vanished between claim and load`);
      const parsed = parseReportDefinition(found.definition);
      const read = await rowsForDefinition(tx, parsed, {
        companyId: found.run.companyId,
        parameters: found.run.parameters,
        limit: RUN_ROW_LIMIT,
        lang: found.run.lang,
      });
      const display = await reportDisplayParameters(tx, parsed, {
        companyId: found.run.companyId,
        parameters: found.run.parameters,
      });
      return { loaded: found, definition: parsed, rows: read, shown: display };
    });

    // 3. render — pure, outside any transaction. The company's base currency, never a sniff of the rows: a
    //    dataset with no `currency` column would otherwise render every amount as `XXX 1,234.50`.
    const rendered = renderReport(definition, rows, {
      format: loaded.run.format,
      lang: loaded.run.lang,
      formatters: i18nFormatters(loaded.run.lang, { currency: loaded.baseCurrency }),
      parameters: shown,
    });
    const artefact = await rendererFor(loaded.run.format).render(rendered);

    // 4. store, then record. The object goes first: a run marked `done` whose object is missing would be a
    //    lie the CHECK cannot catch, whereas an orphan object is harmless. The key is THIS claim's own
    //    (second review, finding 2): a superseded worker that wakes up writes beside its successor's object,
    //    never over it, and the row names only the object its completing claim stored. A completion the fence
    //    refuses means this claim was superseded — the object it just stored is nobody's, and is deleted.
    const store = objectStore();
    const objectKey = reportObjectKeyFor(
      job.tenantId,
      runId,
      REPORT_EXTENSION[loaded.run.format],
      attempt,
    );
    await store.put(objectKey, artefact.bytes, artefact.contentType);
    const sha256 = new Uint8Array(createHash("sha256").update(artefact.bytes).digest());
    const recorded = await withTenant(sql, ctx, (tx) =>
      completeReportRun(tx, { runId, objectKey, sha256, attempt }),
    );
    if (!recorded) {
      await store.delete(objectKey);
      logger.warn({ attempt }, "report run claim superseded; its artefact was discarded");
      return;
    }
    logger.info({ rows: rendered.rowCount, bytes: artefact.bytes.byteLength }, "report rendered");
  } catch (error) {
    // The RUN fails, not the job: a waiting user needs the reason on the status resource, and a thrown error
    // would only be retried and then lost. The message carries the code so the API can echo it.
    const detail = failureDetail(error);
    await withTenant(sql, ctx, (tx) => failReportRun(tx, { runId, error: detail, attempt }));
    logger.error({ detail }, "report render failed");
  }
};
