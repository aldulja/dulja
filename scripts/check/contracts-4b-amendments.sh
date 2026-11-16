#!/usr/bin/env bash
# scripts/check/contracts-4b-amendments.sh
# Slice 4B's pre-flight. Two halves: the twelve contracts amendments of Task 0, and the seventeen
# repository names Tasks 3-12 import from 4A, 3B, 3C and 3D. Exit 1 on the first missing thing.
set -uo pipefail
CONTRACTS="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0

need_contract() {   # need_contract <literal> <amendment number>
  if ! grep -qF -- "$1" "$CONTRACTS"; then
    echo "MISSING (contracts amendment $2): $1"
    fail=1
  fi
}

need_repo() {       # need_repo <file> <literal> <what it is>
  if [ ! -f "$1" ]; then
    echo "MISSING (repo): $1 does not exist — $3"
    fail=1
  elif ! grep -qF -- "$2" "$1"; then
    echo "MISSING (repo): $2 is not in $1 — $3"
    fail=1
  fi
}

# ── The twelve amendments ───
need_contract 'accounting.projection.rebuild": { companyId?: string; asOf?: string }' 1
need_contract 'pushes a warning onto `PostResult.warnings` and skips the enqueue' 2
need_contract 'app.party_ageing_rows(p_company uuid, p_as_of date)' 3
need_contract 'The tie-out is base-only, and per-currency equality is not claimed' 4
need_contract "custom_fields.fxKind" 5
need_contract 'app.item_profitability_rows(p_company uuid, p_sale_types text[])' 6
need_contract 'SALE_MOVEMENT_TYPES' 6
need_contract 'doc_sign' 7
need_contract '`1150` Cheques in hand' 8
need_contract 'tests/invariants/support/ar-ap.ts' 9
need_contract 'agedBalance' 10
# Amendments 11 and 12 need literals that occur NOWHERE else in the contracts document. Bare
# 'ERR_RATE_NOT_FOUND' would match §4.2.4's registry row and §4.3.8's list, both of which predate
# this slice, so the check is against the widened union's own line and against amendment 12's sentence.
# NOTE the single line: need_contract passes $1 to `grep -F`, and a multi-line pattern there means
# "match ANY of these lines", which would pass on the un-widened union.
need_contract '| "ERR_LEDGER_UNBALANCED" | "ERR_RATE_NOT_FOUND";' 11
need_contract 'may be a bare signed 4-dp decimal string when the row carries its own' 12

# ── The seventeen repository names every later task imports ───
need_repo packages/db/src/ar-ap/index.ts 'export * from "./allocation"' \
  '4A owns this barrel and packages/db/src/index.ts re-exports ./ar-ap — Tasks 3, 5, 6, 7 APPEND to it and never rewrite it. If 4A spells the line differently, adjust this literal; if the file is absent, 4A has not landed and no task past Task 2 may start'
need_repo packages/db/src/ar-ap/allocation.ts 'export async function allocateSettlement' \
  '4A §4.8.1 — Task 5 wraps it'
need_repo packages/db/src/ar-ap/allocation.ts 'export async function partyBalance' \
  '4A §4.8.1 — Task 5 Step 8, test 8 clause 6, asserts its BASE member only'
need_repo packages/db/test/fixtures.ts 'export async function seedPaymentTerm' \
  '4A §4.17 — Task 3 varies due_days with it'
need_repo packages/db/test/fixtures.ts 'export async function draftTypedDocument' \
  '3C §4.17 amendment — every drafting test in this slice'
need_repo packages/db/seed/my/document-types/SALES_INVOICE.json '"code": "SALES_INVOICE"' \
  '4A §4.14 — seedTypeFromPack reads this file'
need_repo packages/db/seed/my/document-types/RECEIPT.json '"code": "RECEIPT"' \
  '4A §4.14 — the settlement side of tests 8 and 39'
need_repo packages/db/seed/my/document-types/PAYMENT.json '"code": "PAYMENT"' \
  '4A §4.14 — the payment side of test 39'
need_repo packages/db/src/posting/post.ts 'jobs?: JobClient' \
  '3B amendment A5 — Task 4 Step 6 adds step 14 through this seam'
need_repo tests/invariants/support/post-inventory.ts 'export async function ensureOpenPeriods' \
  '3B §4.17.1 — every test in this slice that posts outside 2026-01'
need_repo tests/invariants/support/post-inventory.ts 'export async function secondPrincipal' \
  '3D §4.17.1 amendment — Task 12 R1 case'
need_repo packages/db/src/reports/sales-by-item.ts 'cost_consumption' \
  '3D §4.16.3 — amendment 7 uses the identical cost source'
need_repo tests/invariants/support/post-ar.ts 'export async function postArDocument' \
  '4A §4.17.1 — see the RELATIONSHIP note after this script: postFromPack is deliberately not it'
need_repo packages/db/test/ar-ap/_support.ts 'PACK_ROOT' \
  '4A — 4B names its own constant PACK_DIR so the two cannot be confused; see the RELATIONSHIP note after this script'
need_repo packages/db/seed/my/document-types/GOODS_RECEIPT.json '"code": "GOODS_RECEIPT"' \
  '3C §4.14 — Task 4 creates its cost layer with it; postFromPack reads the file for its approval block'
need_repo packages/db/seed/my/document-types/DELIVERY_ORDER.json '"code": "DELIVERY_ORDER"' \
  '3D §4.14 — Task 4 proves a delivery contributes quantity and cost and NO revenue'
need_repo packages/db/seed/my/document-types/EXPIRY_WRITE_OFF.json '"code": "EXPIRY_WRITE_OFF"' \
  '3D §4.14 — Task 4 posts it, and it is the approval-REQUIRED case postFromPack derives its path from'

# ── Three facts, not names: report them, do not fail on them ───  (two of them steer Tasks 3 and 5;
#     the third is belt-and-braces on a guard seedTypeFromPack keeps either way)
echo "--- informational ---"
echo -n "4A due-date column on app.document: "
if grep -rqE 'add column +(due_date|due_days)' packages/db/migrations/004[4-7]_*.sql 2>/dev/null; then
  echo "PRESENT — Task 3 must read it instead of deriving from party.payment_term_id"
else
  echo "absent — Task 3 derives effective_date + coalesce(payment_term.due_days, 0) (amendment 3)"
fi
echo -n "app.document_link INSERT trigger (3C migration 0037): "
if grep -qE 'create trigger .* on app\.document_link' packages/db/migrations/0037_*.sql 2>/dev/null; then
  echo "PRESENT — Task 5 must not insert document_link directly; use the fxKind probe alone"
else
  echo "absent — Task 5 may insert the 'settles' link row directly (amendment 5)"
fi
echo -n "2A seedDocumentType is idempotent: "
if grep -qE 'on conflict' packages/db/test/fixtures.ts 2>/dev/null &&
   grep -A12 'export async function seedDocumentType' packages/db/test/fixtures.ts 2>/dev/null |
     grep -qE 'on conflict'; then
  echo "yes (on conflict) — seedTypeFromPack's select-or-insert guard is belt and braces"
else
  echo "no — seedTypeFromPack's select-or-insert guard is REQUIRED; postFromPack calls it per post"
fi

[ "$fail" -eq 0 ] && echo "contracts-4b: OK"
exit "$fail"
