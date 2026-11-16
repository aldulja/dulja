#!/usr/bin/env bash
# scripts/check/contracts-8d-amendments.sh — 8D's Task 0 gate. Run from anywhere. Exits 0 only when every amendment of
# round 19 is in the contracts document AND every predecessor surface this slice consumes is in the repository with
# the spelling the amendments record (A13 is where the plan and the tree disagreed). A MISSING (repo) line is never
# fixed by editing this script or by writing the name locally — it is a raise against the owning slice.
set -uo pipefail
cd "$(dirname "$0")/../.."
CONTRACTS="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0

need_contract() { # need_contract <literal> <amendment id>
  if ! grep -qF -- "$1" "$CONTRACTS"; then
    echo "MISSING (doc $2): $1"
    fail=1
  fi
}

need_repo() { # need_repo <file> <literal> <what it is and who owns it>
  if [ ! -f "$1" ]; then
    echo "MISSING (repo): $1 does not exist — $3"
    fail=1
  elif ! grep -qF -- "$2" "$1"; then
    echo "MISSING (repo): $2 is not in $1 — $3"
    fail=1
  fi
}

# ── The amendments of round 19 (8D A1–A14), each where it is applied ──────────────────────────────────────────────
need_contract 'Round 19 — Phase 8D contracts' round-19
need_contract '| `HR_FIELD_ENCRYPTION_KEY_VERSION` | api, worker | 8D | the integer key_version the current HR_FIELD_ENCRYPTION_KEY seals under; optional, default 1.' A1
need_contract '9B adds `legacy_ref`; 8D adds contract_ends_on date (0098) |' A2
need_contract 'the permit half is GET …/employees/permit-expiry, gated hr.employee.read_sensitive — a dataset cannot decrypt (A3)' A3
need_contract '**A payslip is rendered synchronously in `apps/api`, not by `reporting.render` (8D A4, round 19).**' A4
need_contract 'POST …/payroll-runs/{documentId}/payslips returns JSON and writes, so it is not a member (8D, A5).' A5
need_contract '8D'"'"'s two projection cases are "employee_ytd" and "statutory_schedule", and its two LEDGER_MEASURE keys are "net_contribution" and "payable_contribution"' A6/A10
need_contract '| `tests/invariants/support/hr-reports.ts` | **8D** |' A7
need_contract 'public_holiday carries §4.5.6 Form B; the other three carry none (A8)' A8
need_contract 'the two hr.leave.* permission rows are inserted by 0096, not 0097 (A9)' A9
need_contract 'The one exception is 8D'"'"'s two ⚠️ hr.leave.* rows, which 0096 inserts so the whole OD-13 gate is one file and one task (A9).' A9
need_contract 'the payroll_line dataset also serves two signed measures, net_contribution and payable_contribution, so a definition over it can declare a ledger_sum tie-out (8D, A10)' A10
need_contract '**`PAYSLIP_ENGINE: PrintEngineCode` in `apps/api/src/print/payslip.ts` (8D A11, round 19)**' A11
need_contract '`apps/worker/src/hr-keys.ts` holds the worker'"'"'s `hrKeyRing()` / `setHrKeyRing()` / `hrKeyRingFromEnv()`' A12
need_contract '**8D A13 — the tree as Phases 7, 8A, 8B and 8C merged it.**' A13
need_contract '**The registry base is twenty-eight, not twenty-nine.**' A13
need_contract '**`employee` and `attendance_event` → `hr.employee.read`; `payroll_line`, `employee_ytd` and `statutory_schedule` → `hr.payroll.read`**' A13
need_contract '**8D A14 — §2.12 (OD-13), §4.16.2, §4.6.1.**' A14

# ── 8C: the schedules, projection and money-out types 8D reports on (handoff 8c-to-8d) ───────────────────────────────
need_repo packages/db/migrations/0091_create_statutory_schedule_and_remittance_guard.sql 'create table app.statutory_schedule (' \
  '8C T1 — app.statutory_schedule'
