export {
  createHrKeyRing,
  decodeHrKey,
  DEV_HR_KEY,
  HR_KEY_BYTES,
  HrKeyError,
  type HrKey,
  type HrKeyRing,
} from "./keys";
export { ConfigError } from "./config-error";
export { openField, sealField, SENSITIVE_FIELDS, type SensitiveField } from "./sensitive";
export {
  readSensitive,
  writeSensitive,
  type SensitiveRow,
  type SensitiveValues,
} from "./employee-sensitive";
export {
  listStatutoryProfiles,
  openStatutoryProfile,
  profileOn,
  type StatutoryExtraValue,
  type StatutoryProfile,
  type StatutoryProfileInput,
} from "./statutory-profile";
export {
  archivePayComponent,
  compensationOn,
  createPayComponent,
  listCompensation,
  listPayComponents,
  openCompensation,
  renamePayComponent,
  setComponentSchemes,
  type CompensationLine,
  type PayComponent,
  type PayComponentKind,
} from "./compensation";
export {
  lapsingTables,
  listRateTables,
  listSchemes,
  loadRateTable,
  RateTableNotVerifiableError,
  rateTableOn,
  verifyRateTable,
  type RateTableRow,
  type StatutoryScheme,
} from "./statutory";
export {
  employerRegistrations,
  readHrSetting,
  setEmployerRegistration,
  upsertHrSetting,
  type CompanyHrSetting,
  type ProrationRule,
} from "./settings";
export {
  EMPLOYEE_DIMENSION_CODE,
  ensureEmployeeDimensionType,
  ensureEmployeeDimensionValue,
} from "./employee-dimension";
export { linkPayrollAccounts, PAYROLL_ACCOUNT_CODES, type PayrollAccountLinkage } from "./accounts";
// 8B T10 — the run service (§4.12.6). It writes document, document_line, payroll_run and payroll_line and nothing
// else; postDocument posts it through the shared transitions route.
export { loadPayrollInputs, type LoadInputsOptions, type PayrollInputs } from "./inputs";
export {
  calculatePayrollRun,
  readPayrollRun,
  recalculatePayrollRun,
  type CalculateRunInput,
  type PayrollRunDetail,
  type PayrollRunKind,
  type PayrollRunLine,
  type PayrollRunResult,
  type PayrollRunStatus,
  type RunScope,
} from "./run";
export { PayrollRunError, type PayrollRunErrorCode } from "./run-error";
// 8B T11 — the manual statutory override (spec:2087), recorded on a draft and recalculated at once.
export {
  listOverrides,
  setStatutoryOverride,
  type OverrideRow,
  type SetOverrideInput,
} from "./override";
export { ytdFromEmployeeYtd, ytdFromPostedLines } from "./ytd";
// 8C T6 — money out (spec:2082): the PAYROLL_PAYMENT batch and the EMPLOYEE_ADVANCE, drafted here and posted by
// postDocument through the shared transitions route; the bank-neutral batch CSV (spec:2083).
export {
  advanceBalance,
  createEmployeeAdvance,
  createPayrollPayment,
  listMoneyOut,
  MoneyOutError,
  readMoneyOut,
  type EmployeeAdvanceInput,
  type MoneyOutErrorCode,
  type MoneyOutLine,
  type MoneyOutListFilter,
  type MoneyOutResult,
  type MoneyOutScope,
  type MoneyOutStatus,
  type MoneyOutTypeCode,
  type PayrollPaymentInput,
} from "./money-out";
export { BATCH_CSV_HEADER, payrollBatchCsv, type BatchCsvRow } from "./batch-csv";
// 8C T7 — statutory schedules (spec:2083): one record per scheme per period per POSTED run, with the generic CSV
// (⚠️ OD-28's default layout) attached under the run and its sha256 recorded.
export {
  generateStatutorySchedule,
  listSchedules,
  missingEmployerRegistrations,
  readSchedule,
  SCHEDULE_CSV_HEADER,
  scheduleCsv,
  ScheduleError,
  scheduleFileName,
  SCHEME_REFERENCE_KEY_PREFIX,
  type GenerateScheduleInput,
  type ListScheduleFilter,
  type ScheduleErrorCode,
  type ScheduleRow,
  type ScheduleScope,
  type StatutoryScheduleResult,
} from "./schedule";
// 8C T8 — remittance settlement: the PAYMENT that settled a schedule. Migration 0091's trigger is the amount control.
export {
  RemittanceError,
  settleStatutorySchedule,
  unsettleStatutorySchedule,
  type RemittanceErrorCode,
  type SettleScheduleInput,
  type UnsettleScheduleInput,
} from "./remittance";
// 8C T9 — the cut-over openings 9B's importer loads (spec:2084). They never reach app.employee_ytd (round 18 B14);
// ytdFromEmployeeYtd adds them at read time.
export {
  listEmployeeYtdOpening,
  OpeningError,
  upsertEmployeeYtdOpening,
  type EmployeeYtdOpeningInput,
  type EmployeeYtdOpeningRow,
  type OpeningErrorCode,
} from "./opening";
// 8C T12 — the `payroll_batch` Reconcilable source (round 18 B12): exporting it is what runs its module-level
// registration, so importing `@dulja/db` puts payroll batches into 4B's bank matching (test 39).
export { PAYROLL_BATCH_SOURCE } from "./reconcilable";
// 8D T3 (amendment A3) — the permit half of spec:2091's expiry list: decrypted under the RESTRICTIVE sensitive_gate,
// so a caller without hr.employee.read_sensitive receives an empty list.
export { permitExpiry, type PermitExpiryParams, type PermitExpiryRow } from "./permit-expiry";
// 8D T5 — payslips (spec:2083): one bundle per employee of a POSTED run, from the payroll_line dataset the register
// reads; apps/api renders each through 2C's engine and stores it as an attachment on the run (8D A4, ADR 0079).
export {
  payslipRows,
  payslipRunState,
  type PayslipBundle,
  type PayslipHeader,
  type PayslipParams,
  type PayslipRunState,
} from "./payslip";
// 8D T7 — the HR field-encryption key rotation (spec:2273, ADR 0080): one bounded, idempotent batch per call; the
// `hr.encryption_key.rotate` job drives it as the tenant's system principal.
export {
  rotateSensitiveBatch,
  type RotationBatch,
  type RotationBatchOptions,
  type RotationResult,
} from "./rotate";
// 8D T8 — ⚠️ OD-13 answered build (migration 0096): spec:2085's minimal leave register. A record, never a pay input;
// R4 (no self-approval) is 0096's trigger, the company bind is each statement's own join.
export {
  approveLeave,
  createLeaveType,
  createPublicHoliday,
  LeaveError,
  listEntitlements,
  listLeaveRecords,
  listLeaveTypes,
  listPublicHolidays,
  rejectLeave,
  requestLeave,
  setEntitlement,
  type CreateLeaveTypeInput,
  type CreatePublicHolidayInput,
  type LeaveDecisionInput,
  type LeaveEntitlementFilter,
  type LeaveEntitlementRow,
  type LeaveErrorCode,
  type LeaveRecordFilter,
  type LeaveRecordRow,
  type LeaveStatus,
  type LeaveTypeCode,
  type LeaveTypeFilter,
  type LeaveTypeRow,
  type PublicHolidayFilter,
  type PublicHolidayRow,
  type RejectLeaveInput,
  type RequestLeaveInput,
  type SetEntitlementInput,
} from "./leave";
// 8D T9 — ⚠️ OD-23: the parallel run's written reconciliation (the Phase 8 DoD's first clause). `scripts/payroll-
// reconcile.ts` is its CLI; the comparison reads the posted run through payslipRows, so it reconciles the paper.
export {
  parseLegacyCsv,
  ReconcileError,
  reconcileParallelRun,
  renderReconciliation,
  type Difference,
  type DifferenceKind,
  type LegacyPayslip,
  type ReconcileErrorCode,
  type ReconciliationReport,
} from "./reconcile";
