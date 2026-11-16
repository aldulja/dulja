/**
 * The payroll package's ONE error class (contracts round 17, A9). `packages/domain` may not import `AppError` from
 * `@dulja/contracts` (§3.1's dependency rule), exactly as `PolicyEvaluationError` and `PostingError` exist for the
 * same reason; `apps/api/src/problem.ts` translates it in one branch.
 *
 * The union is a literal SUBSET of `ErrCode` and never a new code: both members are allocated in §4.2.4.
 */
export type PayrollErrorCode = "ERR_PAYROLL_RATE_TABLE_UNVERIFIED" | "ERR_PAYROLL_INPUT_MISSING";

export class PayrollCalculationError extends Error {
  constructor(
    readonly code: PayrollErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PayrollCalculationError";
  }
}