need_repo packages/db/migrations/0092_create_employee_ytd.sql 'create table app.employee_ytd (' '8C T2 — app.employee_ytd'
need_repo packages/db/migrations/0092_create_employee_ytd.sql 'create table app.employee_ytd_opening (' '8C T2 — the opening'
need_repo packages/db/src/hr/schedule.ts 'export async function generateStatutorySchedule(' '8C T7 — the schedule generator'
need_repo packages/db/src/hr/schedule.ts 'export async function missingEmployerRegistrations(' '8C T15 — the OD-23 gap reader'
need_repo packages/db/src/hr/ytd.ts 'export async function ytdFromEmployeeYtd(' '8C T3 — the annual statement'"'"'s read'
need_repo packages/db/seed/my/document-types/PAYROLL_PAYMENT.json '"code": "PAYROLL_PAYMENT"' '8C T5 — the batch type'
need_repo packages/db/seed/my/document-types/EMPLOYEE_ADVANCE.json '"code": "EMPLOYEE_ADVANCE"' '8C T5 — the advance type'
need_repo tests/invariants/support/payroll-money.ts 'export async function moneyOutFixture(' '8C B3 — the money-out corpus'

# ── 8B, 8A, 6C: the payroll run, the HR master and the key ring ───────────────────────────────────────────────────────
need_repo packages/db/migrations/0087_create_payroll_run_line.sql 'create table app.payroll_line (' '8B T1 — app.payroll_line'
need_repo tests/invariants/support/payroll.ts 'export async function payrollFixture(' '8B A7 — payrollFixture'
need_repo tests/invariants/support/payroll.ts 'export async function postPayrollRun(' '8B A7 — postPayrollRun'
need_repo packages/db/test/fixtures.ts 'export async function seedPayrollRun(' '8B A6 — seedPayrollRun'
need_repo packages/db/seed/my/chart-of-accounts/8b-payroll.json '"code": "2400"' '8B T4 — salaries payable (hazard 33)'
need_repo packages/db/seed/my/chart-of-accounts/8b-payroll.json '"code": "5300"' '8B T4 — salaries expense (hazard 33)'
need_repo packages/db/src/hr/keys.ts 'export function createHrKeyRing(' '8A T3 — the HR key ring'
need_repo packages/db/src/hr/sensitive.ts 'export function sealField(' '8A T3 — the envelope writer'
need_repo apps/api/src/routes/hr/employees-composed.ts 'export function composeEmployeeRouter(' '8A A16 — the employees composition point'
need_repo apps/api/src/middleware/require-attachment-read.ts 'hr: PERMISSION["hr.payroll.read"]' '8B T3 — MODULE_READ_CODE.hr'
need_repo packages/db/migrations/0067_create_attendance_event_and_cashier_snapshot.sql 'create table app.attendance_event (' \
  '6C — the attendance events hr.attendance reads'
need_repo apps/edge/src/container-env.ts '"HR_FIELD_ENCRYPTION_KEY_PREVIOUS",' '8A — containerSecrets (A13 item 3)'
need_repo apps/worker/src/object-store.ts 'export function setObjectStore(' '7A — the worker singleton A12 copies'

# ── 7A, 7B, 7C, 2C: the report engine, the tie-out harness, the export registry, the print engines ──────────────────
need_repo packages/db/src/reports/datasets.ts 'export const DATASET_READ_CODES' '7 review — the per-dataset gate (A13 item 2)'
need_repo packages/db/src/reports/query.ts 'export function defineDataset(' '7A — defineDataset'
need_repo packages/domain/src/reports/render.ts 'export function renderReport(' '7A — renderReport'
need_repo packages/domain/src/reports/pdf-source.ts 'export function reportToHtmlSource(' '7A — reportToHtmlSource'
need_repo tests/invariants/support/reports.ts 'const LEDGER_MEASURE' '7B — the measure map A10 extends'
need_repo tests/invariants/support/reports.ts 'export async function assertTieOut(' '7B — assertTieOut'
need_repo packages/db/src/export/tables.ts 'export const NEVER_EXPORTED' '7C — the export registry'
need_repo apps/api/src/print/engines/index.ts 'export function engineFor(' '2C — engineFor'
need_repo packages/db/src/attachment/index.ts 'export async function createAttachment(' '2C — createAttachment'
need_repo packages/db/src/jobs/names.ts '"hr.encryption_key.rotate": { schedule: null, owner: "8D" }' '0B §4.2.6 — the one job 8D owns'

if [ "$fail" -ne 0 ]; then
  echo "8D Task 0 gate FAILED"
  exit 1
fi
echo "8D Task 0 gate OK."
