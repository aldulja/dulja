#!/usr/bin/env bash
# Gate for slice 6C. Exits 0 only when every contracts amendment has landed and every repo name this
# plan imports exists with the spelling this plan uses. Run from the repository root.
set -uo pipefail
C="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0

need_doc() {  # need_doc <label> <fixed-string>
  if grep -qF -- "$2" "$C"; then printf 'ok   (contracts) %s\n' "$1"
  else printf 'MISSING (contracts) %s -- expected the literal: %s\n' "$1" "$2"; fail=1; fi
}
need_repo() {  # need_repo <label> <file> <fixed-string>
  if [ -f "$2" ] && grep -qF -- "$3" "$2"; then printf 'ok   (repo) %s\n' "$1"
  else printf 'MISSING (repo) %s -- %s does not carry: %s\n' "$1" "$2" "$3"; fail=1; fi
}

# A1 is probed by the SENTENCE 6A's Task 0 Step 4 appends to §4.5.6's Form C paragraph, never by the bare
# word `terminal_enrolment`: that word is already in the contracts document five times today, so a probe on
# it would print `ok` before any amendment landed and the gate would be lying about the one row it cannot
# afford to be wrong on. A1 is a VERIFICATION of 6A's amendment, not a second edit (see its row above).
need_doc "A1 0068 gains 6A's three tables"  "6A's three tables are attached in 0068 like every other pre-0068 table"
need_doc "A2 BRANCH_ISOLATION_EXEMPT"       "BRANCH_ISOLATION_EXEMPT"
need_doc "A3 AuthAdmin.createUser"          "createUser(email: string): Promise<InvitedUser>"
need_doc "A4 four 6C route modules"         "/v1/companies/:companyId/branch-pos-policies"
need_doc "A5 CASHIER_SNAPSHOT_CODES"        "CASHIER_SNAPSHOT_CODES"
need_doc "A6 cashier_snapshot_drift"        "cashier_snapshot_drift"
need_doc "A7 compare payload"               '"pos.cashier.compare": { companyId?: string }'
need_doc "A8 attendance apply path is 6C's" "the attendance-insert path inside"
need_doc "A9 support/staff.ts"              "tests/invariants/support/staff.ts"
need_doc "A10 pos.attendance.clock is 6B's" "6B adds the server-side"
need_doc "A11 no MODULE_READ_CODE row"      "adds **no** row to"
need_doc "A12 fixtures options"             "principalId?; hiredOn?"
need_doc "A13 buildTicket discount/lines"   "lines?: readonly { sku?; quantity?; unitPrice?; discount? }[]"
need_doc "A14 SyncErrorCode widened"        "SyncErrorCode"
# A15 and A16 are probed by their own markers. A15's body sentence ("or unless the row's table carries a
# `branch_isolation` policy") is word for word 6D's A17, so a probe on it would pass on 6D's amendment and
# say nothing about 6C's; A16's long file name is unique to this amendment and is probed directly as well.
need_doc "A15 fixtures insert as system"    "6C amendment A15."
need_doc "A15 the preamble clause itself"   "or unless the row's table carries a"
need_doc "A16 0067 long name in the card"   "0067_create_attendance_event_and_cashier_snapshot.sql"

# Require each owning amendment marker as well as the consumed signatures above.
# A1 verifies the earlier 6A provenance; A15 records the pre-existing shared system-fixture rule.
for amendment in {2..16}; do
  need_doc "A${amendment} owning amendment" "6C amendment A${amendment}."
done

