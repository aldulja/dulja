#!/usr/bin/env bash
# scripts/check/contracts-4a-amendments.sh
# Refuses until slice 4A's contract amendments are in the contracts document AND the
# 3A-3D exports this plan consumes exist in the repository. Run from the repo root.
set -uo pipefail
C="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0
need_doc() {  # need_doc <fixed string> <what it is>
  if ! grep -qF -- "$1" "$C"; then echo "MISSING (contracts): $2 — expected the literal: $1"; fail=1; fi
}
need_file() { if [ ! -f "$1" ]; then echo "MISSING (repo): $1 — $2"; fail=1; fi }
need_grep() {  # need_grep <file> <ERE> <what it is>
  if [ ! -f "$1" ]; then echo "MISSING (repo): $1 — $3"; fail=1;
  elif ! grep -qE -- "$2" "$1"; then echo "MISSING (repo): $3 — $1 has no match for /$2/"; fail=1; fi
}
need_fixed() {  # need_fixed <file> <FIXED string> <what it is> — for text that is itself a regex
  if [ ! -f "$1" ]; then echo "MISSING (repo): $1 — $3"; fail=1;
  elif ! grep -qF -- "$2" "$1"; then echo "MISSING (repo): $3 — $1 has no literal: $2"; fail=1; fi
}

# ── the seventeen amendments (twenty-five literals) ────────────────────
need_doc 'The seeded shape is `none`'                            'A1a the SALES_INVOICE cell (§4.14)'
need_doc 'would send the returned stock **out** a second time'   'A1b the SALES_CREDIT_NOTE cell (§4.14)'
need_doc '| `CREDIT_TEST` | 4A'                                  'A2 the CREDIT_TEST row (§4.14)'
need_doc 'resolve to `cost.negate()` when the source line'       'A3 the negative-quantity cost rule (§4.4.2)'
need_doc 'has no surviving `PlannedMovement`'                    'A4 the unfilled-cost refusal (§4.7.2)'
need_doc 'and by 4A'"'"'s two conversion services'               'A5 who may write document_line.cost (§4.7.2)'
need_doc '0045_alter_party_and_document_add_credit_terms.sql'    'A6a the party additions and the file name (§4.5.7)'
need_doc '(tenant_id, price_list_id) → app.price_list'           'A6b party.price_list_id, 6B A10(b) (§4.5.7)'
need_doc 'the payment term **pinned at draft**'                  'A7 document.payment_term_id (§4.3.4)'
need_doc 'never `party.payment_term_id` as it stands at rebuild' 'A8 the pinned term in ageing (§4.8.2)'
need_doc '`ERR_CREDIT_HOLD` | 422'                               'A9a the new error row (§4.2.4)'
need_doc '**4A adds two**'                                       'A9b the per-slice row list (§4.2.4)'
need_doc 'master data is archived, never deleted'                'A10 payment_term.archived_at (§4.6.1)'
need_doc 'listAllocations(tx, input:'                            'A11a the three allocation names (§4.8.1)'
need_doc 'unallocation_reason text'                              'A11b the reason and unallocated_by columns (§4.8.1)'
need_doc 'allocation_distinct_check'                             'A11c the CHECK 0046 adds (§4.8.1)'
need_doc 'allocation_settlement_idx'                             'A11d the two partial indexes 0046 adds (§4.8.1)'
need_doc 'never `|total − Σ allocations|`'                       'A11e magnitude BEFORE subtraction (§4.8.1)'
need_doc 'a settlement is never a settled document'              'A11f partyBalance reads the ledger (§4.8.1)'
need_doc '**4B registers the `receipt` and `payment` sources'    'A12 the Reconcilable ownership fix (§4.8.3)'
need_doc 'grows `SalesByItemRow` by exactly two members'         'A13 the report extension (§4.16.3)'
need_doc 'postArDocument(db, s, opts: PostArOptions)'            'A14 the AR/AP posting helper (§4.17.1)'
need_doc '| `/v1/companies/:companyId/payment-terms` | `paymentTermRoutes`' \
                                                                 'A15 the new route module row (§4.2.7)'
need_doc '| `accounting/allocation.ts` | `AllocationSchema`'     'A16 the four contract modules (§4.2.8)'
need_doc 'does not compare either, because the union carries'    'A17 the test-22 handoff to 6A (§6.1 row 22)'

