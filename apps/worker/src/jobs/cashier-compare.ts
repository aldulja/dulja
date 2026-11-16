// One static import for both names. There is no cycle here — `apps/worker` depends on `@dulja/db` and
// `@dulja/db` depends on nothing in this direction — so the dynamic `await import("@dulja/db")` an earlier
// draft used inside the handler bought nothing and hid the dependency from the module graph the
// `dependency-rule` lint walks. Every other module in this slice imports statically; so does this one.
import { findSnapshotDrift, withTenant } from "@dulja/db";
import type { JobHandler } from "../handler";
import { log } from "../log";

/**
 * D14's nightly comparison for `pos_cashier.snapshot` (spec:1324, ADR 0061). It REPORTS and does not
 * repair: a silent repair would hide the trigger fault the comparison exists to find. One audit row per
 * differing cashier, under the sentinel `table_name = 'cashier_snapshot_drift'` (§4.2.6, amendment A6).
 */
export const cashierCompare: JobHandler<"pos.cashier.compare"> = async (sql, job, ctx) => {
  const drift = await withTenant(sql, ctx, (tx) =>
    findSnapshotDrift(tx, job.payload.companyId ? { companyId: job.payload.companyId } : {}),
  );
  if (drift.length === 0) {
    log().info({ tenant_id: ctx.tenantId, checked: "pos_cashier" }, "cashier snapshots agree");
    return;
  }
  await withTenant(sql, ctx, async (tx) => {
    for (const d of drift) {
      await tx`select app.record_cashier_snapshot_drift(${d.principalId},
        ${JSON.stringify(d.stored)}::text::jsonb,${JSON.stringify(d.fresh)}::text::jsonb)`;
    }
  });
  log().warn(
    { tenant_id: ctx.tenantId, drifted: drift.length, principals: drift.map((d) => d.principalId) },
    "cashier snapshot drift — the refresh trigger did not fire for these cashiers",
  );
};
