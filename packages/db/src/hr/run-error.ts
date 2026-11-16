/**
 * The payroll run service's refusal (8B T10). `packages/db` may not import `AppError` from `@dulja/contracts`
 * (§3.1), so — like `PostingError` and `ReportError` — the run service throws its own class carrying a code that is
 * already a row of `ERRORS`, and `apps/api/src/problem.ts`'s `hasErrorCode` branch turns it into that `AppError`
 * through `fromDomainError`. No new `ERRORS` row is added by this class (8B Global Constraint 11).
 */
export type PayrollRunErrorCode =
  | "ERR_NOT_FOUND"
  | "ERR_DOC_NOT_DRAFT"
  | "ERR_PERIOD_NOT_FOUND"
  | "ERR_POLICY_REQUIRES_MISSING"
  | "ERR_RBAC_FORBIDDEN"
  | "ERR_VALIDATION_FAILED";

export class PayrollRunError extends Error {
  constructor(
    readonly code: PayrollRunErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PayrollRunError";
  }
}
