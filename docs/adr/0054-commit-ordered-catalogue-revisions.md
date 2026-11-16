# ADR 0054 — Commit-ordered catalogue revisions share the tenant serialization lock

- Status: **Proposed** (security, data-model or sync-protocol decisions require owner approval before implementation)
- Date: 2026-10-07
- Slice: 6A
- Source: [2026-09-05-dulja-phase-6a-sync-protocol-terminal-identity.md](../superpowers/plans/2026-09-05-dulja-phase-6a-sync-protocol-terminal-identity.md)
- Approval: pending; this record does not claim implementation or owner acceptance.

## Context

spec:1299 requires catalogue revisions in commit order. A plain sequence is insufficient: transaction A obtains revision 100 but remains open; transaction B obtains 105 and commits; a till reads through 105; A then commits its row at 100. The till asks only for revisions greater than 105 and never sees A's change. A timestamp also fails because clocks can drift.

The audit chain already serializes writers per tenant. Using separate `catalogue:` and audit locks creates an ordering cycle when one writer audits before changing catalogue data and another changes catalogue data before auditing (6A C1).

## Decision

Catalogue-write triggers take the same transaction-scoped advisory lock as the audit chain, keyed `tenant-serial:` plus the tenant id, before assigning the row's final `nextval('app.catalogue_revision_seq')`. The lock remains held until commit. Every catalogue change and its revision therefore commits before another catalogue writer in that tenant can assign its final revision. This replaces the spec's separate `catalogue:` key as the plan's C1 proposal; the shared-key contract amendment must accompany approval.

Existing stream-table revision columns default to `nextval`, not zero. This gives pre-6A rows distinct discoverable cursor positions without a tenant-data backfill that a context-free migrator cannot perform under forced RLS. Subsequent writes are stamped by the locked revision trigger.

A tombstone is keyed by `(stream, row_id)` and upserted, rather than appended on every retirement. Resurrection is an upsert of the catalogue row; retaining multiple independent tombstones could later delete the row the till just recreated. `price_list_line` resolves company and branch from its parent price list because the child carries neither column and the tombstone's company id is required. `promotion` produces no tombstone: retirement changes `ends_at` and arrives as an upsert, because that table has no `archived_at` and the promotion still exists.

## Consequences

- A till's cursor cannot pass a later-committing catalogue row's final revision.
- Catalogue and audit writes contend on one lock and serialize per tenant instead of acquiring competing keys in opposite orders.
- Every catalogue write in a tenant serializes. spec:1299 accepts this cost as “low volume; acceptable”.
- Deletion handling differs by stream and must be tested as such; a promotion retirement is not a row deletion.

## What we are asking

Approve the shared `tenant-serial:` lock for catalogue revision assignment and audit serialization, the `nextval` defaults for existing rows, and the stated tombstone/retirement semantics, together with the corresponding C1 contract amendment?
