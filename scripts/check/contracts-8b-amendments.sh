#!/usr/bin/env bash
# scripts/check/contracts-8b-amendments.sh — 8B's Task 1 Step 1 gate. Run from anywhere. Exits 0 only when every
# amendment of round 17 is in the contracts document AND every predecessor surface this slice consumes is in the
# repository with the spelling the amendments record (A17 is where the plan and the tree disagreed). A MISSING
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

# ── The seventeen amendments (round 17) ─────────────────────────────────────────────────────────────────
need_contract 'Round 17 — Phase 8B contracts' round-17
need_contract 'Migration 0090 is not spare.' A1
need_contract '`0090_create_compensation_change_returns_run.sql` (8B A1, round 17' A1
need_contract '`0088_create_employee_dimension.sql` (8B A2, round 17)' A2
need_contract 'Every `PAYROLL` policy rule declares `dimensions: { "from": ["line.dimensions", "line.employee"] }` and omits `document.branch`.' A3
need_contract 'BRANCH is never here except on PAYROLL lines' A3
need_contract 'to a line exactly when that rule'"'"'s `dimensions.from` names them' A3
need_contract '`PAYROLL` declares `reversal: { "allowed": false, "producesType": null }`' A4
need_contract '**`payroll_line_shape_check`**' A5
need_contract '**`payroll_line_change_draft_only`**' A5
need_contract '`seedPayrollRun(db, s, opts: { periodStart; periodEnd; employeeIds; kind?; payDate?; branchId?; effectiveDate? })' A6
need_contract '**`tests/invariants/support/payroll.ts`** (8B)' A7
need_contract '`"./payroll"` → `./payroll/index.ts` is verified, not re-added.' A8
need_contract '**`PayrollCalculationError`**' A9
need_contract '**`PayrollGoldenExpectation`**' A10
need_contract '**`loadSnapshot` fills `refs.components`, `refs.schemes` and `LineSnapshot.payroll` in 8B.**' A11
need_contract '**`readPayrollRun` returns `compensationChangedBy' A12
need_contract '**`JournalLine` gains `dimensions?: Record<string, string>`**' A13
need_contract '**`"rateTableVersion"` joins `ALLOWED` in `scripts/lint/rules/no-number-money.ts`**' A14
need_contract '**`PAYROLL_DDL_TEST` (series `PDT`, module `hr`, test only)**' A15
need_contract '**`error-codes` scans `packages/domain/payroll/**` as well**' A16
need_contract '**6A'"'"'s `0061` already writes the six-label `document_line_kind_check`**' A17
need_contract '**`lint-schema.ts`'"'"'s set is spelled `noId`**' A17

# ── 8A: the surfaces the payroll engine is built on (phase gate, handoff 8a-to-8b) ─────────────────────
need_repo packages/db/migrations/0080_alter_employee_extend.sql 'create function app.forbid_self_pay()' \
  '8A T1 — the R4 trigger function'
need_repo packages/db/migrations/0083_create_pay_component_compensation.sql 'create table app.pay_component (' \
  '8A T6 — app.pay_component'
need_repo packages/db/migrations/0084_create_statutory_scheme_rate_table.sql 'create table app.statutory_scheme (' \
  '8A T8 — app.statutory_scheme'
need_repo packages/db/migrations/0084_create_statutory_scheme_rate_table.sql 'create table app.statutory_rate_table (' \
  '8A T8 — app.statutory_rate_table'
need_repo packages/db/migrations/0085_create_company_hr_settings.sql 'create table app.company_hr_setting (' \
  '8A T11 — app.company_hr_setting'
need_repo packages/domain/package.json '"./payroll": "./payroll/index.ts"' '8A A11 / 8B A8 — the payroll subpath'
need_repo packages/db/test/fixtures.ts 'export async function seedEmployee(' '6C/8A §4.17 — seedEmployee'
need_repo packages/db/test/fixtures.ts 'export async function seedPayComponent(' '8A §4.17 — seedPayComponent'
need_repo packages/db/test/fixtures.ts 'export async function seedStatutoryScheme(' '8A §4.17 — seedStatutoryScheme'
need_repo packages/db/test/fixtures.ts 'export async function seedRateTable(' '8A §4.17 — seedRateTable'
need_repo packages/db/test/fixtures.ts 'export const SYNTH_RATE_TABLE_V1' '8A A5 — the synthetic table'

# ── 2A/2B/3C/6A: what the payroll document is built on ─────────────────────────────────────────────────
need_repo packages/db/migrations/0061_alter_document_add_pos_columns.sql \
  "check (kind in ('account','item','tax','text','tender','payroll'))" '6A — the six-label kind union (A17 item 1)'
need_repo packages/domain/posting-policy.schema.json '"line.employee"' '2A — line.employee in dimensions.from (A3)'
need_repo packages/db/test/fixtures.ts 'export async function draftTypedDocument(' '3C §4.17 — draftTypedDocument'
need_repo packages/db/test/fixtures.ts 'export async function seedDocumentType(' '2A §4.17 — seedDocumentType'
need_repo packages/db/src/seed/chart-of-accounts.ts 'export const chartOfAccountsLoader' '0C — applies 8b-payroll.json'
need_repo packages/db/src/lint-schema.ts 'const noId = new Set([' '0A §3.5.3 — the no-id set (A17 item 2)'
need_repo packages/db/seed/roles.ts '["hr.payroll.prepare", "hr.payroll.approve"],' '0D §4.2.5 — R6'
need_repo apps/api/src/middleware/require-attachment-read.ts 'export const MODULE_READ_CODE' '2C §4.5.8 — the hr row (8B T3)'
need_repo apps/api/src/middleware/require-document-permission.ts 'export const POLICY_RESOLVED_CODES' \
  '2A §4.5.4 — the three PAYROLL policy codes (8B T3)'
need_repo packages/db/src/export/tables.ts 'export const NEVER_EXPORTED' '7C §4.6.1 — 7C-FIRST (A17 item 4)'

if [ "$fail" -ne 0 ]; then
  echo "8B Task 1 gate FAILED"
  exit 1
fi
echo "8B Task 1 gate OK."
