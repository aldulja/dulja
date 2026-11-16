import type { Logger } from "@dulja/contracts";
import {
  listPeriodsAwaitingClose,
  recordIntegrityIncident,
  recordMonthEndReady,
  runIntegrityCheck,
  withTenant,
  type PeriodAwaitingClose,
} from "@dulja/db";
// registerHandler and JobHandler are 0D's, and they live in apps/worker, not in @dulja/db: contracts
// §4.2.6 annotates their code block `// apps/worker/src/handler.ts`.
import { registerHandler, type JobHandler } from "../handler";
import type { IncidentReporter } from "../observability/incident";

export interface AccountingHandlerDeps {
  logger: Logger;
  incident: IncidentReporter;
}

/**
 * The nightly ledger-integrity job (JOBS["accounting.ledger.integrity_check"], schedule "0 2 * * *",
 * owner 1B — contracts §4.2.6). 0D scaffolded a body that reported "no postings"; this is the complete
 * one: Σbase debit = Σbase credit per period and per document, every registered projection rebuilt and
 * compared row for row, the audit chain walked, every period reopen listed (spec:2246, 1963, 2179).
 *
 * `ctx` arrives from the runner as the tenant's system principal (systemContext, spec:2179) — the
 * handler never resolves a principal itself and never reads pgboss.tenant_registry: §4.2.6 makes the
 * scheduled dispatch fan out and call this once per tenant.
 *
 * Two short transactions, never one long one (spec:1368): the checks read, then the incident is written.
 */
export function createIntegrityCheckHandler(
  deps: AccountingHandlerDeps,
): JobHandler<"accounting.ledger.integrity_check"> {
  return async (sql, job, ctx) => {
    const log = deps.logger.child({
      tenant_id: ctx.tenantId,
      actor_id: ctx.actorId,
      request_id: ctx.requestId,
      job: "accounting.ledger.integrity_check",
    });

    const report = await withTenant(sql, ctx, (tx) =>
      runIntegrityCheck(tx, ctx, {
        companyId: job.payload.companyId,
        sinceAuditSeq: job.payload.sinceAuditSeq,
      }),
    );

    if (report.ok) {
      log.info(
        { summary: report.summary, period_reopens: report.periodReopens.length },
        "ledger integrity check passed",
      );
      return;
    }

    // The alarm FIRST, then the evidence row: a failed write (a revoked grant, a full disk) must never be
    // the reason nobody heard about a drifted ledger. A failure here still fails the job, so pg-boss retries
    // the write and the log carries it.
    deps.incident.raise("accounting.ledger.integrity_check", report);
    log.error({ summary: report.summary }, "ledger integrity check failed");
    await withTenant(sql, ctx, (tx) => recordIntegrityIncident(tx, report));
  };
}

/**
 * The month-end job (JOBS["accounting.period.month_end"], schedule "0 1 1 * *", owner 1B — §4.2.6).
 * For every company it lists the periods whose ends_on has passed and are still `open`, runs the
 * integrity checks for each, and writes a `month_end_ready` audit row. It never closes a period:
 * closing stays a human act under `accounting.period.close` (spec:2223).
 *
 * Short transactions (spec:1368): one read for the checks and one write for the rows, per company, so a
 * tenant with a long history never holds a single transaction open across the whole run.
 */
export function createMonthEndHandler(
  deps: AccountingHandlerDeps,
): JobHandler<"accounting.period.month_end"> {
  return async (sql, job, ctx) => {
    const asOf = job.payload.asOf ?? new Date().toISOString().slice(0, 10);
    const log = deps.logger.child({
      tenant_id: ctx.tenantId,
      actor_id: ctx.actorId,
      request_id: ctx.requestId,
      job: "accounting.period.month_end",
    });

    const due = await withTenant(sql, ctx, (tx) => listPeriodsAwaitingClose(tx, { asOf }));
    log.info({ as_of: asOf, due: due.length }, "month-end scan");

    // One integrity run per COMPANY, not per period: the check is company-scoped (it rebuilds the whole
    // projection and walks the whole audit chain), so a company three month-ends behind would otherwise run
    // it three times for three identical reports. Each overdue period then gets its own readiness row from
    // the one report.
    const byCompany = new Map<string, PeriodAwaitingClose[]>();
    for (const period of due) {
      const bucket = byCompany.get(period.companyId);
      if (bucket) bucket.push(period);
      else byCompany.set(period.companyId, [period]);
    }

    for (const [companyId, periods] of byCompany) {
      const report = await withTenant(sql, ctx, (tx) => runIntegrityCheck(tx, ctx, { companyId }));

      await withTenant(sql, ctx, async (tx) => {
        if (!report.ok) await recordIntegrityIncident(tx, report);
        for (const period of periods) {
          await recordMonthEndReady(tx, ctx.tenantId, {
            fiscalPeriodId: period.fiscalPeriodId,
            companyId: period.companyId,
            endsOn: period.endsOn,
            ready: report.ok,
            summary: report.summary,
          });
        }
      });

      if (report.ok) {
        for (const period of periods) {
          log.info(
            { fiscal_period_id: period.fiscalPeriodId, ends_on: period.endsOn },
            "period ready to close",
          );
        }
      } else {
        deps.incident.raise("accounting.period.month_end", report);
        for (const period of periods) {
          log.error(
            { fiscal_period_id: period.fiscalPeriodId, summary: report.summary },
            "period not ready to close",
          );
        }
      }
    }
  };
}

/**
 * Registers every handler this slice owns. `apps/worker/src/index.ts` calls it once at boot, BEFORE
 * `boss.start()`, because 0D's boot loop iterates `registeredJobNames()` and installs the worker and the
 * cron fan-out for whatever is registered by then (§4.2.6). Nothing here schedules: the schedule string
 * lives in the closed `JOBS` registry and 0D's loop is the one reader of it. A `boss.schedule` of our own
 * on the bare name would queue a tenant-less envelope `runJob` cannot resolve.
 */
export function registerAccountingHandlers(deps: AccountingHandlerDeps): void {
  registerHandler("accounting.ledger.integrity_check", createIntegrityCheckHandler(deps));
  registerHandler("accounting.period.month_end", createMonthEndHandler(deps));
}
