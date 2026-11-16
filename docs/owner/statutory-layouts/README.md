# ⚠️ OD-28 — the statutory-schedule upload layouts

spec:2083 and §2.12's OD-28 row (_"§3.10.1 ⚠️ items: statutory-profile field list vs LHDN; **schedule layouts**; form
names; proration rule"_). The other OD-28 items are `docs/owner/od-28-statutory-profile-fields.md` (8A) and
`docs/owner/od-28-proration-rule.md` (8B); this file is the schedule-layout item, 8C Task 13's.

**Decision needed from the owner and the owner's accountant, not from the build team.** On 2026-11-07 the owner
directed "implement phase 8 entirely"; the plan's default below is what was built
(`docs/review/2026-11-07-phase-8-decisions.md`, the OD-28 schedule-layout row) — implementation authorization, not an
answer.

Dulja generates a statutory schedule per scheme per posted payroll run, and attaches a CSV to it. The **figures** are
correct today and acceptance test 30 ties them to the ledger to the cent. What is **not** known is the **shape** each
authority's portal accepts, so the attached file is a generic five-column CSV
(`employee_number, employee_name, scheme_reference, employee_share, employer_share`) that an officer re-keys or
re-shapes before upload. This directory is where the verified shapes arrive.

Nothing here is a rate, a threshold, a ceiling, a formula or a deadline. A layout is a column order. Rates live in the
signed-off rate tables (OD-23, `docs/owner/od-23-employer-registrations.md`); submission and e-filing are out of v1
entirely (spec:2093, "direct e-filing to the authorities").

**Owner provides:** for each scheme below, the authority's current published upload specification and one example
file the authority has accepted, with the accountant's written confirmation that the example is current.
**Verify:** with both files in `docs/owner/statutory-layouts/<SCHEME>/`,
`bun run --cwd packages/db test test/hr/schedule-layouts.test.ts -t "<SCHEME>"` runs that scheme's shape case instead of
skipping it, and passes.
**Until provided:** `scheduleCsv` (8C Task 7) is the layout every schedule is rendered with, attached to every
`statutory_schedule` row with its sha256; `layoutFor` (`packages/db/src/hr/schedule-layouts/index.ts`) answers `null`
for every scheme.

## The schemes

`EPF`, `SOCSO`, `EIS`, `PCB` — and any levy confirmed under OD-14 (`docs/owner/od-14-hr-facts.md`, item 1).

## The seven facts wanted per scheme

1. **Column order** — the exact fields, in order, with the authority's own name for each.
2. **Header row** — present or absent, and if present its exact text.
3. **Field widths** — fixed-width positions if the format is fixed-width; "not applicable" if delimited.
4. **Delimiter** — comma, tab, pipe, or none (fixed-width).
5. **Encoding** — UTF-8, UTF-8 with BOM, or a code page, named exactly.
6. **Line terminator** — CRLF or LF.
7. **File-name pattern** — with the employer identifiers it must carry, and where each comes from.

## The two files expected per scheme directory

Put both in `docs/owner/statutory-layouts/<SCHEME>/`, using the scheme code in capitals:

| File | What it is |
| --- | --- |
| `spec.md` | The authority's published upload specification covering the seven facts above, with the publication's name, its URL and the date it was retrieved. |
| `accepted-example.csv` | **One worked example file the authority has actually accepted**, plus the accountant's written confirmation — in `spec.md` — that it is current. |

A scheme directory that holds only one of the two is treated as absent: `packages/db/test/hr/schedule-layouts.test.ts`
skips that scheme and records it as unverified, and the generic CSV keeps shipping for it.

## What happens when a directory is filled

1. `packages/db/test/hr/schedule-layouts.test.ts` stops skipping that scheme and asserts the writer's output matches
   the accepted example in **shape** — same header, same column count, same delimiter, same terminator — and fails
   until a writer exists.
2. The scheme gains `packages/db/src/hr/schedule-layouts/<scheme>.ts` and one row in that directory's `LAYOUTS`
   registry (`index.ts`, which ships empty).
3. `generateStatutorySchedule` renders through `layoutFor(scheme.code) ?? { render: scheduleCsv }`; the attachment's
   file name and media type come from the layout. A company with some schemes verified and others not renders both.
4. The employer identifier a layout carries is read from `app.statutory_scheme.employer_registration` alone (8A's
   column; OD-23's registrations — 8C Task 15 surfaces it on every schedule), never from a jsonb copy.
5. An ADR records, per scheme, the publication, its URL and the date retrieved — the three facts §4.12.3's `source`
   block demands of a rate table. ADR 0079 is 8D's number; if this lands before 8D, the record goes in ADR 0078's
   consequences instead (hazard 14: no slice borrows another's number).
6. **Nothing about `app.statutory_schedule` changes** — the row, its totals, its unique key and the remittance guard
   are layout-independent, and test 30's tie-out is unaffected.

## Answer here

- EPF: specification and accepted example supplied? Date:
- SOCSO: specification and accepted example supplied? Date:
- EIS: specification and accepted example supplied? Date:
- PCB: specification and accepted example supplied? Date:
- Confirmed by (accountant) / date:
