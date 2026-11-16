#!/usr/bin/env bash
# scripts/check/contracts-8a-amendments.sh — 8A's Task 0 gate. Run from anywhere. Exits 0 only when every
# amendment of round 16 is in the contracts document AND every predecessor surface this slice consumes is in
# the repository with the spelling the amendments record (A21 is where the plan and the tree disagreed). A
# MISSING (repo) line is never fixed by editing this script or by writing the name locally — it is a raise
# against the owning slice.
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

# ── The twenty-one amendments (round 16) ────────────────────────────────────────────────────────────────
need_contract 'Round 16 — Phase 8A Task 0 contracts' round-16
need_contract '**6C branch: `6C-FIRST`**' round-16
need_contract '**7C branch: `7C-FIRST`**' round-16
need_contract 'The 8A owner gates are OD-28, OD-14, OD-23 and OD-24 — not OD-13.' A1
need_contract '`statutory_scheme.payable_account_id` ships NULLABLE, not `not null`.' A2
need_contract '`statutory_scheme` gains `employer_registration text`' A3
need_contract '`company_hr_setting.employer_registrations jsonb` is dropped.' A4
need_contract '`SYNTH_RATE_TABLE_V1` is an exported const of `packages/db/test/fixtures.ts`, owned by 8A' A5
need_contract '**`hrFixture(api: StartedApi, name?: string)`**' A6
need_contract '`/v1/companies/:companyId/pay-components` → `payComponentRoutes`' A7
need_contract '`AppDeps` gains `hrKeys: HrKeyRing`' A8
need_contract '**base64 of exactly 32 bytes**' A8
need_contract '{ employee_sensitive: "sensitive_gate", compensation_line: "compensation_gate", employee_statutory_profile: "compensation_gate" }' A9
need_contract '`rate_table_lapse_warning` is the third audit `table_name` sentinel' A10
need_contract '`packages/domain` gains a `"./payroll"` export subpath' A11
need_contract '`SubPack` gains `"statutory"`, last in `SUB_PACKS`' A12
need_contract '`pay_component_scheme_scheme_fk`' A13
need_contract 'A `pay_component_scheme` row is never DELETEd.' A14
need_contract 'The class is **`HrKeyError`**' A15
need_contract '`composeEmployeeRouter(hrKeys: HrKeyRing): OpenAPIHono<AppEnv>`' A16
need_contract '`hiredOn?: string` — 6C'"'"'s own A12' A17
need_contract '`packages/contracts/src/hr/employee.ts` follows the first-to-run rule' A18
need_contract '`app.stamp_actor_always()`' A19
need_contract '8A'"'"'s three `EXPORT_TABLES` rows follow a first-to-run branch.' A20
need_contract 'the tree as Phases 6 and 7 merged it' A21
need_contract '`AppDeps` already had seven members' A21
need_contract '`containerSecrets(env, entrypoint)` lives in `apps/edge/src/container-env.ts`' A21
need_contract 'The export registry'"'"'s forward pin.' A21

# ── The Phase 4 gate (Task 0 Step 2, A21 item 1) ────────────────────────────────────────────────────────
need_repo packages/db/src/posting/post.ts 'export async function postDocument' '1A — the posting service'
need_repo packages/db/src/reports/trial-balance.ts 'export' '1B — the trial balance'
need_repo packages/db/migrations/0017_create_party.sql 'create table app.party' '2A — app.party'
need_repo packages/db/src/attachment/object-store.ts 'export interface ObjectStore' '2C — the ObjectStore port'
need_repo packages/db/migrations/0046_create_allocation.sql 'create table app.allocation' '4A — allocation'
need_repo packages/db/src/ar-ap/reconciliation.ts 'export async function reconciledBalance' \
  '4B — bank reconciliation (A21 item 1)'

# ── 6C: the employee master 8A extends (6C-FIRST) ──────────────────────────────────────────────────────
need_repo packages/db/migrations/0064_create_employee_minimal.sql 'create table app.employee (' \
  '6C/8A §4.6.2 — the minimal master; Task 1 verifies, never creates'
need_repo packages/db/test/fixtures.ts 'export async function seedEmployee(' '6C §4.17 — seedEmployee'
need_repo packages/db/test/fixtures.ts 'hiredOn?: string;' '6C A12 / 8A A17 — the fourth option'
need_repo packages/contracts/src/hr/employee.ts 'export const EmployeeSchema' \
  '6C §4.2.8 — Task 1 appends three wire fields (A18)'
need_repo apps/api/src/routes/hr/employees.ts 'export const employeeRoutes' \
  '6C — composed, never mutated (A16)'
need_repo apps/api/src/routes/hr/employees.ts 'export const employeeRouteModule' '6C §4.2.7'
need_repo packages/contracts/permissions.ts 'code: "hr.employee.read"' '6C §3.6.2 — hrFixture'"'"'s sixC'

# ── 0A/0B/2B surfaces the migrations and fixtures consume ──────────────────────────────────────────────
need_repo packages/db/migrations/0001_foundations.sql 'create function app.actor_has(p_code text, p_company_id uuid' \
  '0A — every RESTRICTIVE gate of this slice evaluates it'
need_repo packages/db/migrations/0001_foundations.sql 'create procedure app_meta.attach_audit(tbl regclass, mode text default '"'"'tenant_column'"'"', key_cols text' \
  '0A — the key_cols grammar the NO_ID_TABLES members use'
need_repo packages/db/migrations/0001_foundations.sql 'create function app.stamp_actor()' \
  '0A — the write-once stamp A19 deliberately does not use on updated_by'
need_repo packages/db/test/fixtures.ts 'export async function grantCodes(' '2B §4.17'
need_repo packages/db/test/fixtures.ts 'export async function seedTenantV2(' '1A §4.17'
need_repo apps/api/test/support/app.ts 'export interface StartedApi' '0B §4.2.12 — hrFixture'"'"'s parameter'
need_repo packages/db/seed/roles.ts '["hr.statutory_table.manage", "hr.statutory_table.verify"]' \
  '0D §4.2.5 — R6, why verify goes to the accountant'
need_repo packages/db/seed/roles.ts '["hr.employee.read_sensitive", "pos.ticket.sell"]' '0D §4.2.5 — R6'

# ── Phases 6 and 7: the wiring 8A Task 3 moves (A21 items 2-4, 6) ──────────────────────────────────────
need_repo apps/api/src/app.ts 'terminalJwtSigningKey: Uint8Array;' '6A — AppDeps'"'"'s seventh member (A21 item 2)'
need_repo apps/edge/src/container-env.ts 'export function containerSecrets(' \
  '0C/6A — the container environment (A21 item 4)'
need_repo docs/runbooks/deploy.md 'The container'"'"'s secrets are set once per environment' \
  '0C — the runbook block the config and edge tests read'
need_repo packages/db/src/export/tables.ts 'export const NEVER_EXPORTED' '7C §4.6.1 — 7C-FIRST (A20)'
need_repo packages/db/src/export/tables.ts 'employee_sensitive:' '7C — the forward pin 8A narrows (A21 item 6)'

if [ "$fail" -ne 0 ]; then
  echo "8A Task 0 gate FAILED"
  exit 1
fi
echo "8A Task 0 gate OK."
