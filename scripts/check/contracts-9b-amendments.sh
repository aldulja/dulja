#!/usr/bin/env bash
# scripts/check/contracts-9b-amendments.sh — 9B's Task 0 gate. Run from anywhere. Exits 0 only when every amendment of
# round 20 is in the contracts document AND every predecessor surface this slice consumes is in the repository with
# the spelling the amendments record (C16 is where the plan and the tree disagreed). A MISSING (repo) line is never
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

refuse_contract() { # refuse_contract <literal> <why it must be gone>
  if grep -qF -- "$1" "$CONTRACTS"; then
    echo "STALE (doc): $1 — $2"
    fail=1
  fi
}

# ── The amendments of round 20 (9B C1–C16), each where it is applied ──────────────────────────────────────────────
need_contract 'Round 20 — Phase 9B contracts' round-20
need_contract 'issued through the posting service in the dedicated cut-over series `OB` and `OS` of §4.14** (C1, round 20' C1
refuse_contract 'issued through the posting service in a dedicated series `LEGACY`**' 'C1 replaced the unregistered LEGACY literal'
need_contract '| `/v1/jobs` | `jobStatusRoutes` (module const `jobStatusRouteModule`) | 9B |' C2
need_contract '*Narrowed by round 20 C2 (9B, 2026-11-13; quoted there): 9B mounts `/v1/jobs/{jobId}` as the generic job-status resource.*' C2
need_contract '9B mounts `/v1/jobs/{jobId}` as the generic job-status resource; a slice with a resource of its own' C2
need_contract '"admin.import.run": { companyId: string; runId: string; cutOverDate: string; dryRun: boolean; only?: string[] };' C3
need_contract '| `/v1/companies/:companyId/imports` | `importRoutes` (module const `importRouteModule`) | 9B | `admin.company.manage`' C4
need_contract '| `seedImportBatch(db, s, opts: { sourceTable; sourceKey; targetTable; targetId; runId? })` | **9B** | `string` |' C5
need_contract '| `tests/invariants/support/cut-over.ts` | **9B** |' C6
need_contract '**`source_hash text not null`** (the sha256 of the mapped source payload' C7
need_contract 'readonly sourceColumns: readonly SourceColumn[];                      // C8' C8
need_contract 'readonly sourceKey: (row: S) => string;' C8
need_contract 'artefacts: ArtefactIndex /* C9 */' C9
need_contract '| `LEGACY_ODBC_DSN` | importer CLI, **worker** | 9A; **9B widens the holder** (C10, round 20) |' C10
need_contract '| `LEGACY_MPOS_DSN` | importer CLI **only** | 9A |' C10
need_contract 'and the `OPENING_STOCK` credit leg (C11, round 20)' C11
need_contract 'map(row: S, refs: RefResolver): T | { skip: string } | Promise<T | { skip: string }>;            // C12' C12
need_contract 'readonly wholeTable?: boolean;' C13
need_contract 'dryRun: boolean; only?: string[] /* C14 */ }' C14
need_contract 'skips?: readonly SkipRecord[] /* C15 */' C15
need_contract '**9B C16 — the tree as Phases 0–9A merged it.**' C16
need_contract '**`import_batch` is pinned whole in `NEVER_EXPORTED` as plumbing**' C16
need_contract '**`packages/db` raises import refusals through `ImportBatchError`**' C16
need_contract '**9B C17 — §3.4.1, §4.2.7, §4.6.1, §4.13.2 (9B Task 9, 2026-11-13).**' C17
need_contract '| `LEGACY_IMPORT_TARGET` | importer CLI, **worker** | **9B review** (C19, round 20) |' C19
need_contract '**9B C19 — §3.11, §4.2.4, §4.13.2 (9B review, finding 1; 2026-11-14).**' C19
need_contract '| `ERR_IMPORT_SOURCE_NOT_BOUND` | 403 | `assertImportTarget`' C19
need_contract '**9B C20 — §4.2.7, §4.13.2 (9B review, finding 4; 2026-11-14).**' C20
need_contract '**9B C21 — §4.13.2 (9B review, finding 5; 2026-11-14).**' C21
need_contract '// + heartbeat?: () => Promise<void>   (C21, round 20' C21
need_contract '**9B C22 — §4.2.7 (9B review, finding 7; 2026-11-14).**' C22
need_contract '**9B C23 — §4.13.1 (9B review, finding 8; 2026-11-14).**' C23
need_contract '| 9B C23 | 4.13.1 |' C23
need_contract '**9B C24 — §4.13.2, §4.14 (9B review, finding 3; 2026-11-14).**' C24
need_contract '| 9B C24 | 4.13.2, 4.14 |' C24
need_contract '**`0103_create_import_run.sql` (Task 9, C17, round 20)**' C17
need_contract '| `import_run` | 9B / 0103 | **C17, round 20**' C17
need_contract '**`unique index import_run_one_live_per_company (company_id) where status in (' C17