# ── the consumed-export gate ───────────────────────────────────────────
# Every name below is copied from the WRITTEN 3A-3D plans, which are the authority for what they
# export. Do NOT "fix" this list back to a card's prose.
for n in linkFulfilment listLinks openQuantity OpenQuantityRow; do
  need_grep packages/db/src/documents/link.ts "export .*$n" "3C: $n (NOT createDocumentLink/documentOpenQuantity)"
done
need_grep packages/db/migrations/0037_create_document_link.sql \
  "'converts_to'" '3C: document_link.link_kind admits converts_to'
need_grep packages/db/migrations/0037_create_document_link.sql \
  "'returns'" '3C: document_link.link_kind admits returns'
need_grep packages/db/migrations/0037_create_document_link.sql \
  'open_quantity' '3C: the app.document_open_quantity view'
need_grep packages/db/test/fixtures.ts \
  'export async function draftTypedDocument' '3C: draftTypedDocument (§4.17)'
need_grep packages/db/test/fixtures.ts \
  'unitPrice' '3C: DraftLine carries unitPrice'
for n in postInventoryDocument secondPrincipal ensureOpenPeriods recordingJobs; do
  need_grep tests/invariants/support/post-inventory.ts "export .*$n" "3A/3B/3D: $n (§4.17.1)"
done
need_grep packages/domain/src/posting/evaluate.ts \
  'fill\?: "cost"' '3D: PlannedLedgerLine.fill (§4.4.2)'
need_grep packages/domain/src/posting/evaluate.ts \
  'COST_AMOUNT_REFS' '3B: the cost amount-reference list Task 4 extends'
need_grep packages/db/src/costing/apply-movements.ts \
  'fill' '3D: the applyMovements fill rules (§4.7.2 A6)'
for n in salesByItem SalesByItemParams SalesByItemRow; do
  need_grep packages/db/src/reports/sales-by-item.ts "export .*$n" "3D: $n (§4.16.3)"
done
need_grep packages/db/seed/my/chart-of-accounts/3d-adjustments.json '"1250"' '3D: account 1250'
need_grep packages/db/seed/my/chart-of-accounts/3c-purchasing.json  '"2150"' '3C: account 2150'
need_grep packages/db/seed/my/document-types/DELIVERY_ORDER.json \
  '"code": "1250"' '3D: DELIVERY_ORDER debits 1250 — the corridor this slice relieves'
need_grep packages/db/seed/my/document-types/GOODS_RECEIPT.json \
  '"code": "2150"' '3C: GOODS_RECEIPT credits 2150 — the corridor this slice relieves'
need_file docs/adr/0044-invoice-is-financial-only-clearing-corridors.md 'ADR 0044 (this task, Step 4)'

# ── the 0D Money parser gate ───────────────────────────────────────────
# This slice parses NEGATIVE money literals out of SQL in four places — `openBalance` and
# `allocateSettlement` read a credit note's negative `total_incl_tax` before taking `.abs()`
# (Task 9), `partyBalance` reads a signed `(debit - credit)` sum (Task 9), and `creditStatus`
# reads a signed `openBase` (Task 3). Every one of them assumes `Money.of()` accepts a leading
# minus. 0D's parser does: `packages/domain/src/money/money.ts` declares
# `const AMOUNT = /^-?\d+(\.\d{1,4})?$/` and 0D's own suite asserts
# `Money.of("-1.0000", MYR).isNegative()`. The gate is `grep -F` on that regex literal — the
# string IS a regex, so it must not go through need_grep — and it is scoped to money.ts so
# Quantity's `{1,6}` twin cannot satisfy it. IF THE GATE FAILS because a later change made the
# parser non-negative, the fallback for all four sites is `Money.of(magnitude).negate()` —
# strip the minus in SQL with `abs()`, parse the magnitude, negate in TypeScript — and NOT a
# second parser in this slice.
need_fixed packages/domain/src/money/money.ts 'const AMOUNT = /^-?\d+(\.\d{1,4})?$/' \
  '0D: Money.of parses a NEGATIVE literal (money.ts AMOUNT) — Tasks 3 and 9 depend on it'

if [ "$fail" -ne 0 ]; then
  echo
  echo "Slice 4A cannot start. Land the contracts amendments (Task 0) and reconcile the"
  echo "3A-3D exports above with their owning plans. Do NOT work around a missing export."
  exit 1
fi
echo "contracts-4a-amendments: ok"
