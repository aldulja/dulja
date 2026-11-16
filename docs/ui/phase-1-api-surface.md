# Phase 1 — the API surface the back-office screens consume (OWNER GATE OD-24)

**Status:** the three screens are **1B's**; 1A ships this surface and no UI. Written 2026-09-05 by slice 1A.

The owner has not yet supplied screenshots or an operator description (OD-24, spec:2408), so no workflow is
assumed here. What is fixed is the data each screen needs and where it comes from.

| Screen (1B) | Reads | Writes | Permission |
|---|---|---|---|
| Chart of accounts | `GET /v1/companies/{companyId}/accounts` (paged, `type`, `includeArchived`) and `GET …/accounts/tree` (one recursive CTE, each node with `depth` and a code `path`) | `POST …/accounts`, `PATCH …/accounts/{id}`, `POST …/accounts/{id}/archive` | reads: membership; writes: `accounting.account.manage` |
| Journal entry | `GET …/documents/{documentId}` (header plus lines) | `POST …/documents` (header and lines in one call), `PUT …/documents/{documentId}/lines` (replace), `POST …/documents/{documentId}/transitions` with `to ∈ issued \| posted \| void` | read: any of `accounting.journal.create`, `accounting.journal.post`, `accounting.ledger.read` in the company; create: `accounting.journal.create`; transitions: `accounting.journal.post` |
| Fiscal periods | `GET …/fiscal-periods` (with `status`) | `POST …/fiscal-periods/{periodId}/close`, `POST …/fiscal-periods/{periodId}/reopen` (body `{ reason }`, mandatory) | `accounting.period.close`, `accounting.period.reopen` |

Facts a screen may rely on:

- Every error is `application/problem+json` with a stable `code`, a `detail` naming the entity and a `remedy`
  (contracts §4.2.4). A screen renders `detail` and `remedy`; it never parses `detail`.
- A document is created with all its lines in one call, so a keyboard-first grid (spec:2254) can submit once.
- `POST …/transitions` returns `{ documentId, status, number, series, fiscalPeriodId, ledgerEntryIds }` —
  enough to show the assigned number without a second request.
- Amounts are `{ "amount": "1234.5000", "currency": "MYR" }` or a fixed-4-dp string; display rounding is the
  UI's business and is never persisted (spec:2041).
- **There is no reversal endpoint in Phase 1.** Contracts §4.5.4 puts reversal on its own route,
  `POST …/documents/{documentId}/reverse { effectiveDate, reason }`, gated by `accounting.document.reverse`
  — a permission code §3.6.2 assigns to slice 2B, deliberately separate from `accounting.journal.post` so a
  poster is not automatically a reverser. A Phase 1 journal-entry screen offers **issue**, **post** and
  **void**; the reversal button appears with 2B. `reverseDocument` itself already ships in `@dulja/db`.
- Every unsafe call requires an `Idempotency-Key`; a retry after a network failure replays rather than
  double-posting (contracts §4.2.9).
- The two chart-of-accounts reads and the fiscal-period list — reference data, no amounts — are gated by **membership only**, which the route
  says out loud with `membershipOnly()` rather than by omitting middleware. A company of another tenant is not
  a 403 on those paths — it is an empty page with a 200, because a 403 on an id the caller may not see confirms
  the id exists. A screen must therefore treat "no rows" and "not mine" identically. A **document** is not
  reference data — it carries every line's account and amount — so `GET …/documents/{documentId}` is gated by
  any one of `accounting.journal.create`, `accounting.journal.post` or `accounting.ledger.read` in the company
  (`requireAnyPermission`), and a member of the tenant with no role in the company gets a 403 on the company.

**If the owner's screenshots show a different workflow**, the likely changes and their blast radius:

| Owner finding | Change | Where |
|---|---|---|
| Lines are entered one at a time, not as a grid | add `POST …/documents/{documentId}/lines` beside the existing `PUT` | one route file, `apps/api/src/routes/accounting/documents.ts` |
| The operator expects to see the number before posting | 1B's screen calls `transitions` with `to: "issued"` first — already supported | 1B's component only |
| Accounts are picked by a searchable code prefix | add a `codePrefix` filter to `AccountQuery` | one Zod schema and one `where` clause |
| A period close needs a reason too | mirror `ReopenPeriodBody` on `ClosePeriodBody`; the column already exists as `reopen_reason`, so a `close_reason` column would be a new migration in **1B's** range | contracts amendment first (§3.4.1) |

**Nothing in the above touches `packages/db/src/posting/` or `packages/domain/src/posting/`.** That is the
point of this record: the posting service is decided by the spec and the contracts document, not by a screen.
