# 0073 — Statutory rate tables are seed-pack data, with one break-glass door

- Status: **Proposed** — the plan records it as accepted, but it decides who may load the figures payroll
  computes with and how a load is reviewed (a security and segregation-of-duties decision, spec:95), so it is
  asked rather than decided. Implemented in 8A Tasks 9 and 10 ahead of approval, as ADRs 0071 and 0072 were,
  under the owner's direction to implement Phase 8 entirely.
- Date: 2026-11-07 (the plan's text is dated 2026-09-08)
- Slice: 8A · Tasks 9 and 10
- Migration: `0084` (`statutory_scheme`, `statutory_rate_table`, the verifier trigger)

## Context

spec:2080 gives two load paths and ranks them: rate tables are "seeded from version-controlled files under
`packages/db/seed/my/statutory/<scheme>/vN.json` **so every change is a reviewed diff** (LEGACY-078)", and "the seed
pull request is the primary load path; the runtime `hr.statutory_table.manage` load is **break-glass**". What
"break-glass" means operationally was not written down, and a permission with no stated intent becomes an ordinary
one.

## Decision

**The pack is the source of truth and the API is the exception.** `bun run seed --tenant <id> --only statutory`
inserts every `<SCHEME>/vN.json` present with `on conflict (scheme_id, version) do nothing`, so a re-run never
overwrites a table a second principal has already verified. Every file is validated against
`packages/domain/payroll/rate-table.schema.json` first, its declared `scheme` must name the directory it sits in,
and a file whose `source.authority` is the test fixture's `"Dulja test fixture"` is refused outside `APP_ENV=dev`.
The runtime `POST …/statutory-schemes/{schemeId}/rate-tables` exists for one situation: an authority publishes a
change that must be in payroll before the next deployment. It writes the same row, through the same schema validation, with
the same `loaded_by` stamp, and refuses a definition whose `scheme` is not the path scheme's code.

**Neither path can verify.** The seed runs as the system principal and leaves `verified_at` null; the API's load
route leaves it null too. Verification is a separate route under a **different** permission held by a **different**
seeded role (`hr.statutory_table.verify` → `accountant`, R6), and migration 0084's trigger refuses it when the actor
is the loader — and refuses an insert that arrives already verified. A break-glass load therefore cannot become a
break-glass _use_: 8B's run reads only verified tables (`rateTableOn`), and refuses a period with none.

**A break-glass load is visible afterwards.** The row is audited like every other, and its `source` column carries
the authority, publication and retrieval date the schema requires — so the follow-up pull request that adds the
file to the pack has something to be checked against. The runbook step is "after any break-glass load, commit the
same JSON under `seed/my/statutory/<scheme>/` in the next pull request"; the seed's `do nothing` makes that commit a
no-op against the database and a permanent record in the repository.

## Consequences

- The repository ships **no rate table at all** until OD-23. The four scheme directories exist and are empty; a
  `.gitkeep` keeps each and the pack's `README.md` says why.
- `pay_component_scheme` rows are pack data on the same terms and are equally absent, because "component X is
  subject to scheme Y" is a statutory claim.
- 8D's parallel run has a written provenance for every figure it compares against the legacy system.

## Rejected

- **API-only loading.** No reviewed diff, which is the LEGACY-078 defect verbatim.
- **Seed-only loading.** A statutory change between deployments would mean a deployment, and payroll deadlines do
  not move for a release train.
- **Letting the seed set `verified_at` when the file carries a `verification` block.** The block records who signed
  the _paper_; `verified_by` records which Dulja principal accepted it into this tenant. Collapsing them would let
  one person write both, which is what spec:2080 forbids.

## Questions for the owner

1. The API route does not apply the seed's test-fixture refusal: the route layer is not handed `APP_ENV`, and a
   synthetic table loaded through it still needs a second principal to verify it, with `"Dulja test fixture"` in
   its `source` for that principal to read. Should the route refuse it outside `dev` as well (which threads
   `APP_ENV` into the route dependencies)?
2. Is the break-glass load acceptable as an ordinary permission held by `hr_payroll` (with the second-principal
   verification as the control), or should it additionally require an out-of-band step (for example a time-boxed
   grant)?

## Amendment — 2026-11-15: the verifier signs and does not write (full review DBS-10)

- Status: **Proposed** — a segregation-of-duties control (spec:95, LEGACY-020). Implemented in migration `0126` ahead
  of approval.
- The verifier trigger froze a table's content only after verification; on the verify edge it checked only that the
  actor was not the loader, so the verifier could rewrite `definition` and `source` in the statement that signed
  them — two names over one hand. Decided: on the verify edge (`verified_at` NULL → set) every column except
  `verified_at` and `verified_by` must be unchanged (`ERR_HR_SELF_VERIFY`), and the actor must hold
  `hr.statutory_table.verify` in the scheme's company (`ERR_RBAC_FORBIDDEN`) — the route's gate is now also the data
  layer's (spec:2173). A table that needs a correction before signing is corrected by its loader, or a new version
  is loaded. 8A's `verifyRateTable` already writes exactly the two columns.