# ── 9A: the importer barrel the loaders consume (§4.13.1) ─────────────────────────────────────────────────────────
need_repo packages/importer/src/index.ts 'createReader' '9A T4 — the reader every loader reads through'
need_repo packages/importer/src/index.ts 'FixtureLegacyDriver' '9A T1 — the corpus driver every 9B test runs on (OD-17 default)'
need_repo packages/importer/src/index.ts 'ReportWriter' '9A T5 — the artefact writer C9 hashes'
need_repo packages/importer/src/index.ts 'ArtefactIndex' '9A T5 — the manifest type C9 returns'
need_repo packages/importer/src/snapshot.ts 'export const NEVER_READ: ReadonlySet<string> = new Set(["USERS.PASSWORD", "USERS.PIN"]);' \
  '9A T14 — the credential deny-list Task 12 asserts, package-internal (C16 item 13)'
need_repo packages/importer/src/index.ts 'employeeMapping' '9A T11 — the employee mapping Task 8 consumes'
need_repo packages/importer/src/reader.ts 'export interface LegacyReader' '9A T4 — LegacyReader, verbatim from §4.13.1'

# ── 0B/0D/1A/8A/8C: the job, the posting service, the HR surfaces the loaders write through ─────────────────────────
need_repo packages/db/src/jobs/names.ts '"admin.import.run": { schedule: null, owner: "9B" }' '0B §4.2.6 — the one job 9B owns (C3)'
need_repo packages/db/src/jobs/payloads.ts 'export interface JobPayload' '0D — the payload map C3 extends'
need_repo packages/db/src/posting/issue.ts 'definition.numbering.series' '1A — the series comes from the policy (C1)'
need_repo packages/db/src/posting/post.ts 'export async function postDocument(' '1A — the one writer of ledger and movement rows'
need_repo packages/db/src/hr/opening.ts 'export async function upsertEmployeeYtdOpening(' '8C T9 — the cut-over YTD openings'
need_repo packages/db/src/hr/keys.ts 'export function createHrKeyRing(' '8A T3 — the HR key ring'
need_repo packages/db/test/fixtures.ts 'export async function seedEmployee(' '6C/8A — seedEmployee'
need_repo packages/db/test/harness.ts 'export async function withTenant<T>(' '0A — the 4-argument DB-tier withTenant (C16 item 10)'
need_repo tests/support/regression.ts 'export function sliceRegression(' '0B — how a slice appends to a regression file (C16 item 10)'
need_repo tests/support/api.ts 'export function sharedApi()' '0B — the memoised API C6 builds on'

# ── 7A/7C: the resources C2 narrows around, and the export registry C16 item 6 classifies against ───────────────────
need_repo apps/api/src/routes/admin/exports.ts 'statusUrl: `/v1/companies/${companyId}/exports/${exportJobId}`' \
  '7C — the export keeps its own status resource (C2 precondition)'
need_repo apps/api/src/routes/accounting/reports.ts 'statusUrl: `/v1/companies/${companyId}/report-runs/${runId}`' \
  '7A — a report run keeps its own status resource (C2 precondition)'
need_repo packages/db/src/export/tables.ts 'export const NEVER_EXPORTED' '7C — the export registry (C16 item 6)'
need_repo packages/db/src/export/tables.ts 'export const EXPORT_TABLES' '7C — the export registry (C16 item 6)'
need_repo apps/edge/src/container-env.ts 'export function containerSecrets(' '0C — where C10 lands (C16 item 1)'

if [ "$fail" -ne 0 ]; then
  echo "9B Task 0 gate FAILED"
  exit 1
fi
echo "9B Task 0 gate OK."
