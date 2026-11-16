# ADR 0029 — The document state machine lives in triggers, and the API gate is a pre-flight

**Status:** PROPOSED — this ADR touches security and the data model, so spec:95 requires it to be written as a proposal and asked before implementing.
**Date:** 2026-09-05
**Deciders:** owner (pending), architect
**Slice:** 2B
**Supersedes:** nothing. **Superseded by:** nothing.

## Context

spec:2172 states the mechanism in one sentence: "an AFTER UPDATE OF status trigger on `document` **inserts the
`document_event` row itself** … handlers never write `document_event`, so a direct `app_rw` update cannot skip
it", and "a BEFORE UPDATE OF status trigger enforces the legal transitions … and, for a type whose effective
policy declares `approval.required`, **fails closed**". spec:2173 adds that the handler's own check "is a
pre-flight for a better error message, not the control (SAH-032)". Acceptance tests 10 and 31 (spec:2428,
2449) require the rules to hold "through any path — API, job, or direct SQL as `app_rw`".

SAH-032 is the legacy system letting a user raise a document's approval level above their own; SAH-027 is one
client-settable variable disabling every write-time control. Both are the same shape of failure: the control
lived above the data.

Three placements were considered.

1. **In the API handler.** Rejected outright: it fails the "direct SQL as `app_rw`" clause of tests 10 and 31,
   and it is exactly SAH-032.
2. **In the posting service (`packages/db/src/posting/`).** Rejected: the sync-apply job, the importer and the
   payroll engine all reach `app.document` through `withTenant`, and a future writer that forgets the helper is
   one line away from a silent bypass. The `posting-only-tables` lint protects ledger and movement tables, not
   `document.status`.
3. **In two triggers on `app.document`.** Chosen.

## Decision

- `app.document_status_before()` — BEFORE UPDATE OF status, FOR EACH ROW — resolves the policy effective for
  `new.effective_date` through `app.effective_policy`, applies the contracts §4.5.1 matrix, then R1 and then R2.
  It resolves by `effective_date` and **not** by `document.posting_policy_id`, which §3.8 pins only at post and
  is NULL at approval (spec:2172).
- `app.document_status_after()` — AFTER UPDATE OF status, FOR EACH ROW, WHEN (old.status is distinct from
  new.status) — inserts the `transition` row, taking `reason` and `attributed_to` from two transaction settings
  (`app.event_reason`, `app.event_attributed_to`). The settings are the convention contracts §4.5.2 fixes for
  spec:2172's "reason from a transaction setting".
- `posted → reversed` is admitted **only when a posted document already carries
  `reverses_document_id = the original`**. That is `reverseDocument`'s own signature in data (1A posts the
  reversing document before flipping the original), so "only by `reverseDocument`" (contracts §4.5.1) becomes a
  row-level fact rather than a service-level promise, and a direct `update … set status = 'reversed'` fails.
- `→ issued` evaluates no authority code. The matrix conditions `draft → issued` and `submitted → issued` on
  `approval.required = false` and leaves `approved → issued` unconditional, because authority was checked at
  `approved`. Issuing consumes a number; it does not commit anything to the ledger.
- A policy that declares no `approval.post` **fails closed** with `ERR_POLICY_INVALID` on any transition to
  `approved`, `posted` or `void`. `posting-policy.schema.json` requires the member, so the only policies
  affected are pre-schema placeholders.
- `requireDocumentPermission(stage)` in `apps/api` performs the same resolution before the handler runs, purely
  so the caller gets `403 ERR_RBAC_FORBIDDEN` with a remedy instead of a 409 from a constraint. It is never the
  control.

## Consequences

- Every path — HTTP handler, pg-boss job under `systemContext`, `psql` as `app_rw` — is governed identically.
  Acceptance tests 10 and 31 are written against all three and pass without three implementations.
- Posting now requires authority. Every existing test that posted as a principal with no role must grant the
  effective policy's `approval.post` first. This slice adds `grantCodes` to `fixtures.ts` and updates the
  call sites; later slices grant through the same helper.
- The trigger reads `app.document_event`, which is RLS-forced. Both tables are the current tenant's by
  construction (the trigger runs inside the same `withTenant` transaction), so no `SECURITY DEFINER` is needed —
  and none is used, because a definer function here would also bypass `tenant_isolation`, which is a tenancy
  hole, not a lifecycle one.
- A status change now costs one extra `app.posting_policy` lookup and one `document_event` insert. The lookup is
  a two-column index seek; the insert is what makes R1 answerable at all.
- **Open question for the contracts document, raised here and not decided here:** contracts §4.4.1 says JOURNAL's
  `approval.create` is `accounting.journal.create`, but §4.3.7's frozen seed file and §4.17's frozen
  `JOURNAL_POLICY_V1` both omit the member, so §4.5.4's `approval.create ?? approval.post` resolves JOURNAL's
  create stage to `accounting.journal.post`. Either the two frozen artefacts gain the member or the §4.4.1
  sentence goes. This plan implements §4.5.4 verbatim and changes neither artefact.
