# ADR 0027 — A posting-policy version is append-only through the API

**Status:** PROPOSED — the rule shapes the data model's write paths, so spec:95 requires a proposal.
**Date:** 2026-09-05
**Deciders:** owner (pending), architect
**Slice:** 2A

## Context

`app.posting_policy` is keyed `unique (document_type_id, version)` and every posted document pins the
`posting_policy_id` that produced it (spec:1753, SAH-013). The legacy system's failure was that a reversal read
the *current* document-type flags rather than the ones originally applied.

Pinning the id is necessary but not sufficient: if the row a pinned id points at can be rewritten, the pin
buys nothing. Two write paths exist — the seed CLI (contracts §3.4.8) and this slice's configuration API — and
they need different rules.

## Decision

**The API is append-only.** `POST /v1/companies/{companyId}/document-types/{documentTypeId}/policies` inserts a
new `(document_type_id, version)` row. There is no `PUT` and no `PATCH` on a version. A repeated version number
raises SQLSTATE 23505 → `ERR_CONFLICT_UNIQUE`. A correction is a new version with a later `effective_from`;
`resolvePolicy` picks the greatest `effective_from ≤ effective_date`, ties broken by the highest version
(contracts §4.3.1), so a corrected rule applies from the date the tenant chooses and never retroactively.

**The seed CLI keeps its upsert**, which contracts §3.4.8 fixes as `on conflict (document_type_id, version) do
update set definition = …, effective_from = …`, and which is deliberately the *only* path that rewrites a
version. Its reason is stated there: a placeholder policy seeded on staging in an early phase would otherwise
silently survive the real definition arriving later, and the phase's tests would pass locally and fail on
staging. That path is a reviewed diff of a version-controlled file under an operator's hand (SAH-078); the API
path is a tenant's admin clicking a button.

## Alternatives considered

- **`PUT` on a version, refused once a document has posted under it.** Rejected: the check is a `select … from
  app.document where posting_policy_id = …`, which is racy against a concurrent post and would need the same
  advisory-lock machinery the numbering path has, to protect an operation nobody needs. Adding a version is
  cheap and its audit trail is the row itself.
- **No API path at all; policies only through the seed pack.** Rejected: spec:2288 requires a tenant to add a
  document type, and test 15 requires it to be provable without a deployment.

## Consequences

- The policy list on a type is its history; `report_definition`-style cloning is not needed.
- `app.posting_policy` has no `archived_at`: superseding is what a later `effective_from` does.
- 2B's status trigger resolves the policy by `effective_from ≤ effective_date` for R1/R2 and reads a row that
  cannot have changed under it since the document was drafted.
- A back-dated `effective_from` is admitted, which is why `reverseDocument` reads the `reversal` block from the
  policy pinned on the original document rather than re-resolving by date (contracts §4.3.1, amendment A8).
