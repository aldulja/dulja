#!/usr/bin/env bash
# scripts/check/contracts-6a-amendments.sh — Task 0 contracts and merged names.
# Run from the repository root. --preflight additionally asserts 0059-0062 are free
# and the tender accounts are not seeded yet; omit it after implementation starts.
set -uo pipefail
CONTRACTS="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
preflight=0
if [ "${1:-}" = "--preflight" ]; then preflight=1; fi
fail=0
need() { # need <label> <file> <pattern>
  if [ ! -f "$2" ]; then echo "MISSING FILE  $1 -> $2"; fail=1; return; fi
  if ! grep -qF -- "$3" "$2"; then echo "MISSING NAME  $1 -> $2 :: $3"; fail=1; fi
}
need "0A pos_terminal"        packages/db/migrations/0001_foundations.sql          "create table app.pos_terminal"
need "0A resolve_principal"   packages/db/migrations/0001_foundations.sql          "app.resolve_principal"
need "0B withTenant"          packages/db/src/with-tenant.ts                "export async function withTenant"
need "0B systemContext"       packages/db/src/with-tenant.ts                "export async function systemContext"
need "0B resolvePrincipal"    packages/db/src/with-tenant.ts                "export async function resolvePrincipal"
need "0B buildRoutes"         apps/api/src/routes/index.ts                  "export function buildRoutes"
need "0B TENANT_FREE"         tests/invariants/probes.ts                    "export const TENANT_FREE"
need "0B scope terminal"      apps/api/src/middleware/require-permission.ts 'company: "terminal"'
need "0D JOBS pos.sync.apply" packages/db/src/jobs/names.ts                 '"pos.sync.apply"'
need "0D registerHandler"     apps/worker/src/handler.ts                    "export function registerHandler"
need "1A postDocument"        packages/db/src/posting/post.ts               "export async function postDocument"
need "1A issueDocument"       packages/db/src/posting/issue.ts              "export async function issueDocument"
need "1A loadSnapshot"        packages/db/src/posting/load.ts               "export async function loadSnapshot"
need "2A planMovements"       packages/domain/src/posting/evaluate.ts       "export function planMovements"
need "2A seedDocumentType"    packages/db/test/fixtures.ts                  "export async function seedDocumentType"
need "2A DocumentLineKind"    packages/contracts/src/accounting/document.ts "export const DocumentLineKindSchema"
need "2B recordOverride"      packages/db/src/posting/lifecycle.ts          "export async function recordOverride"
need "2B grantCodes"          packages/db/test/fixtures.ts                  "export async function grantCodes"
need "2B principal_has"       packages/db/migrations/0021_create_document_event.sql "app.principal_has"
need "3A seedItem"            packages/db/test/fixtures.ts                  "export async function seedItem"
need "3A seedWarehouse"       packages/db/test/fixtures.ts                  "export async function seedWarehouse"
need "3A seedPriceList"       packages/db/test/fixtures.ts                  "export async function seedPriceList"
need "3B applyMovements"      packages/db/src/costing/apply-movements.ts    "export async function applyMovements"
need "3B ensureOpenPeriods"   tests/invariants/support/post-inventory.ts    "export async function ensureOpenPeriods"
need "3B postInventoryDoc"    tests/invariants/support/post-inventory.ts    "export async function postInventoryDocument"
need "3C draftTypedDocument"  packages/db/test/fixtures.ts                  "export async function draftTypedDocument"
need "3D secondPrincipal"     tests/invariants/support/post-inventory.ts    "export async function secondPrincipal"
need "5A computeDocumentTax"  packages/db/src/tax/compute.ts                "export async function computeDocumentTax"
need "5A taxFixture"          tests/invariants/support/tax.ts               "export async function taxFixture"
need "5A seedTaxPack"         tests/invariants/support/tax.ts               "export async function seedTaxPack"
# Names the fix pass added to this plan's consumed set — each one is called by real code below.
need "0B ApiRequest idem key" apps/api/test/support/app.ts                  "idempotencyKey"
need "0B AppDeps"             apps/api/src/app.ts                           "export interface AppDeps"
need "0B idempotency mw"      apps/api/src/middleware/idempotency.ts        "export function idempotency"
need "0D JobClient.enqueue"   packages/db/src/jobs/enqueue.ts               "enqueue<N extends JobName>"
need "0D EnqueueOptions"      packages/db/src/jobs/enqueue.ts               "singletonKey"
need "0B savepoint handle"    packages/db/src/with-tenant.ts                "savepoint"
# 3A's 0031 is the file that adds document.warehouse_id, which Task 11's header insert names. 3A's own plan
# records that the card's shorter guess was superseded, so the gate asks for the file 3A actually creates.
need "3A document.warehouse"  packages/db/migrations/0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql "warehouse_id"
# 3B already supplies jobs; 5B already supplies db. 6A reuses both.
need "3B jobs Variables"      apps/api/src/context.ts                       "jobs: JobClient"
# The posting barrel re-exports lifecycle, where 2B's helpers actually live.
need "2B lifecycle barrel"    packages/db/src/posting/index.ts              'export * from "./lifecycle"'
need "2B setEventContext"     packages/db/src/posting/lifecycle.ts          "export async function setEventContext"

