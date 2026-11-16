/**
 * The domain-side report-definition validation error (contracts §4.11.1, 7A Task 4). It is its own module
 * because both `codes.ts` (from `reportCode()`) and `validate.ts` (from `parseReportDefinition()`) throw it,
 * while `validate.ts` also imports from `codes.ts`; declaring it in either would close a module cycle.
 * `packages/domain` may not import `@dulja/contracts` (§3.1), so this follows the `PolicyEvaluationError`
 * precedent (§4.4.2) rather than `AppError`; `errors[]` carries JSON Pointers, which §4.2.4 lets
 * `ERR_VALIDATION_FAILED` carry to the wire.
 */
export class ReportDefinitionError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  readonly errors: readonly { path: string; message: string }[];
  constructor(detail: string, errors: readonly { path: string; message: string }[] = []) {
    super(detail);
    this.name = "ReportDefinitionError";
    this.errors = errors;
  }
}
