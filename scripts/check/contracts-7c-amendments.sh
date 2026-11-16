#!/usr/bin/env bash
# scripts/check/contracts-7c-amendments.sh — 7C's Task 0 gate. Run from anywhere. Exits 0 only when every
# amendment of round 15 is in the contracts document AND every predecessor surface this slice consumes is in
# the repository with the spelling the amendments record (A16 is where the plan and the tree disagreed). Every
# later 7C task re-runs it first, because a missing predecessor is a red test that looks like this slice's bug
# and is not. A MISSING (repo) line is never fixed by editing this script or by writing the name locally — it
# is a raise against the owning slice.
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

# ── The sixteen amendments (round 15) ───────────────────────────────────────────────────────────────────
need_contract 'Round 15 — Phase 7C Task 0 contracts' round-15
need_contract 'A1 — §4.16.2, the three Phase 6 datasets (7C).' A1
need_contract '`opened_on` is the shift'"'"'s opening date in the company'"'"'s timezone' A1
need_contract '**`payload` is deliberately neither a column nor selected**' A1
need_contract 'A registered `DatasetId` need not be read by a core definition.' A2
need_contract '`net_sales_base` → `credit_net` and `tax_base` → `credit_net`' A3
need_contract '`tieOut.projection` gains three members (7C)' A3
need_contract '`LedgerWindow` gains three optional members (7C)' A3
need_contract '**Each branch compares per key AND as a set**' A3
need_contract '| `CATALOGUE_7C`, `ReportCode7C`, `CATALOGUE_DIR_7C`' A4
need_contract 'is exactly `statementDefinition("profit_and_loss", { code, nameEn, nameAr, permission: "accounting.report.read" }, { perBranch: true })`' A5
need_contract 'declares **`partyId` (party, required)**' A6
need_contract 'reads the **`tax_transaction`** dataset and declares' A7
need_contract 'is a filter, not a query' A8
need_contract "check (format in ('csv','json','both'))" A9
need_contract '"admin.export.run": { exportJobId: string }' A10
need_contract 'ships a `PERMISSION[…]` reference in the same commit' A11
need_contract '| `/v1/companies/:companyId/exports` | `createExportRoutes(objectStore)`' A12
need_contract '| `seedExportJob(db, s, opts?: { format?; status?; readableModules?; lotAttachments?; includeAttachments? })`' A13
need_contract '| `admin/export.ts` | `ExportFormatSchema`' A14
need_contract '7C widens it by its seven new codes' A15
need_contract 'the tree as Phase 6, 7A and 7B merged it' A16
need_contract 'OD-09 = not built.** Migration `0051` is reserved and unused' A16
need_contract 'There is no exported `readableModules()` in `apps/api`.' A16
need_contract '7A'"'"'s boolean filter bound "true" as false.' A16
need_contract '7B'"'"'s harness had no `party_ageing` branch.' A16
need_contract 'the index gate over 7C'"'"'s filters.' A17

# ── 7A: the engine, the registry and the statements ─────────────────────────────────────────────────────
need_repo packages/db/src/reports/datasets.ts 'export function datasetFor' \
  '7A §4.16.2 — the registry seam Task 1 adds three members to'
need_repo packages/db/src/reports/datasets.ts 'tax_transaction: taxTransactionDataset' \
  '7A §4.16.2 — the last of 7A'"'"'s twenty-five; 7C appends after it'
need_repo packages/db/src/reports/query.ts 'export function defineDataset' \
  '7A — the one dataset constructor'
need_repo packages/db/src/reports/datasets/accounting.ts 'export const taxTransactionDataset' \
  '7A — accounting.tax_return_view reads it (A7)'
need_repo packages/db/src/reports/datasets/ar-ap.ts 'export const bankStatementLineDataset' \
  '7A — accounting.unreconciled_items filters it (A8)'
need_repo packages/db/src/reports/datasets/ar-ap.ts 'export const allocationDataset' \
  '7A — accounting.allocation_register reads it'
need_repo packages/domain/src/reports/validate.ts 'export function validateReportDefinition' \
  '7A §4.11.1 — every definition is validated with it'
need_repo packages/domain/src/reports/statement.ts 'export function statementDefinition' \
  '7A — accounting.branch_profit_and_loss IS its output (A5)'
need_repo packages/domain/src/reports/statement.ts 'accounting.branch_profit_and_loss' \
  '7A — a STATEMENT_CODES key, or the definition silently reads account_balance (A5)'
need_repo packages/db/src/reports/statement.ts 'export async function statementRows' \
  '7A — the perBranch row provider'
need_repo packages/db/src/reports/statement.ts 'export async function rowsForDefinition' \
  '7A — THE one row provider; runDefinition wraps it'
need_repo packages/db/src/reports/statement.ts 'export function assertDefinitionFields' \
  '7A — the seed-time field check'
need_repo packages/db/src/seed/reports.ts 'export const reportsLoader' \
  '7A — applies the 7c/ directory'
need_repo packages/db/test/fixtures.ts 'export async function seedReportDefinition' \
  '7A §4.17'
need_repo packages/db/src/reports/run-store.ts 'export function reportObjectKeyFor' \
  '7A — Task 8'"'"'s exportObjectKeyFor follows its form'
need_repo apps/worker/src/object-store.ts 'export function objectStore' \
  '7A — the worker'"'"'s store, Task 8 writes the archive through it'
need_repo apps/api/src/middleware/require-permission.ts 'export const EXPORT_REQUEST_ROUTES' \
  '7A ADR 0067 — POST …/exports joins it in Task 9 (A12, A16 item 7)'

