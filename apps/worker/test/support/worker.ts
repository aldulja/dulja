import { cashierCompare } from "../../src/jobs/cashier-compare";
import { registerPosSyncHandlers } from "../../src/handlers/pos-sync-apply";
import { registerDefaultTransmitters, resetTransmitters } from "@dulja/db";
import { setJobs } from "../../src/jobs";
import { accountingTaxSubmit } from "../../src/handlers/accounting-tax-submit";
import type { PgBoss } from "pg-boss";
import {
  createHrKeyRing,
  createJobClient,
  DEV_HR_KEY,
  JOBS,
  type JobClient,
  type JobEnvelope,
  type JobName,
  type JobPayload,
} from "@dulja/db";
import { installBoss, startDb, stopBoss, type Db } from "@dulja/db/test";
import type { LogFields, Logger } from "@dulja/contracts";
import { registerHandler, resetHandlers, runJob } from "../../src/handler";
import { setLogger } from "../../src/log";
import { registerAccountingHandlers } from "../../src/handlers/accounting";
import { registerCostingHandlers } from "../../src/handlers/cost-replay";
import { registerInventoryHandlers } from "../../src/handlers/inventory";
import { registerProjectionRebuildHandlers } from "../../src/handlers/inventory-projection-rebuild";
import { registerAccountingProjectionRebuildHandlers } from "../../src/handlers/accounting-projection-rebuild";
import { createIncidentReporter } from "../../src/observability/incident";
import { idempotencyKeyPurge } from "../../src/jobs/idempotency-key-purge";
import { reportRender } from "../../src/jobs/report-render";
import { exportRun } from "../../src/jobs/export-run";
import { registerRateTableLapse } from "../../src/jobs/rate-table-lapse";
import { registerEmployeeYtdRebuild } from "../../src/jobs/employee-ytd-rebuild";
import { registerHrKeyRotate } from "../../src/jobs/hr-key-rotate";
import { setHrKeyRing } from "../../src/hr-keys";
import { importRunHandler } from "../../src/handlers/import-run";

export interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  fields: LogFields;
  msg: string;
}
export interface StartedWorker {
  db: Db;
  boss: PgBoss;
  jobs: JobClient;
  logs: CapturedLog[];
  run<N extends JobName>(name: N, job: JobEnvelope<JobPayload[N]>): Promise<void>;
  stop(): Promise<void>;
}
function capture(sink: CapturedLog[], base: LogFields = {}): Logger {
  const at = (level: CapturedLog["level"]) => (fields: LogFields, msg: string) => {
    sink.push({ level, fields: { ...base, ...fields }, msg });
  };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (fields) => capture(sink, { ...base, ...fields }),
  };
}
export async function startWorker(): Promise<StartedWorker> {
  const db = await startDb();
  const boss = await installBoss(db, Object.keys(JOBS));
  const logs: CapturedLog[] = [];
  const logger = capture(logs);
  setLogger(logger);
  resetHandlers();
  resetTransmitters();
  registerDefaultTransmitters("dev");
  setJobs(createJobClient(boss));
  registerHandler("accounting.tax.submit", accountingTaxSubmit);
  registerHandler("pos.cashier.compare", cashierCompare);
  registerPosSyncHandlers();
  // The SAME registration production performs in apps/worker/src/index.ts, so what the isolation invariant
  // and the handler tests drive is the code that ships — not a scaffold that nothing else registers.
  registerAccountingHandlers({ logger, incident: createIncidentReporter(logger) });
  registerInventoryHandlers();
  registerCostingHandlers();
  registerProjectionRebuildHandlers();
  registerAccountingProjectionRebuildHandlers();
  registerHandler("admin.idempotency_key.purge", idempotencyKeyPurge);
  registerHandler("reporting.render", reportRender);
  registerHandler("admin.export.run", exportRun);
  registerRateTableLapse();
  registerEmployeeYtdRebuild();
  // 8D — the dev ring production composes when APP_ENV=dev, so a worker test that does not care about keys boots;
  // a test that rotates replaces it with setHrKeyRing before it runs the job.
  setHrKeyRing(createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 }));
  registerHrKeyRotate();
  // 9B — the cut-over load; a test injects its legacy source with @dulja/importer's setLoadSource.
  registerHandler("admin.import.run", importRunHandler);
  return {
    db,
    boss,
    jobs: createJobClient(boss),
    logs,
    run: (name, job) => runJob(db.rw, name, job),
    async stop() {
      await stopBoss(boss);
      await db.stop();
    },
  };
}
