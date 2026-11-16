import { checkEmployeeYtdProjection, withTenant } from "@dulja/db";
import { registerHandler, registeredJobNames, type JobHandler } from "../handler";
import { log } from "../log";

/** The audit `table_name` sentinel this job writes on drift (§4.2.6, contracts round 18 B2), admitted to
 *  `app.record_system_event`'s closed list by tail migration 0121. */
export const EMPLOYEE_YTD_DRIFT_SENTINEL = "employee_ytd_drift";

/**
 * `hr.employee_ytd.rebuild` (§4.2.6, scheduled `0 4 * * *`; spec:2084 / D14): rebuild `app.employee_ytd` from every
 * posted run and COMPARE. It **reports drift and repairs nothing** — 6C's `pos.cashier.compare` precedent: a silent
 * repair hides the bug that caused the drift, and finding it is the whole point (spec:98 forbids the write anyway —
 * only the posting service may touch the table).
 *
 * It calls the SAME `checkEmployeeYtdProjection` that `EMPLOYEE_YTD_CHECK` registers with 1B's nightly integrity job.
 * Two compares, one implementation; this one narrows to the payload's company and year in SQL and writes ONE sentinel
 * row naming every mismatch, so an `employee_ytd` drift is visible even in a tenant whose integrity run is otherwise
 * green. A clean tenant writes nothing.
 *
 * Runs as the tenant's system principal (hazard 20): `runJob` hands it `systemContext`, and the `eachTenant` fan-out
 * lives in `apps/worker/src/index.ts`. The sentinel goes through `app.record_system_event`, the system's only door
 * into `app.audit_log` (0105; 0001 §8 refuses app_rw a direct insert).
 */
export const employeeYtdRebuildHandler: JobHandler<"hr.employee_ytd.rebuild"> = async (
  sql,
  job,
  ctx,
) => {
  const companyId = job.payload.companyId;
  const year = job.payload.year;
  const mismatches = await withTenant(sql, ctx, (tx) =>
    checkEmployeeYtdProjection(tx, { companyId, year }),
  );
  if (mismatches.length === 0) {
    log().info(
      {
        tenant_id: ctx.tenantId,
        request_id: ctx.requestId,
        checked: "employee_ytd",
        mismatches: 0,
      },
      "employee_ytd matches its rebuild",
    );
    return;
  }
  await withTenant(
    sql,
    ctx,
    (tx) => tx`
      select app.record_system_event(${EMPLOYEE_YTD_DRIFT_SENTINEL}, ${ctx.requestId},
              ${JSON.stringify({ companyId: companyId ?? null, year: year ?? null, mismatches })}::text::jsonb)`,
  );
  log().error(
    { tenant_id: ctx.tenantId, request_id: ctx.requestId, mismatches: mismatches.length },
    "employee_ytd drifted from its rebuild",
  );
};

/** Idempotent: `registerHandler` throws on a second registration, and a test that starts a worker (which registers
 *  every shipped handler) may call this again. */
export function registerEmployeeYtdRebuild(): void {
  if (registeredJobNames().includes("hr.employee_ytd.rebuild")) return;
  registerHandler("hr.employee_ytd.rebuild", employeeYtdRebuildHandler);
}
