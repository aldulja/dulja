import { rebuildStockValuation, recordIntegrityIncident, withTenant } from "@dulja/db";
import { registerHandler, type JobHandler } from "../handler";
import { log } from "../log";

/**
 * `inventory.projection.rebuild` (§4.2.6, scheduled `0 3 * * *`, owner 3B) — the nightly rebuild-and-compare
 * of `app.stock_valuation`, which spec:1204 names an ASYNCHRONOUS projection and this job, not 1B's
 * `projectionChecks` registry, is responsible for (ADR 0039: a dated history is rebuilt by its job, current
 * state by the registry).
 *
 * The handler decides nothing. `rebuildStockValuation` pages through `valuationAsOf`, MERGEs the snapshot,
 * compares the QUANTITY half to `app.inventory_movement` and returns the mismatches plus the pairs it
 * excluded for an open authorised shortfall (ADR 0038 note 7). This file writes the incident and the log
 * line, and that is all it does.
 *
 * **Why neither `eachTenant` nor `systemContext` is imported above**, though Task 11's plan text sketches
 * both. `eachTenant` is the SCHEDULER's fan-out, not the handler's: 0D's boot loop
 * (`apps/worker/src/index.ts`) installs a `<name>.fanout` cron for every job whose `JOBS` schedule is
 * non-null, and that cron walks `eachTenant` and calls `runJob` once per tenant, which resolves the
 * tenant's system principal (spec:2179, hazard 20) and hands it here as `ctx`. A second `eachTenant` inside
 * the handler would rebuild every tenant once per tenant. 3A's `inventory.lot.expiry_warning` — the other
 * scheduled job in this slice's neighbourhood — records the same reasoning at the same place. This
 * handler's own fan-out is over COMPANIES, a different axis, done with the `select id from app.company`
 * below.
 *
 * One company per `withTenant` transaction (spec:1368): a tenant with two hundred companies must not hold
 * one transaction, nor the per-tenant audit lock, for the whole nightly run.
 */
export function createProjectionRebuildHandler(): JobHandler<"inventory.projection.rebuild"> {
  return async (sql, job, ctx) => {
    const asOf = job.payload.asOf ?? new Date().toISOString().slice(0, 10);

    const companies = await withTenant(sql, ctx, (tx) =>
      job.payload.companyId === undefined
        ? tx<{ id: string }[]>`select id::text as id from app.company order by code`
        : Promise.resolve([{ id: job.payload.companyId }]),
    );

    for (const company of companies) {
      const result = await withTenant(sql, ctx, (tx) =>
        rebuildStockValuation(tx, { companyId: company.id, asOf }),
      );

      if (result.mismatches.length > 0) {
        // 1B's `recordIntegrityIncident` takes a whole `IntegrityReport`: its body writes `report.requestId`
        // into the audit row and the report itself into the row's payload, so the mismatches land in the
        // tamper-evident chain rather than only in a sentence. This run checked exactly one projection and
        // walked no chain, so `projections` carries the real result and every other member is its empty
        // value.
        await withTenant(sql, ctx, (tx) =>
          recordIntegrityIncident(tx, {
            tenantId: ctx.tenantId,
            requestId: ctx.requestId,
            checkedAt: new Date().toISOString(),
            ledgerBalance: { byPeriod: [], byDocument: [] },
            projections: { checked: ["stock_valuation"], mismatches: result.mismatches },
            auditChain: { rows: 0, brokenLinks: 0, badHashes: 0, firstBrokenSeq: null },
            periodReopens: [],
            ok: false,
            summary: `FAILED: stock_valuation rebuild of company ${company.id} found ${result.mismatches.length} quantity mismatch(es) as at ${asOf}: ${result.mismatches.map((m) => m.detail).join("; ")}`,
          }),
        );
      }

      // `Logger.info` is `(fields, message)` — the message is the SECOND argument, and
      // `forbidden-log-fields` polices what may go in `fields`. The excluded pairs are logged by NAME, so an
      // authorised shortfall is visible every night without being an alarm (ADR 0039 decision 3).
      log().info(
        {
          job: "inventory.projection.rebuild",
          tenant_id: ctx.tenantId,
          company_id: company.id,
          as_of: asOf,
          rows_written: result.rowsWritten,
          mismatches: result.mismatches.length,
          excluded: result.excluded.map((pair) => `${pair.itemId}/${pair.warehouseId}`),
        },
        result.mismatches.length > 0
          ? "stock valuation rebuilt with mismatches"
          : "stock valuation rebuilt",
      );
    }
  };
}

/**
 * Registered through an exported function rather than a module-level side effect plus a bare
 * `import "./handlers/inventory-projection-rebuild"`, which is the shape Task 11 Step 4 sketches and which
 * cannot work in this tree: `startWorker()` calls `resetHandlers()` and then re-registers, so an import-time
 * side effect is cleared and never restored, and `tests/invariants/job-isolation.test.ts` asserts
 * `registeredJobNames()` contains every `JOB_PROBES` key. `registerCostingHandlers`,
 * `registerInventoryHandlers` and `registerAccountingHandlers` all have this shape already.
 */
export function registerProjectionRebuildHandlers(): void {
  registerHandler("inventory.projection.rebuild", createProjectionRebuildHandler());
}
