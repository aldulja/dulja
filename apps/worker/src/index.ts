import { cashierCompare } from "./jobs/cashier-compare";
import { reportRender } from "./jobs/report-render";
import { exportRun } from "./jobs/export-run";
import { registerRateTableLapse } from "./jobs/rate-table-lapse";
import { registerEmployeeYtdRebuild } from "./jobs/employee-ytd-rebuild";
import { registerHrKeyRotate } from "./jobs/hr-key-rotate";
import { hrKeyRingFromEnv, setHrKeyRing } from "./hr-keys";
import { objectStoreFromEnv, setObjectStore } from "./object-store";
import { registerPosSyncHandlers } from "./handlers/pos-sync-apply";
import { importRunHandler } from "./handlers/import-run";
import { v7 as newUuidV7 } from "uuid";
import {
  createDb,
  createJobClient,
  registerDefaultTransmitters,
  eachTenant,
  JOBS,
  type JobEnvelope,
  type JobName,
  type JobPayload,
} from "@dulja/db";
import { parseAppEnv, type AppEnv } from "./app-env";
import { setJobs } from "./jobs";
import { accountingTaxSubmit } from "./handlers/accounting-tax-submit";
import { createBoss } from "./boss";
import { registerHandler, registeredJobNames, runJob } from "./handler";
import { log } from "./log";
import { idempotencyKeyPurge } from "./jobs/idempotency-key-purge";
import { createIncidentReporter } from "./observability/incident";
import { registerAccountingHandlers } from "./handlers/accounting";
import { registerCostingHandlers } from "./handlers/cost-replay";
import { registerInventoryHandlers } from "./handlers/inventory";
import { registerProjectionRebuildHandlers } from "./handlers/inventory-projection-rebuild";
import { registerAccountingProjectionRebuildHandlers } from "./handlers/accounting-projection-rebuild";
import { startWorkerHealth } from "./health";
import { startTelemetry } from "./otel";
import { startSentry } from "./sentry";

const url = process.env["DATABASE_URL"];
if (!url) {
  process.stderr.write("DATABASE_URL is not set\n");
  process.exit(2);
}
// Before any handler or transmitter is registered, and the one value every later use reads: an unknown
// APP_ENV used to fall back to "dev" and register the synthetic transmitter (ADR 0052 decision 6). The
// API refuses it at boot (apps/api/src/config.ts), and so does the worker now.
let appEnv: AppEnv;
try {
  appEnv = parseAppEnv(process.env);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(2);
}
// 7A — the store `reporting.render` writes rendered reports into. Built before any handler is registered and
// refused at boot on a partial R2 configuration (§3.11), so a misconfigured worker never starts accepting
// renders it cannot store.
try {
  setObjectStore(objectStoreFromEnv(process.env, appEnv));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(2);
}
// 8D (A12) — the HR key ring hr.encryption_key.rotate re-seals under, composed ONCE here from §3.11's three names and
// refused at boot like the object store: outside dev a worker without HR_FIELD_ENCRYPTION_KEY, or with a version that
// cannot pair with its previous key, must not start re-sealing under the wrong one (ADR 0080).
try {
  setHrKeyRing(hrKeyRingFromEnv(process.env, appEnv));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(2);
}
const sql = createDb(url);
const logger = log();
const boss = createBoss(url, (error) => logger.error({ err: String(error) }, "pg-boss error"));
// 1B replaces 0D's scaffold with the full check. Registration happens here, before boss.start(), because
// the loop below installs the worker and the cron fan-out for whatever is registered by then; nothing in
// handlers/accounting.ts schedules, and a second boss.schedule on the bare name would queue a tenant-less
// envelope runJob cannot resolve.
registerAccountingHandlers({ logger, incident: createIncidentReporter(logger) });
registerInventoryHandlers();
// 3B — inventory.cost.replay. Registered here, before boss.start(), like every other handler; its JOBS
// schedule is null, so the loop below installs a worker for it and no cron fan-out (ADR 0038).
registerCostingHandlers();
// 3B — inventory.projection.rebuild. Its JOBS schedule is "0 3 * * *", so the loop below installs both a
// worker and the cron fan-out for it; the handler itself never calls eachTenant (ADR 0039).
registerProjectionRebuildHandlers();
// 4B — accounting.projection.rebuild, the party_ageing snapshot's rebuild-and-compare. Its JOBS schedule is
// "0 3 * * *", so the loop below installs a worker and the cron fan-out; the handler never calls eachTenant.
registerAccountingProjectionRebuildHandlers();
setJobs(createJobClient(boss));
// Never throws: a profile version that cannot be loaded is left unregistered — a submission to it is
// refused ERR_EINVOICE_TRANSMITTER_UNAVAILABLE — and reported here, so every other job still runs.
for (const { code, version, reason } of registerDefaultTransmitters(appEnv).skipped)
  logger.warn(
    { transmitter: code, profileVersion: version ?? null, reason },
    "e-invoice transmitter not registered",
  );
