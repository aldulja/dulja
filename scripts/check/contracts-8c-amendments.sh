#!/usr/bin/env bash
# scripts/check/contracts-8c-amendments.sh — 8C's Task 1 Step 1 gate. Run from anywhere. Exits 0 only when every
# amendment of round 18 is in the contracts document AND every predecessor surface this slice consumes is in the
# repository with the spelling the amendments record (B16 is where the plan and the tree disagreed). A MISSING
# (repo) line is never fixed by editing this script or by writing the name locally — it is a raise against the
# owning slice.
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

# ── The amendments of round 18 (B1–B16 filed by T1; B17–B20 as built) ──────────────────────────────────────────────────────────────────
need_contract 'Round 18 — Phase 8C contracts' round-18
need_contract '`0091_create_statutory_schedule_and_remittance_guard.sql` (8C B1, round 18)' B1
need_contract '**8C registers `employee_ytd_drift`** (B2, round 18)' B2
need_contract '**`tests/invariants/support/payroll-money.ts`** (8C)' B3
need_contract '"hr.employee_ytd.rebuild": { companyId?: string; year?: number };' B4/B18
need_contract '(8C B5, round 18: `EMPLOYEE_YTD_CHECK`;' B5
need_contract '**`app.employee_ytd_delta(p_document_id uuid)` is the one aggregation**' B6
need_contract '**`tax_year` is the calendar year of `payroll_run.pay_date`**' B7
need_contract '**`dimensions.required: ["BRANCH"]` — not `["BRANCH", "EMPLOYEE"]`**' B8
need_contract '**`kind = '"'"'payroll'"'"'` lines on `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` carry no `payroll_line` row**' B9
need_contract '**`createStatutoryScheduleRoutes(store)`** and **`statutoryScheduleRouteModule(store)`**' B10
need_contract '`currency char(3) not null`, `attachment_id uuid`, `remittance_document_id uuid`, `generated_by uuid` (stamped)' B11
need_contract '**`PAYROLL_BATCH_SOURCE: ReconcilableSource`**' B12
need_contract '`ERR_HR_CASHIER_NOT_EMPLOYEE` | 409 |' B13
need_contract 'never merged into the projection (8C B14, round 18)' B14
need_contract '**`packages/db/test/**` may import from `tests/support/**` and `tests/invariants/support/**`**' B15
need_contract '**`lint-schema.ts`'"'"'s no-id set is spelled `noId`**' B16
need_contract '**B18 — §3.4.1, §4.2.6, §4.16.3 (8C T9, 2026-11-07).**' B18
need_contract '**8C overrun, Task 9**' B18
need_contract '**B19 — §4.6.1, the `employee` and `pos_cashier` rows (8C T10, 2026-11-07).**' B19
need_contract '**B20 — §4.6.1, the `employee` and `pos_cashier` rows (8C T11, 2026-11-07).**' B20
need_repo packages/db/migrations/0094_create_cashier_is_employee_constraint.sql 'deferrable initially deferred' '8C T11 — cashiers are employees, deferred (B20)'
need_repo packages/db/migrations/0121_admit_employee_ytd_drift_system_event.sql "'employee_ytd_drift'" '8C T9 — the sentinel admitted to app.record_system_event (B18)'

# ── 8B: the payroll run 8C pays out, projects and schedules (handoff 8b-to-8c) ─────────────────────────
need_repo packages/db/migrations/0087_create_payroll_run_line.sql 'create table app.payroll_run (' '8B T1 — app.payroll_run'
need_repo packages/db/migrations/0087_create_payroll_run_line.sql 'create table app.payroll_line (' '8B T1 — app.payroll_line'
need_repo packages/db/migrations/0089_seed_permission_phase8b.sql "hr.payroll.prepare" '8B T3 — the four hr.payroll.* codes'
need_repo packages/db/migrations/0090_create_compensation_change_returns_run.sql 'compensation_line_returns_run' '8B T11 — R3'
need_repo packages/db/seed/my/document-types/PAYROLL.json '"code": "PAYROLL"' '8B T4 — the PAYROLL type'
need_repo packages/db/seed/my/chart-of-accounts/8b-payroll.json '"code": "2400"' '8B T4 — salaries payable'
need_repo packages/db/seed/my/chart-of-accounts/8b-payroll.json '"code": "1400"' '8B T4 — staff advances'
need_repo packages/db/src/hr/accounts.ts 'export const PAYROLL_ACCOUNT_CODES' '8B T4 — PAYROLL_ACCOUNT_CODES'
need_repo packages/db/src/hr/accounts.ts 'export async function linkPayrollAccounts(' '8B T4 — linkPayrollAccounts'
need_repo packages/db/src/hr/ytd.ts 'export async function ytdFromPostedLines(' '8B T10 — the between-slices YTD read'
need_repo packages/db/test/fixtures.ts 'export async function seedPayrollRun(' '8B A6 — seedPayrollRun'
need_repo tests/invariants/support/payroll.ts 'export async function payrollFixture(' '8B A7 — payrollFixture'
need_repo tests/invariants/support/payroll.ts 'export async function postPayrollRun(' '8B A7 — postPayrollRun'
need_repo tests/invariants/support/payroll.ts 'export async function secondApprover(' '8B A7 — secondApprover'

# ── 8A, 6C, 4B, 1A/1B, 0A: the surfaces 8C's migrations, trigger and source consume ───────────────────
need_repo packages/db/migrations/0084_create_statutory_scheme_rate_table.sql 'create table app.statutory_scheme (' \
  '8A T8 — app.statutory_scheme'
need_repo packages/db/migrations/0080_alter_employee_extend.sql 'employee_no_self_pay' '8A T1 — R4 on terminated_on'
need_repo packages/db/migrations/0065_create_pos_cashier.sql 'create function app.pos_cashier_tombstone()' \
  '6C — the cashier catalogue tombstone'
need_repo packages/db/src/ar-ap/reconciliation.ts 'export function registerReconcilableSource(' \
  '4B §4.8.3 — the Reconcilable registry'
need_repo packages/db/src/integrity/projections.ts 'export function registerProjectionCheck(' \
  '1B §4.16.3 — the projection-check registry'
need_repo packages/db/src/jobs/names.ts '"hr.employee_ytd.rebuild": { schedule: "0 4 * * *", owner: "8C" }' \
  '0B §4.2.6 — the job name 8C owns'
need_repo packages/db/src/lint-schema.ts 'const noId = new Set([' '0A §3.5.3 — the no-id set (B16 item 1)'
need_repo scripts/lint/rules/posting-only-tables.ts '"app.employee_ytd",' '1A §3.7.5 — the protected list (B16 item 2)'
need_repo apps/api/src/middleware/require-document-permission.ts 'export const POLICY_RESOLVED_CODES' \
  '2A §4.5.4 — the policy-resolved codes 8C T4 extends'
need_repo packages/db/src/export/tables.ts 'export const NEVER_EXPORTED' '7C §4.6.1 — 7C-FIRST (B16 item 6)'
need_repo scripts/lint/rules/dependency-rule.ts '{ from: /^packages\/db\/test\//, to: "tests/invariants/support/" },' \
  '3B A21(c) — the first half of B15'

if [ "$fail" -ne 0 ]; then
  echo "8C Task 1 gate FAILED"
  exit 1
fi
echo "8C Task 1 gate OK."
