import { lapsingTables, withTenant } from "@dulja/db";
import { registerHandler, registeredJobNames, type JobHandler } from "../handler";
import { log } from "../log";

/** spec:2109: "a scheduled job that warns sixty days before a table lapses". The literal lives here once; the
 *  payload may override it for an operator running the job by hand. */
export const LAPSE_HORIZON_DAYS = 60;
/** 8A's audit `table_name` sentinel (§4.2.6, contracts round 16 A10), admitted by migration 0120. */
export const LAPSE_AUDIT_TABLE = "rate_table_lapse_warning";

export interface LapseWarning {
  schemeCode: string;
  version: number;
  effectiveTo: string;
  daysRemaining: number;
}

const DAY_MS = 86_400_000;

/**
 * `hr.rate_table.lapse_warning` (§4.2.6, scheduled `0 7 * * *`). Runs as the tenant's system principal (hazard 20):
 * `runJob` hands it the tenant's `systemContext`, and the scheduler's `eachTenant` fan-out lives in
 * `apps/worker/src/index.ts`, so neither is imported here. One short read transaction, then — only when something is
 * lapsing — one log line per table and ONE audit row through `app.record_system_event`, the system's only door into
 * `app.audit_log` (0105). A quiet tenant writes nothing.
 */
export const rateTableLapseHandler: JobHandler<"hr.rate_table.lapse_warning"> = async (
  sql,
  job,
  ctx,
) => {
  const asOf = job.payload.asOf ?? new Date().toISOString().slice(0, 10);
  const horizonDays = job.payload.horizonDays ?? LAPSE_HORIZON_DAYS;
  const companyId = job.payload.companyId;
  const rows = await withTenant(sql, ctx, (tx) =>
    lapsingTables(tx, asOf, horizonDays, companyId === undefined ? {} : { companyId }),
  );
  if (rows.length === 0) return;
  const warnings: LapseWarning[] = rows.map((t) => ({
    schemeCode: t.schemeCode,
    version: t.version,
    effectiveTo: t.effectiveTo!,
    daysRemaining: Math.round((Date.parse(t.effectiveTo!) - Date.parse(asOf)) / DAY_MS),
  }));
  for (const w of warnings) {
    log().warn(
      {
        scheme: w.schemeCode,
        version: w.version,
        effective_to: w.effectiveTo,
        days_remaining: w.daysRemaining,
      },
      "rate table lapsing",
    );
  }
  await withTenant(
    sql,
    ctx,
    (tx) => tx`
    select app.record_system_event(${LAPSE_AUDIT_TABLE}, ${ctx.requestId},
            ${JSON.stringify({ asOf, horizonDays, companyId: companyId ?? null, warnings })}::text::jsonb)`,
  );
};

/** Idempotent: `registerHandler` throws on a second registration, and a test that starts a worker (which registers
 *  every shipped handler) may call this again. */
export function registerRateTableLapse(): void {
  if (registeredJobNames().includes("hr.rate_table.lapse_warning")) return;
  registerHandler("hr.rate_table.lapse_warning", rateTableLapseHandler);
}
