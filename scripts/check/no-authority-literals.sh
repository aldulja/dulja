#!/usr/bin/env bash
# scripts/check/no-authority-literals.sh
# Hazard 2 made mechanical. No LHDN/MyInvois host, path, header, field or version literal may appear
# anywhere in the e-invoicing surface except:
#   - packages/db/einvoice-profiles/*.json  (profile DATA; myinvois.v1.json comes from ADR 0051)
#   - docs/adr/0051-*.md                    (the record of the authority's own documentation)
#   - tests/ and *.test.ts                  (127.0.0.1 stub servers)
# Exit 1 on any hit, naming file and line.
set -uo pipefail
fail=0

SURFACE=(
  "packages/domain/src/tax/einvoice.ts"
  "packages/db/src/einvoice"
  "apps/worker/src/handlers/accounting-tax-submit.ts"
  "apps/api/src/routes/accounting/einvoice-transmissions.ts"
  "packages/contracts/src/accounting/einvoice.ts"
)

# 1. No absolute URL in the code surface at all. A base URL belongs to a profile file.
for path in "${SURFACE[@]}"; do
  [ -e "$path" ] || continue
  if grep -rn --include='*.ts' -E 'https?://' "$path" | grep -v '127\.0\.0\.1' | grep -v 'json-schema\.org' | grep -v 'dulja'; then
    echo "FORBIDDEN: an absolute URL in the e-invoicing code surface — a base URL is profile DATA (hazard 2)"
    fail=1
  fi
done

# 2. No authority-shaped identifier anywhere outside the three permitted homes.
#    THE TWO WORDS BELOW ARE THE ONLY ONES THIS SCRIPT MAY CONTAIN, and the reason is hazard 2
#    itself: a denylist of "LHDN field names" would have to be written from somewhere, and the only
#    somewhere available before ADR 0051 exists is training data — which is exactly what spec:2467
#    and hazard 2 forbid. `myinvois` and `lhdn` are attested by the project's own documents
#    (rebuild-spec.md and the contracts document both name them); nothing else is. A wider list is
#    GENERATED from ADR 0051 by whoever discharges OD-15, in the same PR as the profile file, and it
#    is never guessed here. Rule 1 (the absolute-URL ban) and rules 3-4 are the real guard.
WORDS='myinvois|lhdn'
if grep -rn -E "$WORDS" \
    --include='*.ts' --include='*.tsx' --include='*.sql' \
    packages/ apps/ scripts/ 2>/dev/null \
  | grep -v '\.test\.ts:' \
  | grep -vE '^packages/db/src/einvoice/index.ts:[0-9]+:[[:space:]]*(createMyInvoisTransport,|encodeMyInvoisSubmission,|myInvoisValidationLink,|\} from "\./myinvois";)$' \
  | grep -viE 'transmitter|MYINVOIS_|"myinvois"|myinvois\.v[0-9]+\.json|einvoice/myinvois\.ts' ; then
  echo "FORBIDDEN: an authority-defined identifier in source. Only the transmitter CODE string 'myinvois',"
  echo "           the profile file name, and packages/db/src/einvoice/myinvois.ts (Task 9, from ADR 0051)"
  echo "           may carry it. Everything else is an invented value (hazard 2, spec:2226, spec:2467)."
  fail=1
fi

# 3. Before Task 9 has run, myinvois.v1.json must not exist. After it, it must cite ADR 0051.
if [ -f packages/db/einvoice-profiles/myinvois.v1.json ]; then
  if ! grep -qF '0051' packages/db/einvoice-profiles/myinvois.v1.json; then
    echo "FORBIDDEN: packages/db/einvoice-profiles/myinvois.v1.json has no \"source\" citing ADR 0051."
    echo "           A profile whose values cite no authority document is a training-data guess."
    fail=1
  fi
  if [ ! -f docs/adr/0051-verified-lhdn-myinvois-requirement-set.md ] || ! grep -qiE '^((\*\*Status:\*\*)|Status:) *accepted\b' docs/adr/0051-verified-lhdn-myinvois-requirement-set.md; then
    echo "FORBIDDEN: a production profile requires accepted, verified ADR 0051. OD-15 remains pending."
    fail=1
  fi
fi

# 4. The synthetic profile must never point anywhere but loopback.
if [ -f packages/db/einvoice-profiles/synthetic.v1.json ]; then
  if ! grep -qE '"baseUrl": *"http://127\.0\.0\.1' packages/db/einvoice-profiles/synthetic.v1.json; then
    echo "FORBIDDEN: synthetic.v1.json's baseUrl is not loopback. The CI transmitter never leaves the host."
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "hazard-2 check FAILED."
  exit 1
fi
echo "hazard-2 check OK — no authority literal outside a profile file, ADR 0051 or a test."
