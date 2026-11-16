#!/usr/bin/env bash
# scripts/check/contracts-6d-amendments.sh — 6D's Task 0 gate. Exits 0 only when every name this slice
# extends exists in the repository with the spelling this plan was written against.
set -u
CONTRACTS="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0

need_repo() {  # need_repo "<label>" <path> "<literal>"
  if [ ! -f "$2" ]; then printf 'MISSING (repo): %-42s no file %s\n' "$1" "$2"; fail=1; return; fi
  if ! grep -qF -- "$3" "$2"; then printf 'MISSING (repo): %-42s %s lacks "%s"\n' "$1" "$2" "$3"; fail=1; fi
}
need_dir() {   # need_dir "<label>" <dir> "<literal>"  — the literal anywhere under the directory
  if ! grep -rqF -- "$3" "$2" 2>/dev/null; then printf 'MISSING (repo): %-42s nothing under %s contains "%s"\n' "$1" "$2" "$3"; fail=1; fi
}
need_doc() {   # need_doc "<label>" "<literal>"
  if ! grep -qF -- "$2" "$CONTRACTS"; then printf 'MISSING (doc): %-43s "%s"\n' "$1" "$2"; fail=1; fi
}
need_repo_owned() {  # need_repo_owned "<label>" <path> "<literal>" "<remedy sentence>"
  # Same check as need_repo, but the literal belongs to ANOTHER slice's file and 6D cannot supply it by
  # renaming anything of its own — so the failure line carries the raise, not "fix your import path".
  if [ ! -f "$2" ] || ! grep -qF -- "$3" "$2"; then
    printf 'MISSING (repo, OWNED ELSEWHERE): %s\n  %s lacks "%s"\n  %s\n' "$1" "$2" "$3" "$4"; fail=1
  fi
}

# ── 6A: the sync seam this slice replaces ─────────────────────────────────────────────────────────────
need_repo "6A applyBatch"            packages/db/src/sync/apply.ts     "export async function applyBatch"
need_repo "6D applyShift seam"       packages/db/src/sync/apply.ts     "applyShift"
need_repo "6D applyTillEvent seam"   packages/db/src/sync/apply.ts     "applyTillEvent"
need_repo "6A BatchOutcome"          packages/db/src/sync/apply.ts     "export interface BatchOutcome"
need_repo "6A MessageOutcome"        packages/db/src/sync/apply.ts     "export interface MessageOutcome"
need_repo "6A TicketInput"           packages/db/src/sync/apply.ts     "export interface TicketInput"
need_repo "6A TicketBatchInput"      packages/db/src/sync/apply.ts     "export interface TicketBatchInput"
need_repo "6A TerminalApplyContext"  packages/db/src/sync/apply.ts     "export interface TerminalApplyContext"
need_repo "6A SyncError"             packages/db/src/sync/enrolment.ts "export class SyncError"
need_repo "6A POS_PERMISSION"        packages/db/src/sync/authority.ts "export const POS_PERMISSION"
need_repo "6A OVERRIDE_SUBJECT_FOR"  packages/db/src/sync/authority.ts "export const OVERRIDE_SUBJECT_FOR"
need_repo "6A ShiftOpenClose"        packages/sync/src/messages.ts     "export interface ShiftOpenClose"
need_repo "6A TillEventMsg"          packages/sync/src/messages.ts     "export interface TillEventMsg"
need_repo_owned "6A document.shift_id" packages/db/migrations/0061_alter_document_add_pos_columns.sql "shift_id" \
  "0061 must add app.document.shift_id — 6A's applyTicket step (f) writes that column on every POS_TICKET, so a 0061 without it cannot pass 6A's own suite and 6A is not green. RAISE against 6A Task 4, whose migration 0061 adds the column under 6A's own Task 0 amendment 6 — the amendment that records this move from 6A's side, as 6D's contracts amendment A2 records it from this one. Do NOT add it in 0070: A2 records why 6D adds neither the column nor a key, and 0070.down.sql cannot be written to be reversible in both worlds."
need_repo "6A tender kind"           packages/db/migrations/0061_alter_document_add_pos_columns.sql "'tender'"
# 2C's 0027 adds `app.document.notes` (contracts §4.3.4) and its FILE NAME is 2C's to choose (§3.4.2),
# so the literal is searched across the whole directory. `buildTillDocument` writes that column.
# NOTE for the reader: 6A's own header insert (its Task 11, `applyTicket` step (f)) names neither `memo`
# nor `notes` — `memo` is a column NO migration creates and 6A's comment says so outright. `notes` is 2C's
# and this slice is the first to write it (Task 5 Step 2's column-list note).
need_dir  "2C document.notes"        packages/db/migrations "add column notes"
need_repo "6A posFixture"            tests/invariants/support/pos.ts   "export async function posFixture"
need_repo "6A SHARED_SHIFT_ID"       tests/invariants/support/pos.ts   "SHARED_SHIFT_ID"
need_repo "6A buildTicket"           tests/invariants/support/pos.ts   "export function buildTicket"
need_repo "6A seedTerminal"          packages/db/test/fixtures.ts      "export async function seedTerminal"
need_repo "6A 1110 cash in till"     packages/db/seed/my/chart-of-accounts/6a-pos-tenders.json "1110"
need_repo "6A POS_TICKET policy"     packages/db/seed/my/document-types/POS_TICKET.json "POS_TICKET"