# ── 7B: the harness this slice extends additively ──────────────────────────────────────────────────────
need_repo tests/invariants/support/reports.ts 'export async function assertTieOut' \
  '7B §4.17.1 — Task 2 appends three projection branches'
need_repo tests/invariants/support/reports.ts 'export async function runDefinition' \
  '7B §4.17.1'
need_repo tests/invariants/support/reports.ts 'export function assertFieldCoverage' \
  '7B §4.17.1'
need_repo tests/invariants/support/reports.ts 'export interface ReportSeedEnvelope' \
  '7B §4.17.1 — readEnvelope7C returns it'
need_repo tests/invariants/support/reports.ts 'credit_net' \
  '7B A5 — the signed measure A3'"'"'s two keys map to (A16 item 2)'

# ── Phase 6: the tables and the read functions 7C re-expresses ─────────────────────────────────────────
need_repo packages/db/migrations/0070_create_shift_till_event.sql 'create table app.shift' \
  '6D — the shift dataset'"'"'s source'
need_repo packages/db/migrations/0070_create_shift_till_event.sql 'create table app.till_event' \
  '6D — the till_event dataset'"'"'s source'
need_repo packages/db/migrations/0060_create_terminal_enrolment_needs_attention.sql 'create table app.needs_attention' \
  '6A — the needs_attention dataset'"'"'s source (0060, not 0059)'
need_repo packages/db/migrations/0061_alter_document_add_pos_columns.sql 'alter table app.pos_terminal add column code text' \
  '6A — terminal_code (A16 item 4)'
need_repo packages/db/src/reports/pos.ts 'export async function zReport' \
  '6D §4.16.3 — pos.z_report parity (Task 4)'
need_repo packages/db/src/reports/pos.ts 'export async function salesByCashier' \
  '6D §4.16.3 — pos.sales_by_cashier parity (Task 4)'
need_repo packages/db/src/reports/pos.ts 'at time zone company.timezone' \
  '6D — the date bucketing the two date companions follow (A16 item 3)'
need_repo packages/db/test/fixtures.ts 'export async function seedShift' \
  '6D §4.17'
need_repo packages/db/test/fixtures.ts 'export async function seedTerminal' \
  '6A §4.17'
need_repo tests/invariants/pos-shift-reconciliation.test.ts 'acceptance 21' \
  '6D — test 21, re-run unchanged by Task 14'
need_repo tests/invariants/support/staff.ts 'export async function staffFixture' \
  '6C §4.17.1 — posReportFixture builds on it'
need_repo tests/invariants/support/staff.ts 'supervisorA' \
  '6C — the supervisor member (there is no managerA)'
need_repo tests/invariants/support/staff.ts 'export async function branchActor' \
  '6C — Task 10'"'"'s branch-narrowed principal'
need_repo tests/invariants/support/pos.ts 'export function buildTicket' \
  '6A §4.17.1'
need_repo packages/db/test/phase-6d-pins.test.ts 'packages/db/src/reports/datasets.ts' \
  '6D — the pin Task 1 retires with the three members (A16 item 10)'

# ── 4B and 5A: the AR/AP and tax corpora ───────────────────────────────────────────────────────────────
need_repo packages/db/src/reports/ageing.ts 'export async function agedBalance' \
  '4B §4.16.3 — accounting.ageing parity (Task 3)'
need_repo tests/invariants/support/ar-ap.ts 'export async function arApFixture(db: Db, s: Seed)' \
  '4B §4.17.1 — arApReportFixture passes a Seed'
need_repo tests/invariants/support/ar-ap.ts 'accountIds: Readonly<Record<string, string>>' \
  '4B — arApReportFixture reads accountIds off the result'
need_repo tests/invariants/support/ar-ap.ts 'export async function postFromPack' \
  '4B §4.17.1'
need_repo packages/db/src/ar-ap/reconciliation.ts 'export async function reconciledBalance' \
  '4B — Task 3'"'"'s unreconciled-items cross-check'
need_repo packages/db/src/ar-ap/reconciliation.ts 'export async function importStatement' \
  '4B — the fixture'"'"'s bank statement (A16 item 9)'
need_repo tests/invariants/support/tax.ts 'export async function postTaxedDocument' \
  '5A §4.17.1 — the one taxed-post path'
need_repo tests/invariants/support/tax.ts 'export interface TaxFixture' \
  '5A §4.17.1'
need_repo tests/invariants/support/tax.ts 'export async function seedTaxPack' \
  '5A — the shipped synthetic pack, through its loader (A16 item 8)'

# ── 2C: the attachment gate the export reuses ──────────────────────────────────────────────────────────
need_repo apps/api/src/middleware/require-attachment-read.ts 'export const MODULE_READ_CODE' \
  '2C §4.5.8 — Task 9 derives readable modules from it (A16 item 6)'

# ── Three facts, reported and not failed on ────────────────────────────────────────────────────────────
echo "--- informational ---"
echo -n "DatasetId members: "
awk '/^export const DATASETS/{on=1;next} on&&/^};/{on=0} on&&/^  [a-z_]+: /{n++} END{print n+0}' \
  packages/db/src/reports/datasets.ts 2>/dev/null || echo "?"
echo -n "ReportCodeSchema members: "
awk '/export const ReportCodeSchema = z.enum\(\[/{on=1;next} on&&/\]\);/{on=0} on&&/^  "/{n++} END{print n+0}' \
  packages/contracts/src/accounting/reports.ts 2>/dev/null || echo "?"
for n in 0078 0079; do
  if compgen -G "packages/db/migrations/${n}_*.sql" > /dev/null; then
    echo "migration $n present"
  else
    echo "migration $n free"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "7C Task 0 gate FAILED"
  exit 1
fi
echo "7C Task 0 gate OK."
