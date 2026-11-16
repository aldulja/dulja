/**
 * The report engine's error class. `AppError` lives in `@dulja/contracts` and 0B's `dependency-rule` pins
 * `packages/db` to `['@dulja/domain']` (§3.1), so this is 1A's `PostingError` precedent (§4.2.4) applied here:
 * a literal subset of `ErrCode`, never a new code. `apps/api/src/problem.ts` translates it in one branch.
 */
export type ReportErrorCode =
  | "ERR_REPORT_DATASET_UNKNOWN"
  | "ERR_VALIDATION_FAILED"
  | "ERR_NOT_FOUND"
  | "ERR_RBAC_FORBIDDEN";

export class ReportError extends Error {
  constructor(
    readonly code: ReportErrorCode,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "ReportError";
  }
}
