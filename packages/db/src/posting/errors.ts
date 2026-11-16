/**
 * The posting service's error type.
 *
 * `packages/db` may import `@dulja/domain` and nothing else (spec:2389; scripts/lint/rules/dependency-rule.ts),
 * so it cannot construct the `AppError` of contracts §4.2.4 — which lives in `@dulja/contracts`. The CODES are
 * the ones §4.3.8 lists, and `apps/api/src/problem.ts` maps this class to an `AppError` in one branch, exactly
 * as 0B already maps `TenantContextError` (also declared in `@dulja/db`) for the same reason. The wire response
 * is the `Problem` §4.2.4 specifies, unchanged.
 */
export type PostingErrorCode =
  | "ERR_TAX_REGIME_MISMATCH"
  | "ERR_NOT_FOUND"
  | "ERR_DOC_STATUS_ILLEGAL"
  | "ERR_DOC_NO_LINES"
  | "ERR_POLICY_NOT_FOUND"
  | "ERR_POLICY_INVALID"
  | "ERR_POLICY_REQUIRES_MISSING"
  | "ERR_PERIOD_NOT_FOUND"
  | "ERR_PERIOD_NOT_OPEN"
  | "ERR_LEDGER_UNBALANCED"
  // 3B — the costing hook runs inside postDocument (contracts §4.3.2 step 9, §4.3.8)
  | "ERR_STOCK_INSUFFICIENT"
  | "ERR_COST_NEGATIVE"
  | "ERR_COST_VALUE_MISSING"
  // 3B — a back-dated inventory document reached postDocument through a caller that supplied no JobClient
  | "ERR_INTERNAL"
  // 4B, contracts round 8 amendment 11 — revalueAtPeriodEnd finds no app.rate_for row for an exposed currency
  | "ERR_RATE_NOT_FOUND"
  // Phase 4 review B3 — reverseDocument refuses a reversal dated before its original
  | "ERR_VALIDATION_FAILED";

export class PostingError extends Error {
  constructor(
    readonly code: PostingErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PostingError";
  }
}