# ── 6C: the limits, the branch policies and the staff corpus ──────────────────────────────────────────
need_repo "6C verifyTicket"          packages/db/src/sync/limits.ts    "export async function verifyTicket"
need_repo "6C requiredCodesFor"      packages/db/src/sync/limits.ts    "export function requiredCodesFor"
need_repo "6C OVERRIDE_LIFTS"        packages/db/src/sync/limits.ts    "export const OVERRIDE_LIFTS"
need_repo "6C LimitRefusal"          packages/db/src/sync/limits.ts    "export interface LimitRefusal"
need_repo "6C TicketContext"         packages/db/src/sync/limits.ts    "export interface TicketContext"
need_repo "6C actor_in_branch"       packages/db/migrations/0068_create_branch_isolation_policies.sql "actor_in_branch"
need_repo "6C branch_isolation rule" packages/db/src/lint-schema.ts    "branch_isolation_policy"
need_repo "6C paid_out_allowed"      packages/db/migrations/0066_create_branch_pos_policy.sql "paid_out_allowed"
need_repo "6C seedCashier"           packages/db/test/fixtures.ts      "export async function seedCashier"
need_repo "6C seedBranchPosPolicy"   packages/db/test/fixtures.ts      "export async function seedBranchPosPolicy"
need_repo "6C staffFixture"          tests/invariants/support/staff.ts "export async function staffFixture"
need_repo "6C ERR_POS_LIMIT"         packages/contracts/src/errors.ts  "ERR_POS_LIMIT_EXCEEDED"

# ── 6B: the three till-side codes. 6B's migration number is 0063 but its FILE NAME is 6B's to choose,
#    so the literal is searched across the whole migrations directory (§3.4.2's rule, not its guess).
need_dir  "6B pos.shift.own"         packages/db/migrations "pos.shift.own"
need_dir  "6B pos.attendance.clock"  packages/db/migrations "pos.attendance.clock"
need_repo "6B catalogue row"         packages/contracts/permissions.ts "pos.shift.own"

# ── 4B, 1B, 2C: the three registries this slice joins ─────────────────────────────────────────────────
need_repo "4B registerReconcilable"  packages/db/src/ar-ap/reconciliation.ts "export function registerReconcilableSource"
need_repo "4B RECONCILABLE_DIRECTION" packages/db/src/ar-ap/reconciliation.ts "till_banking"
need_repo "1B reportsRouteModule"    apps/api/src/routes/accounting/reports.ts "reportsRouteModule"
need_repo "1B ReportCodeSchema"      packages/contracts/src/accounting/reports.ts "export const ReportCodeSchema"
need_repo "2C MODULE_READ_CODE"      apps/api/src/middleware/require-attachment-read.ts "export const MODULE_READ_CODE"
need_repo "0C seed entry point"        packages/db/src/seed/index.ts "export async function seed"
need_repo "6A effective-date rule"   packages/db/src/sync/apply.ts     "at time zone"

# ── The eighteen contracts amendments this task writes ────────────────────────────────────────────────
need_doc "A1 shift extra keys"        "6D amendment A1"
need_doc "A2 no document.shift_id FK" "6D amendment A2"
need_doc "A3 expected_cash formula"   "6D amendment A3"
need_doc "A4 POS_PERMISSION widened"  "6D amendment A4"
need_doc "A5 report surface"          "6D amendment A5"
need_doc "A6 posFixture shift"        "6D amendment A6"
need_doc "A7 staffFixture members"    "6D amendment A7"
need_doc "A8 role grants"             "6D amendment A8"
need_doc "A9 test 21 location"        "6D amendment A9"
need_doc "A10 no needs_attention"     "6D amendment A10"
need_doc "A11 shifts route module"    "6D amendment A11"
need_doc "A12 no force-close route"   "6D amendment A12"
need_doc "A13 fourth sync array"      "6D amendment A13"
need_doc "A14 till account roles"     "6D amendment A14"
need_doc "A15 series terminal suffix" "6D amendment A15"
need_doc "A16 till_banking_link row"  "6D amendment A16"
need_doc "A17 seedShift options"      "6D amendment A17"
need_doc "A18 MODULE_READ_CODE path"  "6D amendment A18"

if [ "$fail" -ne 0 ]; then
  echo; echo "6D Task 0 gate FAILED."
  echo "  'MISSING (doc)'                   — Step 2 has not been done. Write the amendment."
  echo "  'MISSING (repo)'                  — a reconciliation with the owning plan (§4.18: the written"
  echo "                                      plan is the authority for what it exports). Correct THIS"
  echo "                                      plan's import path or name, and never add a second spelling."
  echo "  'MISSING (repo, OWNED ELSEWHERE)' — a column or literal 6D cannot supply by renaming anything of"
  echo "                                      its own. The line carries its own remedy; follow it, and do"
  echo "                                      NOT rewrite this plan to work around a missing column."
  exit 1
fi
echo "6D Task 0 gate OK."

