import {
  claimExportJob,
  completeExportJob,
  exportJobFollowUpOptions,
  exportJobLeaseState,
  exportObjectKeyFor,
  failExportJob,
  runExport,
  withTenant,
} from "@dulja/db";
import type { JobHandler } from "../handler";
import { log } from "../log";
import { failureDetail } from "./failure";
import { deferPastLease } from "./lease";
import { objectStore } from "../object-store";

/**
 * spec:2206's asynchronous tenant export (contracts §4.2.6 as amended by 7C A10). Short transactions, never
 * one long one across the object store: claim, read, store, record. `ctx` is the tenant's SYSTEM principal —
 * `runJob` built it with `systemContext` (hazard 20) — which holds every code, so the archive is built from
 * the gates the ROUTE recorded on the row (`requested_by`, `readable_modules`, `lot_attachments`) and never
 * from the job's own authority (ADR 0070).
 */
export const exportRun: JobHandler<"admin.export.run"> = async (sql, job, ctx) => {
  const { exportJobId } = job.payload;
  const logger = log().child({
    job: "admin.export.run",
    export_job_id: exportJobId,
    tenant_id: job.tenantId,
  });

  // 1. claim. A pg-boss re-delivery of a FINISHED job is a no-op rather than a second archive, and another
  //    tenant's id finds no row at all under RLS (the JOB_PROBES entry). A claim older than
  //    EXPORT_JOB_LEASE_SECONDS belonged to a worker that died, and is reclaimed (Phase 7 review, finding 2).
  const claimed = await withTenant(sql, ctx, (tx) => claimExportJob(tx, exportJobId));
  if (claimed === null) {
    const current = await withTenant(sql, ctx, (tx) => exportJobLeaseState(tx, exportJobId));
    if (current?.status === "running") {
      // A LIVE claim: schedule the claim's one follow-up delivery after its lease and return — never a throw,
      // whose retries ran out long before an hour's lease lapsed (second review, finding 1; the rule
      // `reporting.render` follows).
      await deferPastLease(
        sql,
        ctx,
        "admin.export.run",
        job,
        current,
        exportJobFollowUpOptions(exportJobId, current),
        logger,
      );
      return;
    }
    logger.info({}, "export job is not queued; nothing to do");
    return;
  }
  if (claimed.status === "failed") {
    logger.error({ attempts: claimed.attempts }, "export job abandoned; failed");
    return;
  }
  const attempt = claimed.attempts;

  try {
    // 2. read and build. `generatedAt` is the claim's own timestamp, not a second clock read, so the job's
    //    archive is reproducible from its row: running the same job over the same state gives the same bytes.
    //    `runExport` opens its ONE read transaction through the runner it is handed and fetches the attachment
    //    bytes after that has committed — never an object-store round-trip inside a transaction (hazard 20).
    const store = objectStore();
    const result = await runExport((fn) => withTenant(sql, ctx, fn), store, {
      job: claimed,
      tenantId: job.tenantId,
      generatedAt: claimed.startedAt ?? new Date().toISOString(),
    });

    // 3. store, then record: a `done` row always names bytes that exist. The key is THIS claim's own (second
    //    review, finding 2), so a superseded worker never overwrites the archive whose digest its successor
    //    recorded; a completion the fence refuses deletes the object this claim stored.
    const objectKey = exportObjectKeyFor(job.tenantId, exportJobId, attempt);
    await store.put(objectKey, result.bytes, "application/gzip");
    const recorded = await withTenant(sql, ctx, (tx) =>
      completeExportJob(tx, {
        id: exportJobId,
        objectKey,
        sha256: result.sha256,
        byteSize: result.bytes.byteLength,
        tableCount: result.tableCount,
        rowCount: result.rowCount,
        manifest: result.manifest,
        attempt,
      }),
    );
    if (!recorded) {
      await store.delete(objectKey);
      logger.warn({ attempt }, "export job claim superseded; its archive was discarded");
      return;
    }
    logger.info(
      {
        table_count: result.tableCount,
        row_count: result.rowCount,
        byte_size: result.bytes.byteLength,
      },
      "export job done",
    );
  } catch (error) {
    // The EXPORT fails, not the job: a waiting user needs the reason on the status resource, and a retry
    // would find the row no longer queued and do nothing (the same choice `reporting.render` makes).
    const detail = failureDetail(error);
    await withTenant(sql, ctx, (tx) =>
      failExportJob(tx, { id: exportJobId, error: detail, attempt }),
    );
    logger.error({ detail }, "export job failed");
  }
};
