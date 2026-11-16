// `@dulja/domain/payroll` (contracts round 16, A11). spec:2366: "core never imports HR" — nothing under src/ imports
// this subtree (test/payroll/dependency.test.ts), and packages that need it reach it through the subpath.
import type { RateTable } from "./rate-table";

export type { RateTable } from "./rate-table";
/** The three `table` shapes §4.12.3 admits, by kind. Derived from the generated type, never re-declared. */
export type RateTableBands = Extract<RateTable["table"], { bands: unknown }>;
export type RateTablePercentageWithCeiling = Extract<RateTable["table"], { employee_rate: string }>;
export type RateTableProgressive = Extract<RateTable["table"], { brackets: unknown }>;
export {
  parseRateTable,
  RATE_TABLE_SCHEMA_ID,
  RateTableValidationError,
  validateRateTable,
  type RateTableValidation,
} from "./validate";
// ── everything below this line is appended by 8B (Task 5 onward) ─────────────────────────────────────────────────
// `RateTable` is deliberately ABSENT from the `./types` list: 8A's line above already exports it, and exporting the
// same name twice from one barrel is TS2308.
export { PayrollCalculationError, type PayrollErrorCode } from "./errors";
export type {
  BandedTable,
  EmployeePeriodInput,
  EmployeeResult,
  PayPeriod,
  PayrollCalculator,
  PercentageTable,
  ProgressiveTable,
  RateTableKind,
  RateTableRef,
  SchemeCalculator,
  SchemeResult,
} from "./types";
export { calculators } from "./schemes";
export {
  eligibleDays,
  payrollCalculator,
  periodDays,
  prorationFactor,
  schemeYtdKey,
  ytdKey,
} from "./calculator";
