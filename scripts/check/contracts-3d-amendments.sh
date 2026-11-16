#!/usr/bin/env bash
# scripts/check/contracts-3d-amendments.sh
# Refuses until slice 3D's contract amendments are in the contracts document AND the
# 3A/3B/3C exports this plan consumes exist in the repository. Run from the repo root.
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

# ── the thirteen amendments (fifteen literals) ──────────────────────────
need_doc 'quantity` is the **variance**'                       '3D-1 variance quantity (§4.4.2)'
need_doc 'emits the **opposite** effect at the magnitude'    '3D-2 effect flip (§4.4.2)'
need_doc 'A planned movement whose resolved quantity is zero'  '3D-3 zero-quantity drop (§4.4.2)'
need_doc 'the two movements need not carry the same quantity'  '3D-4 two-quantity transfer (§4.4.2)'
need_doc 'fill?: "cost" | "variance_value"'                    '3D-5 PlannedLedgerLine.fill (§4.4.2)'
need_doc 'fills every planned ledger line carrying a `fill` tag' '3D-6 applyMovements fill rules (§4.7.2)'
need_doc 'costs the **issue** leg first'                       '3D-7 transfer costing order (§4.7.2)'
need_doc 'is valued at `average(openLayers)`'                  '3D-8a null-value receipt (§4.7.1)'
need_doc 'does not raise** for the quantity no open layer covers' '3D-8b allowNegative (§4.7.1)'
need_doc 'gain `countedQuantity` and `expectedQuantity`'       '3D-9 wire fields (§4.3.4) — NOT §4.4.2 A9, the frozen sign contract this slice consumes'
need_doc '| `COUNT_TEST` | 3D'                                 '3D-10 COUNT_TEST row (§4.14)'
need_doc 'TRANSFER_RECEIPT` variance legs'                     '3D-11a 5110 resolved-by (§4.15)'
need_doc '`accounting.sales.create` → `user`'                  '3D-11b role grants (§3.6.4)'
need_doc 'secondPrincipal(db, s, label: string): Promise<string>' '3D-12 secondPrincipal export (§4.17.1)'
need_doc '3D adds `stockOnHand`'                               '3D-13 the 3D read functions (§4.16.3)'

# ── the consumed-export gate ────────────────────────────────────────────
# Every name below is copied from the WRITTEN 3A/3B/3C plans, which are the authority for what they
# export. The 3D card's prose named three of them wrongly; do not "fix" this list back to the prose.
need_grep packages/db/src/documents/link.ts \
  'export .*linkFulfilment' '3C: linkFulfilment (NOT createDocumentLink)'
need_grep packages/db/src/documents/link.ts \
  'export .*openQuantity' '3C: openQuantity (NOT documentOpenQuantity — that is the view mirror)'
need_grep packages/db/src/documents/link.ts \
  'export .*listLinks' '3C: listLinks'
need_grep packages/db/src/documents/link.ts \
  'OpenQuantityRow' '3C: OpenQuantityRow'
need_grep packages/db/migrations/0037_create_document_link.sql \
  '^[[:space:]]*quantity[[:space:]]+numeric\(19,6\)' '3C: document_link.quantity (NOT linked_quantity)'
need_grep packages/db/migrations/0037_create_document_link.sql \
  'open_quantity' '3C: the app.document_open_quantity view'
# 3A renamed this migration: the 3D plan text names 0031_create_inventory_movement_stock_on_hand.sql,
# which does not exist. The real file is the one below, and the plan's own header flags this rename as
# the one downstream grep it orphans. The checked FACTS are unchanged.
need_grep packages/db/migrations/0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql \
  'pick_lots_fefo' '3A: app.pick_lots_fefo'
need_grep packages/db/migrations/0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql \
  'lot_id uuid, *quantity numeric\(19,6\)' '3A: pick_lots_fefo returns (lot_id, quantity)'
# The TypeScript half of the same check. Task 5 imports the wrapper by PATH, so a correct SQL function in a
# file this script never greps would still leave Task 5 Step 5 dying on a module-not-found. 3A ships both
# names from `lots.ts` (3a:114, 3a:6534, 3a:6795) and ships no `fefo.ts`; do not "fix" this back to one.
need_grep packages/db/src/inventory/lots.ts \
  'export .*pickLotsFefo' '3A: pickLotsFefo (packages/db/src/inventory/lots.ts, NOT fefo.ts)'
need_grep packages/db/src/inventory/lots.ts \
  'FefoPick' '3A: FefoPick (same file)'
need_grep packages/db/test/fixtures.ts \
  'export async function draftTypedDocument' '3C: draftTypedDocument (§4.17)'
for n in postInventoryDocument postOverriddenIssue recordingJobs ensureOpenPeriods secondPrincipal; do
  need_grep tests/invariants/support/post-inventory.ts "export .*$n" "3A/3B: $n (§4.17.1)"
done
# The load-bearing one: §4.7.2 costs through costingEngine.cost() BEFORE the movement insert, so an
# over-issue dies in the engine before assert_stock_available can read the override event. 3B closes
# that with CostingInput.allowShortfall. No string here means Tasks 6 and 11 are blocked on 3B.
need_grep packages/db/src/costing/apply-movements.ts \
  'negative_stock\.override' '3B: applyMovements sets allowShortfall from the override event (F-6)'
need_grep packages/db/src/costing/apply-movements.ts \
  'export .*openLayersFor' '3B: openLayersFor — the ONE open-layer reader'
need_grep packages/db/src/costing/valuation.ts \
  'export .*valuationAsOf' '3B: valuationAsOf — the ONE valuation read (spec:1228)'
need_file packages/db/seed/my/document-types/GOODS_RECEIPT.json '3C: the receipt this slice creates stock with'
need_file packages/db/seed/my/document-types/PURCHASE_RETURN.json '3C: test 7 supplier-return leg'
need_grep packages/db/seed/my/chart-of-accounts/3c-purchasing.json '"1310"' '3C: account 1310 goods in transit'
need_grep packages/db/seed/my/chart-of-accounts/3c-purchasing.json '"5100"' '3C: account 5100 expiry loss'

if [ "$fail" -ne 0 ]; then
  echo
  echo "Slice 3D cannot start. Land the contracts amendments (Task 0) and reconcile the"
  echo "3A/3B/3C exports above with their owning plans. Do NOT work around a missing export."
  exit 1
fi
echo "contracts-3d-amendments: ok"
