#!/usr/bin/env bash
# scripts/check/contracts-7b-amendments.sh — 7B's Task 0 gate. Run from the repository root. Exits 0 only when
# every amendment of round 14 is in the contracts document AND every name this slice imports is in the
# repository with the spelling the amendments record. A MISSING (repo) line is never fixed by editing this
# script or by writing the name locally — it is a raise against the owning slice.
set -uo pipefail
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

# ── The eighteen amendments (round 14) ──────────────────────────────────────────────────────────────────
need_contract 'Round 14 — Phase 7B Task 0 contracts' round-14
need_contract '"definitionVersion": <int ≥ 1>, "definition": <ReportDefinition>' A1
need_contract 'Re-expression does not rewrite the JSON list route.' A2
need_contract 'Each dataset'"'"'s row fields are 7A'"'"'s `DatasetColumn.field` values' A3
need_contract 'base_total' A3
need_contract 'actor_display_name' A3
need_contract 'Its `value` is the layer'"'"'s stored receipt value (migration 0118), not its residue' A3
need_contract '7B widens it by its seventeen' A4
need_contract 'No slice asserts a total member count.' A4
need_contract 'A module list endpoint is not a `ReportCode`' A4
need_contract 'Membership in this enum is not what makes a code runnable' A4
need_contract 'What each `kind` means to the harness that executes it' A5
need_contract 'The measure map is closed' A5
need_contract 'A signed field is never mapped to `credit`.' A5
need_contract '`none` never means "no test"' A5
need_contract 'round(value × qty_remaining / qty_in, 4)' A5
need_contract 'are company-level, over `account_balance`, and are not hand-written' A6
need_contract 'each is exactly `statementDefinition(kind, identity)`' A6
need_contract 'never through `datasetFor("account_balance").run`' A6
need_contract 'Both are one fiscal period'"'"'s movement, not a cumulative position' A6
need_contract '0077_add_report_filter_indexes.sql`, used, not reserved' A7
need_contract 'seedReportDefinition(db, s, opts: { code; definition; definitionVersion?; isCore?; clonedFrom? })' A8
need_contract 'tests/invariants/support/reports.ts' A9
need_contract '`CATALOGUE_7B`, `ReportCode7B`, `CATALOGUE_DIR`' A9
need_contract '`documentTypeCode` is `kind: "text"`' A10
need_contract 'export function datasetFor(id: string): Dataset' A11
need_contract 'readonly filters: readonly DatasetFilter[];  // an ARRAY OF TRIPLES' A11
need_contract 'export function validateReportDefinition(definition: unknown, sets: ReportDefinitionSets)' A11
need_contract 'SYNCHRONOUS, and it returns a `RenderedReport` VALUE OBJECT' A11
need_contract 'export function renderCsv(report: RenderedReport' A11
need_contract 'export async function statementRows(tx: Sql, kind: StatementKind' A11
need_contract 'NOT REACHABLE FROM THIS SLICE' A11
need_contract 'WALKS `<packRoot>/reports/<slice>/*.json`' A11
need_contract "written for the **\`'avco'\` default** of OD-06" A12
need_contract 'The `cost_layer` dataset is 7A'"'"'s `costLayerDataset`, not 3B'"'"'s `openLayersOf`' A13
need_contract 'is the **per-fiscal-period** view of the same projection' A14
need_contract 'is one definition with ONE `fiscalPeriodId` parameter' A15
need_contract 'The clause is retired from 7B and reassigned' A16
need_contract 'The exemption list is closed at merge' A17
need_contract 'A18 — the tree as 7A merged it.' A18

# ── 7A: every name every task imports ──────────────────────────────────────────────────────────────────
need_repo packages/domain/src/reports/validate.ts 'export function validateReportDefinition' \
  '7A §4.11.1 (A11) — every definition is validated with it, with the TWO-SET second argument'
need_repo packages/domain/src/reports/validate.ts 'export interface ReportDefinitionSets' \
  '7A §4.11.1 (A11) — the { datasets, permissions } second argument'
need_repo packages/domain/src/reports/render.ts 'export function renderReport' \
  '7A §4.11.2 (A11) — SYNCHRONOUS, returns RenderedReport; 7B Task 11 renders in both directions'
need_repo packages/domain/src/reports/format.ts 'export function intlFormatters' \
  '7A (A11) — RenderOptions.formatters is REQUIRED'
need_repo packages/domain/src/reports/render.ts 'export function renderCsv' \
  '7A Task 8 (A11) — the rendered-TEXT layer test 23 is asserted on in this slice'
need_repo packages/domain/src/reports/statement.ts 'export function statementDefinition' \
  '7A Task 9 (A6) — 7B Task 2'"'"'s two seed files ARE its output'
need_repo packages/domain/src/reports/statement.ts 'export const STATEMENT_CODES' \
  '7A Task 9 (A6) — the code->statement binding; 7B keeps NO local map'
need_repo packages/domain/src/reports/statement.ts 'export function statementKindFor' \
  '7A Task 9 (A6) — the total function the harness guards fiscalPeriodId with'
need_repo packages/db/src/reports/statement.ts 'export async function statementRows' \
  '7A Task 9 (A6) — the only row provider that annotates `section`'
need_repo packages/db/src/reports/statement.ts 'export async function rowsForDefinition' \
  '7A Task 9 (A6/A11) — THE one row provider; runDefinition wraps it'
