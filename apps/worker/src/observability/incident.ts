import * as Sentry from "@sentry/node";
import type { Logger } from "@dulja/contracts";
import type { IntegrityReport } from "@dulja/db";

/**
 * The alarm half of spec:2246's ledger-integrity SLI: "This alarm is the single most valuable thing you
 * can build — it is the alarm the old system needed and never had."
 */
export interface IncidentReporter {
  raise(kind: string, report: IntegrityReport): void;
}

/**
 * Sends the report to Sentry when SENTRY_DSN is configured (0C wires the DSN for api, worker and desktop
 * — contracts §3.11) and always leaves one structured error line behind. With no DSN — a developer
 * machine, CI, or before OWNER GATE OD-22 lands — the logger line IS the incident, so the job's behaviour
 * is identical everywhere and no test needs a Sentry stub.
 *
 * The report carries no credential, token or PII: it is ids, counts and decimal strings, so it passes
 * the forbidden-log-fields rule (contracts §3.7.5) unchanged.
 */
export function createIncidentReporter(logger: Logger): IncidentReporter {
  const dsn = process.env["SENTRY_DSN"];
  return {
    raise(kind, report) {
      logger.error(
        {
          incident: kind,
          tenant_id: report.tenantId,
          request_id: report.requestId,
          summary: report.summary,
          unbalanced_periods: report.ledgerBalance.byPeriod.length,
          unbalanced_documents: report.ledgerBalance.byDocument.length,
          projection_mismatches: report.projections.mismatches.length,
          broken_links: report.auditChain.brokenLinks,
          bad_hashes: report.auditChain.badHashes,
          period_reopens: report.periodReopens.length,
        },
        "integrity incident",
      );
      if (dsn === undefined || dsn === "") return;
      Sentry.captureMessage(`${kind}: ${report.summary}`, {
        level: "error",
        tags: { tenant_id: report.tenantId, incident: kind },
        extra: { report },
      });
    },
  };
}
