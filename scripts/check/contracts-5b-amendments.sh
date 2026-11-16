#!/usr/bin/env bash
# scripts/check/contracts-5b-amendments.sh
# Slice 5B's pre-flight. Two halves: the thirteen contracts amendments of Task 0, and the repository
# names Tasks 1-11 import from 5A, 4B and 3B. Exit 1 on the first missing thing.
#
# 5A's plan file did not exist when this plan was written, so its names came from the contracts
# registry. This script is where that assumption is tested, once, before any code depends on it.
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

note() { echo "NOTE: $*"; }

# ── The thirteen amendments ───
need_contract 'ERR_EINVOICE_TRANSMITTER_UNAVAILABLE' 1
need_contract 'ERR_EINVOICE_STATUS_ILLEGAL' 1
need_contract 'ERR_EINVOICE_NOT_ENABLED' 1
# Amendments 2 and 5 are searched by a fragment that stops BEFORE the pipe. Both sentences contain a
# `|`, and markdown forces `\|` inside a table cell — a `grep -qF` for the raw form would report
# MISSING against text that is present. Amendment 2's key belongs in §4.2.6's JobPayload code fence
# and amendment 5's vocabulary sentence outside any table; the amendment rows say so, and these two
# checks are written so that either spelling of the pipe still passes.
need_contract '"accounting.tax.submit": { transmissionId: string;' 2
need_contract 'einvoice_enqueue_skipped' 3
need_contract '`einvoice_transmission` (5B+)' 3
need_contract '"einvoice": { "type": "boolean", "default": false }' 4
need_contract 'packages/db/einvoice-profiles/<code>.v<n>.json' 5
need_contract 'createHttpTransmitter({ profile, canonicalise, qrPayload, fetchImpl?, env? })' 5
need_contract 'The `transmitter` vocabulary is closed at' 5
need_contract 'einvoice_credential_ref' 6
need_contract 'profile_version int' 6
need_contract '/v1/companies/:companyId/einvoice-transmissions' 7
need_contract 'einvoiceTransmissionRouteModule' 7
need_contract 'accounting.tax.file` → `accountant' 8
need_contract 'EINVOICE_CLIENT_SECRET' 9
need_contract 'tests/invariants/support/einvoice.ts' 10
need_contract 'packages/db/test/support/einvoice-stub.ts' 10
need_contract '"./test/einvoice-stub": "./test/support/einvoice-stub.ts"' 10
need_contract '0057_create_einvoice_transmission_and_alter_company_einvoice.sql' 11
need_contract 'einvoice_transmission` is deliberately not a `DatasetId' 12
need_contract 'tax-returns/{taxReturnId}/file' 13

# ── The consumed names: 5A (twelve named exports, five structural checks) ───
# Task 8 appends `fileTaxReturn` to 5A's returns.ts and one sub-path to 5A's route module, and its
# route reads four more 5A names; Task 10 posts its corpus through 5A's two §4.17.1 helpers. Every
# one is named here so a rename in 5A is found before a line of 5B is written, not at
# `bun run typecheck` in Task 8.
need_repo "packages/db/src/tax/returns.ts" "export async function generateTaxReturn" "5A's return generator (§4.9.1) — T8 appends fileTaxReturn beside it"
need_repo "packages/db/src/tax/returns.ts" "export async function createTaxReturn" "5A's period reservation — T8's twoTaxReturns fixture member calls it"
need_repo "packages/db/src/tax/returns.ts" "export async function getTaxReturn" "5A's single-return read — T8's /file handler builds TaxReturnDetail from it"
need_repo "packages/db/src/tax/returns.ts" "export async function taxReturnTieOut" "5A's tie-out — the fourth member of TaxReturnDetail, which T8's /file response must carry"
need_repo "packages/contracts/src/accounting/tax.ts" "export const TaxReturnDetail" "5A's detail schema — T8's /file route answers it and must match it member for member"
need_repo "apps/api/src/routes/accounting/tax-codes.ts" "export const TAX_PERMISSION" "5A's permission const — T8 appends EINVOICE_PERMISSION.file to taxReturnRouteModule.permissions beside it"
need_repo "apps/api/src/routes/accounting/tax-returns.ts" "taxReturnRoutes" "5A's route module — T8 adds one /file sub-path to it, and adds NO third module"
need_repo "tests/invariants/support/tax.ts" "export async function taxFixture" "5A's fixture (§4.17.1) — T10 posts its corpus through it; note it takes a NAME, not a Seed"
need_repo "tests/invariants/support/tax.ts" "export async function postTaxedDocument" "5A's post helper (§4.17.1) — T10's corpus loop"
need_repo "packages/domain/src/tax/index.ts" "malaysiaPack" "5A's jurisdiction pack (§4.9.1)"
need_repo "packages/domain/src/tax/index.ts" "TaxCodeDef" "5A's tax-code type (§4.9.1)"
need_repo "packages/db/test/fixtures.ts" "seedTaxCode" "5A's fixture helper (§4.17)"
need_repo "packages/contracts/permissions.ts" "accounting.tax.manage" "5A's permission code (§3.6.2)"
if ! ls packages/db/migrations/005[3-6]_*.sql >/dev/null 2>&1; then
  echo "MISSING (repo): no migration in 0053-0056 — 5A's range (§3.4.1) has not been applied"
  fail=1
