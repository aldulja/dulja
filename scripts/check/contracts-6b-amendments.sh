#!/usr/bin/env bash
# Gate for slice 6B. Exits 0 only when every contracts amendment has landed and every repository name this
# plan imports exists with the spelling this plan uses. Run from the repository root.
set -uo pipefail
C="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0

need_doc() {  # need_doc <label> <fixed-string>
  # An EMPTY needle would make `grep -qF -- ""` match every line of any non-empty file, so a quoting slip
  # (a backtick-bearing needle written inside DOUBLE quotes is command substitution, and an unknown command
  # substitutes the empty string) would print `ok` for an amendment that never landed. Refuse it loudly.
  if [ -z "$2" ]; then printf 'BAD CHECK  (contracts) %s -- empty needle; quote it with SINGLE quotes\n' "$1"; fail=1; return; fi
  if grep -qF -- "$2" "$C"; then printf 'ok   (contracts) %s\n' "$1"
  else printf 'MISSING (contracts) %s -- expected the literal: %s\n' "$1" "$2"; fail=1; fi
}
need_repo() {  # need_repo <label> <file> <fixed-string>
  if [ -f "$2" ] && grep -qF -- "$3" "$2"; then printf 'ok   (repo) %s\n' "$1"
  else printf 'MISSING (repo) %s -- %s does not carry: %s\n' "$1" "$2" "$3"; fail=1; fi
}

need_doc "A1 0063 is a permission seed"      "0063_alter_item_seed_permission_phase6b.sql"
need_doc "A2 signing.ts is the one spelling" "packages/sync/src/signing.ts"
need_doc "A3 the ./staff/pin subpath"        '"./staff/pin"'
need_doc "A4 the bridge surface"             "DuljaPosBridge"
need_doc "A4 registerPosHandlers"            "registerPosHandlers"
need_doc "A5 the second builder config"      "electron-builder.pos.yml"
need_doc "A5 the pos feed variable"          "DULJA_POS_UPDATE_FEED"
need_doc "A6 the four ERR_TILL rows"         "ERR_TILL_PIN_INVALID"
need_doc "A7 support/till.ts"                "tests/invariants/support/till.ts"
need_doc "A8 the eight mirrors"              "catalogue_branch_pos_policy"
need_doc "A8d pending_customer"              'pending_customer(id, code, name_en, name_ar, phone, created_at, acked_at)'
need_doc "A9 rounding has no account"        "POS cash rounding is absorbed into the ticket"
# ⚠️ SINGLE quotes on the next two. Backticks inside DOUBLE quotes are command substitution: bash would try
# to run `app.item.tax_code_id`, print "command not found" to stderr, substitute the empty string, and — but
# for `need_doc`'s empty-needle guard above — `grep -qF -- ""` would then match every line of the contracts
# document and print `ok` whether or not A10 had landed. `set -uo pipefail` carries no `-e`, so the failed
# substitution would not abort either. A10 is the one register change this plan discovered rather than
# inherited, which makes a silently-passing check for it the worst one in the file to have.
need_doc "A10 item.tax_code_id"              '`app.item.tax_code_id`'
need_doc "A10 party.price_list_id"           '`app.party.price_list_id`'