# ── Repository names this plan imports. The OWNING plan is the authority for what it exports (§4.18):
#    a MISSING line here is a reconciliation with that slice, never a second spelling invented locally.
need_repo "0B AuthAdmin port"        apps/api/src/ports.ts                  "export interface AuthAdmin"
need_repo "0B StubAuthAdmin"         apps/api/src/auth-admin.ts             "export class StubAuthAdmin"
need_repo "0B buildRoutes"           apps/api/src/routes/index.ts           "export function buildRoutes"
need_repo "0B sharedApi"             tests/support/api.ts                   "export function sharedApi"
need_repo "0A lintSchema sets"       packages/db/src/lint-schema.ts         "export const AUDIT_EXEMPT"
need_repo "2A seedParty"             packages/db/test/fixtures.ts           "export async function seedParty"
need_repo "2B grantCodes"            packages/db/test/fixtures.ts           "export async function grantCodes"
need_repo "3A seedWarehouse"         packages/db/test/fixtures.ts           "export async function seedWarehouse"
need_repo "3B ensureOpenPeriods"     tests/invariants/support/post-inventory.ts "export async function ensureOpenPeriods"
need_repo "6A applyBatch"            packages/db/src/sync/apply.ts          "export async function applyBatch"
need_repo "6A TerminalApplyContext"  packages/db/src/sync/apply.ts          "export interface TerminalApplyContext"
need_repo "6A TicketOutcome"         packages/db/src/sync/apply.ts          "export interface TicketOutcome"
need_repo "6A TicketInput"           packages/db/src/sync/apply.ts          "export interface TicketInput"
need_repo "6A SyncError"             packages/db/src/sync/enrolment.ts      "export class SyncError"
need_repo "6A SyncErrorCode"         packages/db/src/sync/enrolment.ts      "export type SyncErrorCode"
need_repo "6A readCatalogue"         packages/db/src/sync/catalogue.ts      "export async function readCatalogue"
need_repo "6A Ticket message"        packages/sync/src/messages.ts          "export interface Ticket"
need_repo "6A TicketEvent"           packages/sync/src/messages.ts          "export interface TicketEvent"
need_repo "6A seedTerminal"          packages/db/test/fixtures.ts           "export async function seedTerminal"
need_repo "6A posFixture"            tests/invariants/support/pos.ts        "export async function posFixture"
need_repo "6A buildTicket"           tests/invariants/support/pos.ts        "export function buildTicket"

# 2B consumes the real lifecycle barrel and owns principal_has in 0021.
# The reconciliation record corrects the copied plan's stale 0022 probe; do not add aliases.
need_repo "2B lifecycle barrel"      packages/db/src/posting/index.ts       'export * from "./lifecycle";'
need_repo "2B recordOverride"        packages/db/src/posting/lifecycle.ts   "export async function recordOverride"
if ls packages/db/migrations/0021_*.sql >/dev/null 2>&1 && \
   grep -qF -- "app.principal_has" packages/db/migrations/0021_*.sql; then
  printf 'ok   (repo) %s\n' "2B principal_has (0021_*.sql)"
else
  printf 'MISSING (repo) %s\n' "2B principal_has -- no packages/db/migrations/0021_*.sql carries app.principal_has"; fail=1
fi

# ── Three INFORMATIONAL probes. They never fail the gate; they change what T5 and T7 do. Read them.
#    (The two probes that asked what applyBatch's parameters and error class are have been PROMOTED to the
#     need_repo lines above: 6A's merged file answers both, and a guess is no longer admissible.)
printf '\n-- informational --\n'
printf -- '-- 1. the branch key of 6A''s three tables (A1: NOT NULL -> Form A, nullable -> Form B) --\n'
grep -nE "branch_id" packages/db/migrations/0060_*.sql packages/db/migrations/0059_*.sql 2>/dev/null || \
  printf '     (no 0059/0060 branch_id lines found -- read the migrations by hand before T5)\n'
printf '     ^ T5 Step 1 reads these three declarations and picks the form. A "not null" is Form A.\n'
printf '       6A ships terminal_enrolment.branch_id NOT NULL, needs_attention.branch_id NOT NULL and\n'
printf '       catalogue_tombstone.branch_id NULLABLE, which is what T5 Step 4 writes; this prints the proof.\n'

printf -- '\n-- 2. the trigger ORDER on app.pos_cashier (T7 depends on it) --\n'
grep -n "tg_argv\|nextval('app.catalogue_revision_seq')" packages/db/migrations/0059_*.sql 2>/dev/null | head -10 || true
printf '     ^ 6A%s app.catalogue_revision() takes the stream as tg_argv[0] and assigns new.revision in a\n' "'s"
printf '       BEFORE trigger. T7 section 3a adds snapshot_revision_stamp, also BEFORE, which PostgreSQL fires\n'
printf '       SECOND because same-event triggers fire in NAME order and "catalogue_revision" sorts first.\n'

printf -- '\n-- 3. where does applyBatch call into per-ticket checks? T4 and T9 insert their seams there --\n'
grep -n "savepoint\|principal_has\|postDocument\|recordOverride\|attendance\|to_regclass" packages/db/src/sync/apply.ts 2>/dev/null | head -24 || true
printf '     ^ read these. The limit check runs AFTER step (c)%s authority check and AFTER step (f)%s lines,\n' "'s" "'s"
printf '       and BEFORE step (h)%s recordOverride loop, inside the same savepoint. 6A step (h) ALREADY\n' "'s"
printf '       records every TicketEvent -- T9 adds no second recordOverride call (see T9 Step 5).\n'

exit "$fail"
