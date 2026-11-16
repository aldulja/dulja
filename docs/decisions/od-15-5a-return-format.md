# OD-15 (5A half) — the verified return format

**Status:** statutory requirements pending; plan-default implementation selected by the owner on 2026-10-02. Owner: the project owner (§2.12, spec:2405).
**Scope of this record:** the *return* format only. Credentials, the submission API and every MyInvois
transport detail are OD-15's second half and belong to slice 5B under ADR 0051.

## What was asked

The authority's currently published return specification for the regime this company files under — the
publication or a stable citation to it (title, issuing body, publication date, version) — plus the
accountant's written confirmation that it is the version in force for the periods Dulja will file.

## What was assumed instead, and where the assumption lives

The default of contracts §2.12 — **abstract interface only** — realised as a complete but deliberately
synthetic regime:

| Assumption | File | What it is |
|---|---|---|
| One regime definition, `SYNTH-MY-v1`, five boxes with generic labels | `packages/domain/src/tax/malaysia.ts` | `SYNTH_MY_V1`, the only member of `MALAYSIA_REGIMES` |
| Four tax codes, two invented rates | `packages/db/seed/my/tax/SYNTH-MY-v1.codes.json` | every row carries `"source": "SYNTHETIC-TEST-v1 — not a published figure (OD-15)"` |
| Provenance is a column, not a comment | `app.tax_regime.source` (migration 0053, amendment A2) | `not null`; the loader writes the manifest's `source` verbatim |
| The golden fixture files that synthetic regime | `tests/golden/tax/` | acceptance test 26 is green on invented figures |

## What changes when the answer arrives

The owner instructed: “please refer to the plan of the phase 5, if you did not find something, choose the best practice form your side.” The selected default is the plan's existing synthetic regime and provenance guard. Task 10 states that omitting the statutory definition/seed pair drops no interface and gates no other task. Its default steps are complete; statutory steps 4–6 remain deferred until applicable verified requirements exist. This is a scope decision for local implementation completion, not confirmation of a tax regime or acceptance of ADR 0049.

**Nothing structural.** A second `RegimeDefinition` joins `MALAYSIA_REGIMES`; a second `.regime.json` /
`.codes.json` pair joins `packages/db/seed/my/tax/`; ADR 0049 records the publication and moves to
`accepted`. `buildReturn` matches a tenant's regime row to a definition by `(code, version)`, so a tenant
on the verified regime simply matches the other entry. **Nothing is replaced** — a tenant already on
`SYNTH-MY-v1` keeps its filed returns readable, and a filed return is never regenerated (T8).

## What does NOT change, ever

No rate, box label, form name, threshold, deadline, endpoint, schema version or field name is written into
`packages/domain/src/tax/**` or `packages/db/src/tax/**`. Rates and box layouts are **data** — a seed file
and a `RegimeDefinition` — and a change to either is a reviewed seed PR, never a release (ADR 0050). That
is SAH-020's fix, and it is the reason this record exists at all: the legacy system's GST return carried
its rate as a literal inside a stored procedure, so the rate could not be reviewed, dated or reverted.