# ── Repository names this plan imports. The OWNING plan is the authority for what it exports (§4.18):
#    a MISSING line here is a reconciliation with that slice, never a second spelling invented locally.
need_repo "0B startApi"            apps/api/test/support/app.ts                  "export async function startApi"
need_repo "0B sharedApi"           tests/support/api.ts                          "export function sharedApi"
need_repo "0B sourceFiles"         tests/support/source.ts                       "export function sourceFiles"
need_repo "0D Money"               packages/domain/src/money/money.ts            "export class Money"
need_repo "0D Quantity"            packages/domain/src/money/quantity.ts               "export class Quantity"
need_repo "0D round"               packages/domain/src/money/rounding.ts         "export function round"
need_repo "0E browserWindowOptions" apps/desktop/src/window-options.ts           "export function browserWindowOptions"
need_repo "0E CONTENT_SECURITY_POLICY" apps/desktop/src/window-options.ts        "CONTENT_SECURITY_POLICY"
need_repo "0E DuljaBridge"         apps/desktop/src/bridge-types.ts              "export interface DuljaBridge"
need_repo "0E CHANNELS"            apps/desktop/src/bridge-types.ts              "export const CHANNELS"
need_repo "0E createSecureStore"   apps/desktop/src/secure-store.ts              "export function createSecureStore"
need_repo "0E configureUpdater"    apps/desktop/src/updater.ts                   "export function configureUpdater"
need_repo "0E asarUnpack sqlite"   apps/desktop/electron-builder.yml             "better-sqlite3"
need_repo "0E DirectionProvider"   packages/ui/src/direction.tsx                 "DirectionProvider"
need_repo "0E formatMoney"         packages/i18n/src/format.ts                   "export function formatMoney"
need_repo "5A taxEngine"           packages/domain/src/tax/index.ts              "taxEngine"
need_repo "6A CATALOGUE_STREAMS"   packages/sync/src/messages.ts                 "export const CATALOGUE_STREAMS"
need_repo "6A SyncStore"           packages/sync/src/client.ts                   "export interface SyncStore"
need_repo "6A SyncTransport"       packages/sync/src/client.ts                   "export interface SyncTransport"
need_repo "6A OutboxRow"           packages/sync/src/client.ts                   "export interface OutboxRow"
need_repo "6A pullAll"             packages/sync/src/client.ts                   "export async function pullAll"
need_repo "6A drainOutbox"         packages/sync/src/client.ts                   "export async function drainOutbox"
need_repo "6A SyncQueuedError"     packages/sync/src/client.ts                   "export class SyncQueuedError"
need_repo "6A shiftRef"            packages/sync/src/messages.ts                 "export function shiftRef"
need_repo "6A encodeSyncCursor"    packages/sync/src/cursor.ts                   "export function encodeSyncCursor"
need_repo "6A posFixture"          tests/invariants/support/pos.ts               "export async function posFixture"
need_repo "6A syncRequest"         tests/invariants/support/pos.ts               "export async function syncRequest"
need_repo "6A buildTicket"         tests/invariants/support/pos.ts               "export function buildTicket"
need_repo "6A seedTerminal"        packages/db/test/fixtures.ts                  "export async function seedTerminal"
need_repo "6A POS_TICKET envelope" packages/db/seed/my/document-types/POS_TICKET.json "\"code\": \"POS_TICKET\""
need_repo "6A enrol route"         apps/api/src/routes/sync/enrolments.ts        "/v1/sync/enrol"
need_repo "6C verifyPin"           packages/db/src/staff/pin.ts                  "export async function verifyPin"
need_repo "6C CashierSnapshot"     packages/db/src/staff/cashier.ts              "export interface CashierSnapshot"
need_repo "6C CashierLimits"       packages/db/src/staff/cashier.ts              "export interface CashierLimits"
need_repo "6C verifyTicket"        packages/db/src/sync/limits.ts                "export async function verifyTicket"
need_repo "6C OVERRIDE_LIFTS"      packages/db/src/sync/limits.ts                "export const OVERRIDE_LIFTS"
need_repo "6C seedCashier"         packages/db/test/fixtures.ts                  "export async function seedCashier"
need_repo "6C seedBranchPosPolicy" packages/db/test/fixtures.ts                  "export async function seedBranchPosPolicy"
need_repo "6C staffFixture"        tests/invariants/support/staff.ts             "export async function staffFixture"
need_repo "6C branch_pos_policy"   packages/db/migrations/0066_create_branch_pos_policy.sql "rounding_increment"

# Persistent gate: before T4 the range/codes are free; afterwards exactly this slice owns them.
shopt -s nullglob
migration_files=(packages/db/migrations/0063_*.sql)
if [ "${#migration_files[@]}" -gt 0 ]; then
  if [ "${#migration_files[@]}" -ne 1 ] || [ "${migration_files[0]}" != "packages/db/migrations/0063_alter_item_seed_permission_phase6b.sql" ]; then
    echo "RANGE CONFLICT 0063"; fail=1
  else
    need_repo "0063 item tax assignment" "${migration_files[0]}" "tax_code_id"
    for code in pos.price.check pos.shift.own pos.attendance.clock; do
      need_repo "0063 permission $code" "${migration_files[0]}" "$code"
      need_repo "6B catalogue $code" packages/contracts/permissions.ts "\"$code\""
    done
    need_repo "0063 paired down" packages/db/migrations/0063.down.sql "tax_code_id"
  fi
else
  for code in pos.price.check pos.shift.own pos.attendance.clock; do
    if grep -qF -- "\"$code\"" packages/contracts/permissions.ts; then
      printf 'CODE WITHOUT MIGRATION %s\n' "$code"; fail=1
    fi
  done
fi
for amendment in {1..10}; do
  need_doc "A${amendment} owning amendment" "6B amendment A${amendment}."
done

# ── Three INFORMATIONAL probes. They never fail the gate; they change what T2, T5 and T9 do. Read them.
printf '\n-- informational --\n'
printf -- '-- 1. the exact column list of each catalogue stream table, which the mirrors extract from --\n'
grep -nE "^\s+(code|barcode|name_en|name_ar|base_unit_id|track_lots|unit_price|min_quantity|starts_at|ends_at|rate|rounding_mode|archived_at)" \
  packages/db/migrations/0028_*.sql packages/db/migrations/0030_*.sql packages/db/migrations/0053_*.sql 2>/dev/null | head -40 || true
printf '     ^ T2 Step 3 extracts EXACTLY these names out of `to_jsonb(row) - tenant_id`. A mirror column\n'
printf '       spelled differently silently misses every lookup and nothing throws.\n'

printf -- '\n-- 2. what app.pos_cashier_sync and app.branch_pos_policy_sync actually return --\n'
grep -n -A12 "pos_cashier_sync\|branch_pos_policy_sync" packages/db/migrations/0066_*.sql packages/db/migrations/0067_*.sql 2>/dev/null | head -40 || true
printf '     ^ T2 and T4 read the `row` jsonb these two functions emit. 6C is the authority for its keys.\n'

printf -- '\n-- 3. does apps/desktop already build a second target, and where does main.ts read RENDERER_DIR --\n'
grep -n "RENDERER_DIR\|extraResources\|extraMetadata\|productName" apps/desktop/src/main.ts apps/desktop/electron-builder.yml 2>/dev/null | head -20 || true
printf '     ^ T9 and T10 mirror this shape for pos.exe and edit NEITHER of these two files.\n'

exit "$fail"
