#!/usr/bin/env bash
# Gate for slice 5A. Exits 0 only when every contracts amendment has landed and every repo name this
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

need_doc "A1 0054 long file name"      "0054_create_tax_transaction_return_and_document_tax_inclusive.sql"
need_doc "A2 tax_regime.source"        "source text not null"
need_doc "A3 RegimeDefinition"         "RegimeDefinition"
need_doc "A4 PostingErrorCode widened" '"ERR_TAX_REGIME_MISMATCH"'
need_doc "A5 TaxTransactionRow body"   "documentTypeCode; lineNo; taxCodeId"
need_doc "A6 SubPack gains tax"        '"document-types" | "templates" | "tax"'
need_doc "A7 CreateDocumentBody"       "taxInclusive: z.boolean().optional()"
need_doc "A8 5A ships no ReportCode"   "5A ships no ReportCode"
need_doc "A9 support/tax.ts"           "tests/invariants/support/tax.ts"
need_doc "A10 TaxGoldenExpectation"    "TaxGoldenExpectation"
need_doc "A11 zero each_tax group"     "before resolving that rule's \`accountRef\`"
need_doc "A12 DraftLine taxCodeId"     'DraftLine` gains `taxCodeId?: string`'
# A13 carries TWO literals because it registers two independent surfaces, and a half-applied amendment
# is what this gate exists to catch. The second literal NAMES the schema on purpose: a bare
# `taxInclusive: z.boolean()` is a prefix of A7's `taxInclusive: z.boolean().optional()` and would go
# green the moment A7 landed, proving nothing about the READ body.
need_doc "A13a postFromPack options"   'PostFromPackOptions` gains `taxInclusive?: boolean` and `computeTax?: boolean`'
need_doc "A13b DocumentSchema"         'DocumentSchema` gains `taxInclusive: z.boolean()`'

# ── Repository names this plan imports. The OWNING plan is the authority for what it exports (§4.18):
#    a MISSING line here is a reconciliation with that slice, never a second spelling invented locally.
need_repo "2A each_tax + plan.taxLines" packages/domain/src/posting/evaluate.ts 'rule.for === "each_tax"'
need_repo "2A PlannedTaxLine signed"    packages/domain/src/posting/evaluate.ts "taxLines.push"
need_repo "1A lines route"              apps/api/src/routes/accounting/documents.ts "ReplaceLinesBody"
# 3B ships ensureOpenPeriods in post-inventory.ts, NOT in a costing.ts — §4.17.1's row for
# `tests/invariants/support/post-inventory.ts` lists it beside postInventoryDocument and recordingJobs.
need_repo "3B ensureOpenPeriods"        tests/invariants/support/post-inventory.ts "export async function ensureOpenPeriods"
# A12 extends 3C's helper additively; this line proves the helper exists to be extended, exactly as the
# postFromPack line below does for 4B's. It does NOT check for `taxCodeId` — Task 3 is what adds it, so a
# gate that demanded it would exit 1 forever and Task 1 would never start.
need_repo "3C draftTypedDocument"       packages/db/test/fixtures.ts "export async function draftTypedDocument"
need_repo "4A PACK_ROOT"                packages/db/test/ar-ap/_support.ts "export const PACK_ROOT"
need_repo "4A loadTypesFromPack"        packages/db/test/ar-ap/_support.ts "export async function loadTypesFromPack"
need_repo "4B seedTypeFromPack"         tests/invariants/support/ar-ap.ts "export async function seedTypeFromPack"
need_repo "4B postFromPack"             tests/invariants/support/ar-ap.ts "export async function postFromPack"

# ── Two INFORMATIONAL probes. They never fail the gate; they change what T7 and T8 do. Read them.
printf '\n-- informational --\n'
if grep -qF "lines: z.array" packages/contracts/src/accounting/document.ts; then
  printf 'INFO CreateDocumentBody accepts lines at CREATE -- T7 hooks computeDocumentTax in BOTH the\n'
  printf '     create handler and the replace-lines handler, not only the second.\n'
else
  printf 'INFO CreateDocumentBody takes no lines -- T7 hooks computeDocumentTax in the lines handler only.\n'
fi
if grep -nE 'patch\(|method: "patch"' apps/api/src/routes/accounting/documents.ts >/dev/null 2>&1; then
  printf 'INFO a PATCH exists on the documents module -- if it can change effective_date or currency,\n'
  printf '     T7 must recompute tax there too. Read the handler before writing compute.ts.\n'
else
  printf 'INFO no header PATCH on documents (§4.2.7 lists none) -- effective_date and currency are fixed\n'
  printf '     at create, so computing tax when LINES are saved is sufficient and complete.\n'
fi
printf -- '-- step 11 landing site --\n'
grep -n "step 1[012]\|MERGE into\|account_balance" packages/db/src/posting/post.ts | head -20 || true
printf '     ^ read these: T7 inserts tax transactions AFTER the ledger_entry insert and BEFORE the\n'
printf '       account_balance MERGE, as post.ts stands after 3B/4A/4B -- not as §4.3.2 renumbers it.\n'

exit "$fail"
