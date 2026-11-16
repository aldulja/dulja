import type { JobName } from "./names";

export interface JobPayload extends Record<JobName, unknown> {
  "pos.cashier.compare": { companyId?: string };
  "pos.sync.apply": { terminalId: string; batch: unknown };
  /** Slice 5B. `phase` is what lets one JOBS name carry both submission and spec:2225's status
   *  reconciliation: the submit handler re-enqueues itself as "poll" while the remote status is
   *  `submitted`. `JOBS` is closed at sixteen names and is not edited. */
  "accounting.tax.submit": { transmissionId: string; phase: "submit" | "poll" };

  /** Slice 1B. Omit both fields for the nightly whole-tenant run. */
  "accounting.ledger.integrity_check": { companyId?: string; sinceAuditSeq?: number };
  /** Slice 1B. `asOf` defaults to the run date; a period is due when ends_on < asOf and status = 'open'. */
  "accounting.period.month_end": { asOf?: string };
  "admin.idempotency_key.purge": Record<string, never>;
  /** Slice 3A. Omit both for the nightly whole-tenant run; `horizonDays` defaults to EXPIRY_HORIZON_DAYS (30). */
  "inventory.lot.expiry_warning": { companyId?: string; horizonDays?: number };
  /** Slice 3B. One job per company; `singletonKey = companyId` collapses a burst of back-dated posts. */
  "inventory.cost.replay": { companyId: string };
  /** Slice 3B. Omit both fields for the nightly whole-tenant rebuild; `asOf` defaults to the run date. */
  "inventory.projection.rebuild": { companyId?: string; asOf?: string };
  /** Slice 4B. Omit both for the nightly whole-tenant run; `asOf` defaults to the run date. The shape is
   *  3B's inventory.projection.rebuild key verbatim — the two handlers are twins. */
  "accounting.projection.rebuild": { companyId?: string; asOf?: string };
  /** Slice 7A. The `report_run` row carries the definition, the parameters, the format and the language, so
   *  the payload is the run id and nothing else — a payload that repeated them could disagree with the row. */
  "reporting.render": { runId: string };
  /** Slice 7C. The `export_job` row carries the format, the recorded gates and the company. */
  "admin.export.run": { exportJobId: string };
  /** Slice 8A. Omit all three for the nightly whole-tenant run at spec:2109's sixty-day horizon. */
  "hr.rate_table.lapse_warning": { companyId?: string; asOf?: string; horizonDays?: number };
  /** Slice 8C (round 18 B4, as built in B18). Omit both for the nightly whole-tenant compare. `year` is the
   *  `employee_ytd.tax_year` to compare; B4's `taxYear` is spelled `year` because `no-number-money` reads `tax`. */
  "hr.employee_ytd.rebuild": { companyId?: string; year?: number };
  /** Slice 8D (ADR 0080). Enqueued by an operator after a key change, never scheduled. `batchSize` defaults to 200
   *  rows per transaction; omit `companyId` to rotate every employee of the tenant. */
  "hr.encryption_key.rotate": { batchSize?: number; companyId?: string };
  /** Slice 9B (contracts round 20 C3). The cut-over load. `only` restricts the run to named TARGET tables and is
   *  ordered by `orderLoaders` regardless of the order given; `dryRun` reads and maps everything and commits nothing
   *  (ADR 0084 decision 5). The `app.import_run` row `runId` names (C17) is authoritative — it also carries the
   *  owner's account map, which a pg-boss payload (no RLS) never does — and the handler fails a run whose payload
   *  disagrees with it. */
  "admin.import.run": {
    companyId: string;
    runId: string;
    cutOverDate: string;
    dryRun: boolean;
    only?: string[];
  };
}
