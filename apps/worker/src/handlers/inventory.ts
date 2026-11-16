import { listNearExpiryLots, recordExpiryWarning, withTenant } from "@dulja/db";
import { registerHandler, type JobHandler } from "../handler";
import { log } from "../log";

/**
 * `inventory.lot.expiry_warning` (§4.2.6, scheduled `0 6 * * *`) — the "near-expiry alerts" half of
 * spec:1022. Runs as the tenant's system principal (hazard 20) in short transactions, one per company.
 *
 * It warns and audits; it posts nothing and writes no `app.needs_attention` row (that table is 6A's). When
 * 6A lands, its handler is the natural consumer of `listNearExpiryLots` — this file changes then, not now.
 *
 * **Why neither `eachTenant` nor `systemContext` is imported above**, though a reader of §4.2.6 would expect
 * both. `eachTenant` is the *scheduler's* fan-out: `runJob` resolves one tenant's `systemContext` per
 * envelope and the scheduler enqueues one envelope per tenant, so by the time this handler runs the tenant
 * is settled and arrives as `ctx`, the third parameter. This handler's own fan-out is over **companies**, a
 * different axis, done with the `select id from app.company` below.
 */
export function createExpiryWarningHandler(): JobHandler<"inventory.lot.expiry_warning"> {
  return async (sql, job, ctx) => {
    const companies = await withTenant(sql, ctx, (tx) =>
      job.payload.companyId !== undefined
        ? Promise.resolve([{ id: job.payload.companyId }])
        : tx<{ id: string }[]>`select id from app.company order by id`,
    );

    for (const company of companies) {
      // One short transaction per company (spec:1368), so one company's failure cannot roll back another's
      // audit row and a long-running tenant cannot hold a snapshot open for the rest.
      await withTenant(sql, ctx, async (tx) => {
        const lots = await listNearExpiryLots(tx, {
          companyId: company.id,
          ...(job.payload.horizonDays === undefined
            ? {}
            : { horizonDays: job.payload.horizonDays }),
        });
        for (const lot of lots) {
          // `Logger.warn` is `(fields, message)` — the message is the SECOND argument, not a `msg` field
          // (0D's `packages/contracts` Logger; `forbidden-log-fields` also polices what may go in `fields`).
          log().warn(
            {
              company_id: lot.companyId,
              item_code: lot.itemCode,
              lot_code: lot.lotCode,
              warehouse_code: lot.warehouseCode,
              expires_on: lot.expiresOn,
              days_to_expiry: lot.daysToExpiry,
              quantity: lot.quantity,
            },
            "lot expiring soon",
          );
        }
        await recordExpiryWarning(tx, { companyId: company.id, lots });
      });
    }
  };
}

/**
 * Registers every handler this slice owns. `apps/worker/src/index.ts` calls it once at boot, BEFORE
 * `boss.start()`, because 0D's boot loop iterates `registeredJobNames()` and installs the worker and the
 * cron fan-out for whatever is registered by then (§4.2.6). Nothing here schedules: the schedule string
 * lives in the closed `JOBS` registry and 0D's loop is its one reader.
 */
export function registerInventoryHandlers(): void {
  registerHandler("inventory.lot.expiry_warning", createExpiryWarningHandler());
}