# The allocated 6A range must be free at Task 0. Review migrations 0105-0118
# already follow Phase 5, so the highest filename is not its last allocated slot.
if [ "$preflight" -eq 1 ]; then
for n in 0059 0060 0061 0062; do
  if ls packages/db/migrations/${n}_*.sql >/dev/null 2>&1; then echo "RANGE TAKEN   $n"; fail=1; fi
done
fi
last=$(ls packages/db/migrations/ | grep -E '^[0-9]{4}_' | sed 's/_.*//' | sort | tail -1)
echo "highest migration on disk: ${last} (Phase 5 final allocated slot 0058; review tail 0118 is present)"

# The three account codes this slice seeds must NOT already exist in another slice's chart file.
if [ "$preflight" -eq 1 ]; then
for c in 1110 1120 2200; do
  if grep -rq "\"$c\"" packages/db/seed/my/chart-of-accounts/ 2>/dev/null; then echo "ACCOUNT TAKEN $c"; fail=1; fi
done
fi
# 1100 must already be there (0C's) — hazard 33's consume-don't-reseed check.
grep -rq '"1100"' packages/db/seed/my/chart-of-accounts/0c-base.json || { echo "MISSING 1100 (0C)"; fail=1; }


need_contract() { # need_contract <amendment number> <literal>
  if ! grep -qF -- "$2" "$CONTRACTS"; then
    echo "MISSING CONTRACT amendment $1: $2"; fail=1
  fi
}
need_contract 1 'POS_TICKET` vs **`POS_EQUIV_INVOICE`**'
need_contract 2 '6A (**test only**)'
need_contract 3 '6A consumes it and Task 5'
need_contract 4 'Tables: document, pos_terminal, pos_cashier, branch_pos_policy, attendance_event, terminal_enrolment, needs_attention'
need_contract 4 'Tables: price_list, promotion, catalogue_tombstone'
need_contract 5 "revision bigint not null default nextval('app.catalogue_revision_seq')"
need_contract 6 'and `shift_id uuid` (no foreign key, and none is added later in Phase 6)'
need_contract 6 'resolveSeries(tx, documentId, policySeries)'
need_contract 7 'Variables` set is ten members'
need_contract 7 'terminal: TerminalIdentity;'
need_contract 7 'readonly terminalJwtSigningKey: string;'
need_contract 8 'expect: 400 | 401 | 403 | 404'
need_contract 9 'packages/db/src/sync/identity.ts'
need_contract 9 '6A adds the tier'
need_contract 10 'app.resolve_enrolment(p_code_hash bytea)'
need_contract 10 'code_hash bytea not null unique'
need_contract 10 'name text not null'
need_contract 10 'terminalCode }'
need_contract 11 'newCustomer?: NewCustomer | null'
need_contract 11 'export function encodeSyncCursor(c: Cursor): string;'
need_contract 11 'export function decodeSyncCursor(raw: string): Cursor;'
need_contract 11 'export const CATALOGUE_STREAMS: readonly Stream[];'
need_contract 12 'SYNC_BATCH_SYNC_LIMIT = 200'
need_contract 12 'No `statusUrl` is returned'
need_contract 13 '"pos.sync.apply": { terminalId: string; batch: unknown'
need_contract 13 'One registered exception: `pos.sync.apply`'
need_contract 14 'pos.customer.create` → `cashier`'
need_contract 15 'tests/invariants/support/pos.ts'
need_contract 16 '["account","item","tax","text","tender","payroll"]'
need_contract 17 'custom_fields.reference stays in the untyped bag'
need_contract 18 "hashtextextended('sync-batch:' || terminal_id::text, 0)"
need_contract 19 '/v1/sync/enrol` | `enrolmentRoutes`'
need_contract 19 '/v1/companies/:companyId/needs-attention` | `needsAttentionRoutes`'
need_contract 20 'AppDeps` is seven members'
need_contract 20 'terminalJwtSigningKey: Uint8Array'
need_contract 21 'Public routes carry no idempotency'
need_contract 22 'applyBatch(tx: Sql, ctx: TenantContext, terminal: TerminalApplyContext, batch: TicketBatchInput): Promise<BatchOutcome>'
need_contract 23 'opts: { terminalId: string; newBatchId: () => string; batchSize?: number }'
need_contract 23 'export class SyncQueuedError extends Error'
need_contract 23 'Set every member of CATALOGUE_STREAMS to max(changes[].revision)'
need_contract 24 'seedTerminal(db, s, opts?: { code?; branchId?; devicePublicKey? })'
need "5B db Variables"        apps/api/src/context.ts                       "db: Sql"
need "5B migration"           packages/db/migrations/0058_seed_permission_phase5b.sql "accounting.tax.file"
need "review tail"            packages/db/migrations/0118_preserve_exact_cost_layer_value.sql "add column value numeric(19,4)"

if [ "$fail" -eq 0 ]; then echo "6A contracts and consumed-name gate OK (24 amendments)"; fi
exit $fail
