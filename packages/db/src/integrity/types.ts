import type { Sql } from "postgres";

/**
 * Every amount below is a fixed-scale decimal STRING as postgres.js returns numeric —
 * never a JavaScript number (spec:2041; the no-number-money lint, contracts §3.7.5).
 */

/** One (company, period) or one document whose base debits and base credits disagree (spec:2246). */
export interface LedgerImbalance {
  readonly scope: "period" | "document";
  readonly companyId: string;
  /** fiscal_period_id for scope 'period', document_id for scope 'document'. */
  readonly subjectId: string;
  readonly baseDebit: string;
  readonly baseCredit: string;
  /** baseDebit − baseCredit, signed. */
  readonly difference: string;
}

/** One row on which a projection and its fresh rebuild disagree (spec:2265, acceptance test 2). */
export interface ProjectionMismatch {
  /** The projection table, e.g. 'account_balance'. */
  readonly projection: string;
  /** The full natural key of the disagreeing row, every value as text. */
  readonly key: Readonly<Record<string, string>>;
  readonly side: "missing_in_projection" | "missing_in_rebuild" | "amount_differs";
  /** Human detail naming the column and both values, e.g. "base_debit 100.0000 <> 90.0000". */
  readonly detail: string;
}

/** The result of walking one tenant's audit chain (spec:1963, acceptance test 13). */
export interface AuditChainResult {
  readonly rows: number;
  readonly brokenLinks: number;
  readonly badHashes: number;
  /** The audit_log.seq of the first bad row, or null when the chain is intact. */
  readonly firstBrokenSeq: number | null;
}

/** One `accounting.period.reopen` observed in the audit log (spec:2179 — "every reopen is reported"). */
export interface PeriodReopen {
  readonly auditSeq: number;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly fiscalPeriodId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  /** From the audited row image; null when the reason was recorded under another key (assumption 5). */
  readonly reason: string | null;
}

/**
 * A projection this slice's integrity job rebuilds and compares. 1B registers `account_balance`;
 * 3A registers `stock_on_hand` (contracts §4.7.3 names this job as its rebuilder) and 8C `employee_ytd`
 * (§4.12.8). The shape mirrors `registerReconcilableSource` (§4.8.3) deliberately: one registry, one
 * call site, no slice editing another slice's file.
 */
export interface ProjectionCheck {
  readonly name: string;
  run(tx: Sql): Promise<ProjectionMismatch[]>;
}

/** What one tenant's nightly run produces; written verbatim into the incident audit row. */
export interface IntegrityReport {
  readonly tenantId: string;
  readonly requestId: string;
  readonly checkedAt: string;
  readonly ledgerBalance: {
    readonly byPeriod: LedgerImbalance[];
    readonly byDocument: LedgerImbalance[];
  };
  readonly projections: {
    readonly checked: string[];
    readonly mismatches: ProjectionMismatch[];
  };
  readonly auditChain: AuditChainResult;
  readonly periodReopens: PeriodReopen[];
  readonly ok: boolean;
  /** "no postings" when the tenant has no ledger_entry rows (spec:2321, the 0D scaffold's wording). */
  readonly summary: string;
}
