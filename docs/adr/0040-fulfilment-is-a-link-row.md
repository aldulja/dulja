# ADR 0040 — Fulfilment is a link row; open quantity is a derived view

**Status:** PROPOSED — the plan's inline draft of this ADR reads `Accepted`, and that is not honest on this
branch. Three of the five decisions below are data-model decisions in spec:95's sense: a new tenant-scoped
table, an invariant enforced by a trigger rather than by a service, and a privilege surface (`app_rw` holds
no DELETE on `document_link` and no INSERT or UPDATE on the view) that decision 4 turns into a statement
about routes that "never will" exist. Decision 5 is a security decision outright — without
`security_invoker = true` this view reads every tenant's orders. So it carries the status its siblings do.
It is implemented ahead of approval, as ADR 0020 was, as Phase 2's 0026, 0027 and 0029-0031 were, and as
3B's 0037, 0038 and 0039 are, and this line says so.
**Date:** 2026-09-20
**Deciders:** architect
**Slice:** 3C
**Supersedes:** nothing. **Related:** contracts §4.6.1 (`document_link`), §3.5.4 (the closed DELETE grant
list), §4.2.4 (`ERR_DOC_LINK_OVER_FULFILLED`), ADR 0029 (the document state machine in triggers), ADR 0030
(gapless numbering and draft deletion), Part I SAH-017, SAH-018, SAH-049
**Spec:** spec:1049, spec:1050, spec:2173 (the data layer is the control), Part VI tests 12, 13

## Context

An order commits to a quantity; one or more fulfilment documents consume it. The legacy system stored the
consumed quantity on the order line and incremented it from application code. SAH-017 is the result: editing a
fulfilment double-added the bonus quantity, and re-pointing it at another order never reversed the first.
SAH-018 is the same defect on the returns side. SAH-049 is its concurrency face — an aggregate row with no
unique key duplicates under an upsert race and is then double-updated forever.

## Decision

1. **`app.document_link` is the only stored fulfilment fact**: one row per (source line, target line, kind),
   append-only in practice, with two partial unique indexes so a duplicate is impossible with or without lines.
2. **Open quantity is never stored.** `app.document_open_quantity` is a view computing
   `ordered − Σ linked` on every read, excluding links whose target document is `void` or `reversed`.
3. **The invariant is enforced in the data layer, under a lock.** `app.assert_document_link_within_open_quantity()`
   is a BEFORE INSERT OR UPDATE trigger raising `ERR_DOC_LINK_OVER_FULFILLED`, so it holds for the API, a job
   and a direct `app_rw` statement alike. It takes `pg_advisory_xact_lock` on the **source line** before summing
   the existing links, because `withTenant` is READ COMMITTED and two concurrent links would otherwise both
   read the same committed sum and both commit — 3A's `lockStockKeys` precedent (3a:5719-5727), applied to
   fulfilment. `linkFulfilment` sorts its lines by `sourceLineId`, so multi-line links cannot deadlock.
   The same trigger carries the two status rules — the target must be a `draft` (`ERR_DOC_NOT_DRAFT`) and the
   source must be `issued` or `posted` (`ERR_DOC_STATUS_ILLEGAL`) — for a reason that is not stylistic:
   `packages/db` may not import `AppError` (contracts §3.1) and `PostingError`'s code union is a frozen literal
   subset containing none of these three (§4.2.4), so a TypeScript service enforcing them would need a fourth
   error class or a new `PostingError` code, both of which the contracts forbid. `fromDatabaseError` turns each
   token into the right `Problem` with no per-route mapping.
4. **Release is a deleted draft, not a negative link.** The target-side FKs cascade; `quantity > 0` is a CHECK.
   `app_rw` holds no DELETE on `document_link` and contracts §3.5.4's grant list is closed, so there is no
   `DELETE …/links/{id}` route and there never will be one — un-linking means deleting or re-lining the draft.
5. **The view is `security_invoker = true`.** A view is not RLS-transparent by default; without the option the
   caller would read every tenant's orders. `revoke insert, update on app.document_open_quantity from app_rw`
   is the second half of the same decision: Plan 0A's default privileges grant those to `app_rw` on views as
   well as tables, and the one figure this slice exists to keep derived must not be writable at all.

## Consequences

- A back-order is `open_quantity > 0` and needs no status column (3D's `SALES_ORDER` relies on this).
- A partially received order stays `issued` forever; "closing" it early is out of v1 scope and would be a
  `link_kind` of its own, decided here rather than invented later.
- Reversing a fulfilment (2B's `reverseDocument`) releases the quantity automatically, because the original
  becomes `reversed` and the view excludes it. No compensating link is written.
- The source-side FK is `NO ACTION` and, through `app_rw`, unreachable: 2B's `app.forbid_line_delete_unless_draft()`
  refuses to delete the line of a non-draft document first, with `ERR_DOC_NOT_DRAFT`. The FK is the belt a
  future slice holding a DELETE grant would hit; §3.5.4 being closed, no test can reach it today.
- **Nothing above has been observed to hold.** `packages/db/test/document-link.test.ts` is written against the
  real exports and typechecks, but it needs a PostgreSQL Testcontainer and the machine this slice was built on
  has no Docker daemon (`AGENTS.md`, "Current phase"). The `security_invoker` assertion — the one that stands
  between this view and a cross-tenant read of every order in the database — is therefore **written, unrun**,
  as are the two-tenant case (test 12) and the audit case (test 13).
