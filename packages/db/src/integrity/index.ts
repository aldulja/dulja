import type { Sql } from "postgres";
import { ITEM_PROFITABILITY_CHECK } from "../projections/item-profitability";
import type { TenantContext } from "../with-tenant";
import { checkAuditChain } from "./audit-chain";
import { checkLedgerBalance } from "./balance";
import { COST_LAYER_CHECK } from "./cost-layer-check";
import { EMPLOYEE_YTD_CHECK } from "./employee-ytd";
import { listPeriodReopens } from "./period-reopen";
import { ACCOUNT_BALANCE_CHECK, projectionChecks, registerProjectionCheck } from "./projections";
import { SERIES_GAP_CHECK } from "./series-gaps";
import { STOCK_ON_HAND_CHECK } from "./stock";
import type { IntegrityReport, ProjectionMismatch } from "./types";

registerProjectionCheck(ACCOUNT_BALANCE_CHECK);
// 2B — the numbering proof of contracts §4.5.5 runs in the same nightly job (ADR 0030).
registerProjectionCheck(SERIES_GAP_CHECK);
// 3A — contracts §4.7.3 names this job as stock_on_hand's rebuilder (acceptance test 2's 3A re-run).
registerProjectionCheck(STOCK_ON_HAND_CHECK);
// 3B — cost_layer's one pure invariant, qty_remaining = qty_in − Σ(valid consumptions) (amendment A10).
registerProjectionCheck(COST_LAYER_CHECK);
// 4B — item_profitability is current state keyed on (company, item, fiscal_period), so it is compared here with
// the other current-state projections rather than inside accounting.projection.rebuild (ADR 0046).
registerProjectionCheck(ITEM_PROFITABILITY_CHECK);
// 8C — employee_ytd, the step-12 PAYROLL projection, rebuilt from every posted run through the same
// app.employee_ytd_delta the MERGE consumed (contracts §4.12.8, round 18 B5/B6; ADR 0077).
registerProjectionCheck(EMPLOYEE_YTD_CHECK);

export interface IntegrityCheckOptions {
  /** Narrow the ledger-balance half to one company. */
  companyId?: string | undefined;
  /** Only report period reopens after this audit_log.seq. */
  sinceAuditSeq?: number | undefined;
}

/**
 * One tenant's nightly integrity run (spec:2246 — the SLI "single most valuable thing you can build").
 * Every part is a READ; the only write in this module is recordIntegrityIncident below, and it writes to
 * app.audit_log and nothing else. The job never repairs a projection: SAH-079 is a system that
 * accumulated forty-four repair objects instead of detecting drift at source.
 *
 * The caller supplies the transaction, so a handler can run this and the incident insert in one
 * withTenant (contracts §4.3.1's convention: these functions take the caller's tx and none opens its own).
 */
export async function runIntegrityCheck(
  tx: Sql,
  ctx: TenantContext,
  opts: IntegrityCheckOptions = {},
): Promise<IntegrityReport> {
  const [counted] = await tx<
    { postings: number }[]
  >`select count(*)::int as postings from app.ledger_entry`;
  const postings = counted!.postings;

  const ledgerBalance = await checkLedgerBalance(tx, { companyId: opts.companyId });

  const checked: string[] = [];
  const mismatches: ProjectionMismatch[] = [];
  for (const check of projectionChecks()) {
    checked.push(check.name);
    mismatches.push(...(await check.run(tx)));
  }

  const auditChain = await checkAuditChain(tx, ctx.tenantId);
  const periodReopens = await listPeriodReopens(tx, {
    tenantId: ctx.tenantId,
    sinceSeq: opts.sinceAuditSeq,
  });

  const clean =
    ledgerBalance.byPeriod.length === 0 &&
    ledgerBalance.byDocument.length === 0 &&
    mismatches.length === 0 &&
    auditChain.brokenLinks === 0 &&
    auditChain.badHashes === 0;

  // "no postings" is the wording the 0D scaffold reports (spec:2321), kept so the first real run after
  // 1A is distinguishable from a run that found nothing wrong.
  const summary =
    postings === 0
      ? "no postings"
      : clean
        ? `ok: ${postings} ledger entries, ${checked.length} projection(s) rebuilt, ${auditChain.rows} audit rows walked, ${periodReopens.length} period reopen(s)`
        : `FAILED: ${ledgerBalance.byPeriod.length} unbalanced period(s), ${ledgerBalance.byDocument.length} unbalanced document(s), ${mismatches.length} projection mismatch(es), ${auditChain.brokenLinks} broken link(s), ${auditChain.badHashes} bad hash(es)`;

  return {
    tenantId: ctx.tenantId,
    requestId: ctx.requestId,
    checkedAt: new Date().toISOString(),
    ledgerBalance,
    projections: { checked, mismatches },
    auditChain,
    periodReopens,
    // `ok` means "nothing wrong was found". An empty ledger is not wrong — a freshly bootstrapped tenant
    // must not raise an incident every night — so `postings` shapes the summary and never the verdict.
    ok: clean,
    summary,
  };
}

/**
 * Writes the incident row spec:2246 calls an alarm — through `app.record_system_event` (migration 0105), the
 * one door app_rw has into app.audit_log: 0001 §8 REVOKES insert on the table from app_rw (an earlier version
 * of this comment said the opposite, and this insert failed with 42501 on every drifted night). The function
 * is SECURITY DEFINER, admits exactly two table_name values, takes the tenant from the session, and lets
 * app.audit_chain() hash and link the row, so an incident sits inside the same tamper-evident chain as every
 * other write and cannot be edited away. actor_id is app.current_actor(), which for a job is the tenant's
 * system principal (spec:2179).
 */
export async function recordIntegrityIncident(tx: Sql, report: IntegrityReport): Promise<void> {
  await tx`
    select app.record_system_event('integrity_incident', ${report.requestId}, ${JSON.stringify(report)}::text::jsonb)`;
}

export { checkAuditChain } from "./audit-chain";
export { checkLedgerBalance, type LedgerBalanceOptions } from "./balance";
export { COST_LAYER_CHECK } from "./cost-layer-check";
export {
  checkEmployeeYtdProjection,
  EMPLOYEE_YTD_CHECK,
  type EmployeeYtdCheckOptions,
} from "./employee-ytd";
export { listPeriodReopens, type PeriodReopenOptions } from "./period-reopen";
export {
  checkAccountBalanceProjection,
  projectionChecks,
  registerProjectionCheck,
} from "./projections";
export { SERIES_GAP_CHECK } from "./series-gaps";
export { STOCK_ON_HAND_CHECK, checkStockOnHandProjection } from "./stock";
export type {
  AuditChainResult,
  IntegrityReport,
  LedgerImbalance,
  PeriodReopen,
  ProjectionCheck,
  ProjectionMismatch,
} from "./types";