fi
for t in tax_regime tax_code tax_transaction tax_return; do
  if ! grep -rqF "app.$t" packages/db/migrations/; then
    echo "MISSING (repo): app.$t appears in no migration — 5A's table (§4.9.2)"
    fail=1
  fi
done
if ! grep -rqF "tax_inclusive" packages/db/migrations/; then
  echo "MISSING (repo): document.tax_inclusive appears in no migration — §4.3.4, filled by 5A"
  fail=1
fi
if [ -d tests/golden/tax ]; then
  n=$(find tests/golden/tax -name 'expected.json' | wc -l | tr -d ' ')
  note "tests/golden/tax has $n case(s) — Task 10 Step 3 globs them; 0 means test 26 re-runs vacuously and Task 10 SKIPS with its named message instead of passing."
else
  echo "MISSING (repo): tests/golden/tax/ does not exist — 5A's corpus (§3.7.4), which Task 10 re-runs"
  fail=1
fi
if [ -f tests/regression/sah-020.test.ts ]; then
  note "tests/regression/sah-020.test.ts exists — Task 10 APPENDS a '— 5B' block and edits no earlier block (§3.7.3)."
else
  echo "MISSING (repo): tests/regression/sah-020.test.ts — 5A creates it (§3.7.3); 5B only appends. Raise with 5A rather than creating it here."
  fail=1
fi

# ── The consumed names: 4B (five) ───
need_repo "tests/invariants/support/ar-ap.ts" "export async function arApFixture" "4B's fixture (§4.17.1)"
need_repo "tests/invariants/support/ar-ap.ts" "export async function seedTypeFromPack" "4B's pack reader (§4.17.1)"
need_repo "tests/invariants/support/ar-ap.ts" "export function packApproval" "4B's approval reader (§4.17.1)"
need_repo "tests/invariants/support/ar-ap.ts" "export const PACK_DIR" "4B's ABSOLUTE pack directory with a trailing separator (4B amendment 9). It is PACK_DIR and NOT PACK_ROOT: 4A's PACK_ROOT is the relative 'seed/my' readPackFile takes, and einvoiceFixture reads an envelope by absolute path"
need_repo "tests/invariants/support/ar-ap.ts" "computeTax" "5A amendment A13a's option on PostFromPackOptions — einvoiceFixture's postOptedInDocument needs a TAXED post"

# ── The consumed names: 3B (one) ───
need_repo "tests/invariants/support/post-inventory.ts" "export function recordingJobs" "3B's recording JobClient (§4.17.1) — einvoiceFixture passes it to postFromPack so step 14's enqueue is observable"

# ── Informational: what step 14 looks like today ───
if grep -qF "input.jobs" packages/db/src/posting/post.ts; then
  note "post.ts already reads input.jobs (3B amendment A5) — Task 6 adds a clause, it does not add the parameter."
else
  echo "MISSING (repo): input.jobs is not in packages/db/src/posting/post.ts — 3B amendment A5 has not landed; Task 6 cannot add a clause to a parameter that does not exist."
  fail=1
fi
if grep -qF "SALES_INVOICE" packages/db/seed/my/document-types/SALES_INVOICE.json 2>/dev/null; then
  note "4A's SALES_INVOICE envelope is on disk — einvoiceFixture opts THAT type in at policyVersion + 1."
else
  echo "MISSING (repo): packages/db/seed/my/document-types/SALES_INVOICE.json — 4A's envelope (§4.14), which einvoiceFixture reads"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "5B pre-flight FAILED. Task 1 does not start until this exits 0."
  exit 1
fi
echo "5B pre-flight OK — thirteen amendments landed, every consumed name present."