need_repo packages/db/src/reports/statement.ts 'export function assertDefinitionFields' \
  '7A Task 9 (A3/A11) — the seed-time field check'
need_repo packages/db/src/reports/datasets.ts 'export function datasetFor' \
  '7A §4.16.2 (A11) — the registry seam'
need_repo packages/db/src/reports/datasets.ts 'export const DATASET_IDS' \
  '7A §4.16.2 (A11) — the datasets set for validateReportDefinition'
need_repo packages/db/src/reports/datasets.ts 'export type DatasetId' \
  '7A §4.16.2 — 7B adds no member'
need_repo packages/db/src/reports/query.ts 'readonly offset: number' \
  '7A (A11) — DatasetParams requires sort AND offset'
need_repo packages/db/src/reports/datasets/inventory.ts '{ field: "value", kind: "numeric", ref: (tx) => tx`cl.value` }' \
  '7A (A3/A5) — cost_layer.value is the stored RECEIPT value; the harness values the residue from it'
need_repo packages/db/src/seed/reports.ts 'export const reportsLoader' \
  '7A §3.4.8 — 7B Task 9 applies the 7b/ directory through it'
need_repo packages/db/test/fixtures.ts 'export async function seedReportDefinition' \
  '7A §4.17 (A8) — the group tests seed through it'

# ── 1B, 3B, 3D, 4A, 4B: the read functions this catalogue must not duplicate ──────────────────────────
need_repo packages/db/src/reports/trial-balance.ts 'export async function trialBalance' \
  '1B §4.16.3 — 7B Task 4 parity'
need_repo packages/db/src/reports/ledger.ts 'export async function accountLedger' \
  '1B §4.16.3 — 7B Task 4 parity'
need_repo packages/db/src/reports/stock-on-hand.ts 'export async function stockOnHand' \
  '3D §4.16.3 — 7B Task 8 parity'
need_repo packages/db/src/reports/sales-by-item.ts 'export async function salesByItem' \
  '3D §4.16.3 + 4A revenue/margin — 7B Task 8 parity'
need_repo packages/db/src/costing/valuation.ts 'export async function valuationAsOf' \
  '3B §4.7.2 — the ONE valuation implementation'
need_repo packages/db/src/costing/valuation.ts 'export async function openLayersOf' \
  '3B §4.7.2 (A13) — 7B Task 5 stock ageing'
need_repo packages/db/src/costing/valuation.ts 'export async function rebuildStockValuation' \
  '3B — 7B Task 5 populates stock_valuation with it'
need_repo packages/db/src/projections/item-profitability.ts 'export async function itemProfitabilityRows' \
  '4B amendment 6 — 7B Task 7'
need_repo packages/db/src/projections/item-profitability.ts 'export async function rebuildItemProfitability' \
  '4B — 7B Task 7 populates the projection with it, never by hand'

# ── The test-tier helpers the fixtures are built from ──────────────────────────────────────────────────
need_repo tests/invariants/support/post-journal.ts 'export async function postJournal' \
  '1B §4.17.1 — the way the fixture creates journal ledger rows'
need_repo tests/invariants/support/post-inventory.ts 'export async function postInventoryDocument' \
  '3B §4.17.1 — the TRANSFER in the inventory chain'
need_repo tests/invariants/support/post-inventory.ts 'export async function ensureOpenPeriods' \
  '3B §4.17.1 — the fixture opens all of 2026'
need_repo tests/invariants/support/post-inventory.ts 'export async function secondPrincipal' \
  '3D amendment 12 — the count checker'
need_repo tests/invariants/support/ar-ap.ts 'export async function postFromPack' \
  '4B §4.17.1 — threads partyId; GOODS_RECEIPT and DELIVERY_ORDER require a party'
need_repo tests/invariants/support/ar-ap.ts 'export async function seedTypeFromPack' \
  '4B §4.17.1 — this slice configures NO document type of its own'
need_repo tests/invariants/support/ar-ap.ts 'export function packApproval' \
  '4B §4.17.1 — every post code is read off the shipped envelope'
need_repo tests/invariants/support/post-ar.ts 'export async function postArDocument' \
  '4A §4.17.1 — the revenue side'
need_repo scripts/lint/rules/dependency-rule.ts 'packages/db/test/**' \
  '3B amendment A21(c) — without it every 7B group test is a lint violation'
need_repo tests/invariants/test-07-one-costing-answer.test.ts 'acceptance test 7' \
  '3D T11 — 7B Task 7 re-runs it UNCHANGED'
need_repo tests/regression/sah-055.test.ts 'SAH-055' \
  '3B §3.7.3 — 7B Task 14 APPENDS to it'

# ── Three facts, reported and not failed on ────────────────────────────────────────────────────────────
echo "--- informational ---"
echo -n "ReportCodeSchema members: "
awk '/export const ReportCodeSchema = z.enum\(\[/{on=1;next} on&&/\]\);/{on=0} on&&/^  "/{n++} END{print n+0}' \
  packages/contracts/src/accounting/reports.ts 2>/dev/null || echo "?"
echo -n "report definition directories: "
dirs=$(find packages/db/seed/my/reports -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tr '\n' ' ')
echo "${dirs:-none}"
echo -n "0077 taken? "
ls packages/db/migrations/0077* 2>/dev/null || echo "no"

if [ "$fail" -ne 0 ]; then
  echo "7B Task 0 gate FAILED"
  exit 1
fi
echo "7B Task 0 gate OK."