registerHandler("accounting.tax.submit", accountingTaxSubmit);
registerHandler("pos.cashier.compare", cashierCompare);
registerPosSyncHandlers();
registerHandler("admin.idempotency_key.purge", idempotencyKeyPurge);
// 7A — reporting.render. Its JOBS schedule is null: the API enqueues one per report run.
registerHandler("reporting.render", reportRender);
// 7C — admin.export.run. Its JOBS schedule is null: the API enqueues one per export request.
registerHandler("admin.export.run", exportRun);
// 8A — hr.rate_table.lapse_warning. Its JOBS schedule is "0 7 * * *", so the loop below installs a worker and the
// cron fan-out (eachTenant); the handler itself never calls eachTenant.
registerRateTableLapse();
// 8C — hr.employee_ytd.rebuild. Its JOBS schedule is "0 4 * * *", so the loop below installs a worker and the cron
// fan-out (eachTenant); the handler itself never calls eachTenant. It reports drift and repairs nothing.
registerEmployeeYtdRebuild();
// 8D — hr.encryption_key.rotate. Its JOBS schedule is null: an operator enqueues it per tenant after a key change
// (docs/runbooks/hr-key-rotation.md), so the loop below installs a worker and no cron fan-out.
registerHrKeyRotate();
// 9B — admin.import.run. Its JOBS schedule is null: the API enqueues one per import run. The legacy source is
// runLoad's own default factory, loadSourceFromEnv (LEGACY_ODBC_DSN, round 20 C10 — the worker container alone),
// opened only for the company LEGACY_IMPORT_TARGET binds (C19).
registerHandler("admin.import.run", importRunHandler);
startTelemetry({ serviceName: "dulja-worker", appEnv });
startSentry({ appEnv, serviceName: "dulja-worker" });
await boss.start();
for (const name of registeredJobNames()) {
  await boss.work(name, async ([job]: { data: JobEnvelope<JobPayload[JobName]> }[]) => {
    await runJob(sql, name, job!.data);
  });
  const schedule = JOBS[name].schedule;
  if (schedule === null) continue;
  await boss.schedule(`${name}.fanout`, schedule, {}, {});
  await boss.work(`${name}.fanout`, async () => {
    await eachTenant(sql, async (tenantId) => {
      await runJob(sql, name, { tenantId, requestId: newUuidV7(), payload: {} } as JobEnvelope<
        JobPayload[JobName]
      >);
    });
  });
}
log().info({ jobs: registeredJobNames() }, "worker started");
startWorkerHealth(registeredJobNames);

// Shutdown: let running jobs finish and close both pools before exiting. A listener on a signal replaces the
// default exit, so the handler exits itself — once, whichever signal comes first.
const shutdown = (signal: string): void => {
  logger.info({ signal }, "worker stopping");
  boss
    .stop({ graceful: true })
    .then(() => sql.end())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: String(error) }, "worker did not stop cleanly");
        process.exit(1);
      },
    );
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
