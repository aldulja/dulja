# ADR 0057 — The till's local SQLite file is a cache with an outbox, not a second model

- Status: **proposed** (spec:95 — a decision touching the data model is written as a proposal and asked)
- Date: 2026-09-05
- Slice: 6B

## Context

spec:1358: *"The old system's biggest structural error in this area was giving the POS its own 69-table
schema that mirrored the core; that duplication is what made the two disagree. Here the POS has a *local
cache* for offline operation, not a *second model*."* spec:1337 adds the operative sentence: *"Nothing in
the local database is authoritative except the tickets the till itself created."*

The local file must nevertheless hold enough to sell for eight hours with no network: items and barcodes,
prices, promotions, customers, tax codes, the cashier credential and the branch limits — and the tickets,
shifts and till events the till produced, with an outbox.

## Decision

The local schema is **exactly spec:1328–1335 plus `outbox.kind` and `catalogue_branch_pos_policy`**
(§4.10.6), with three rules that make "cache, not model" mechanical rather than aspirational:

1. **Two kinds of table and no third.** A `catalogue_*` table is a mirror: its only writer is
   `SqliteSyncStore.applyChanges`, it carries the `revision` it arrived at and the whole server row as
   `row_json`, and a `CHECK`-free extracted column exists only where a lookup needs an index. Every other
   table (`shift`, `ticket`, `ticket_line`, `ticket_tender`, `till_event`, `attendance`, `outbox`) is a row
   the till created and owns until the server acknowledges it.
2. **No derived total is stored that the server also derives.** `shift.expected_cash` and
   `shift.over_short` exist because spec:1331 lists them, and are **never written by the till** — §4.10.1
   is explicit that the server derives both. They stay `NULL`.
3. **Every money, quantity and revision column is `TEXT`.** `better-sqlite3` returns an SQLite `INTEGER`
   as a JavaScript `number`, so a revision past 2^53 read back would round and re-deliver one row for
   ever; a `REAL` money column is the float spec:2041 forbids anywhere, including in TypeScript. The
   conversions live in one module, `src/main/money.ts`.

## Consequences

- A till that has never pulled cannot price a ticket, and says so (`ERR_TILL_CATALOGUE_STALE`) rather than
  selling at a guessed price. That is the honest failure, and it is visible in the offline indicator.
- The local file can be deleted and re-pulled at any time **except** while the outbox is non-empty, which
  is the one piece of unrecoverable state the till holds. The enrolment runbook says so in one sentence.
- A schema change at the till is a new `schema.sql` section plus a bump of `LOCAL_SCHEMA_VERSION` and a
  migration step in `openPosDatabase`; there is no expand/contract discipline because there is no second
  reader and no production data that is not also in the outbox or already on the server.

## What we are asking

Confirm that a till holding **no** authoritative data other than its own unsent tickets is acceptable
operationally: a shop whose PC dies loses only the tickets that had not yet synced, and the recovery
procedure is "re-enrol and re-pull", not "restore a backup".

## Proposal preparation

Prepared for owner review on 2026-10-07 from [2026-09-05-dulja-phase-6b-pos-application.md](../superpowers/plans/2026-09-05-dulja-phase-6b-pos-application.md). The source proposal date above is preserved. This record is proposed; no owner acceptance or implementation is recorded here.

## Amendment — the local model as registered and shipped (2026-10-22, proposed)

Plan Contracts' **6B amendment A8** and the 2026-10-07 durability correction
(`docs/review/2026-10-07-phase-6-plan-reconciliation.md`) changed the local model after this proposal was
written, and the tree implements A8 (`apps/pos/src/main/schema.sql`, `database.ts`). The owner is asked to approve
this model, not the one in the Decision above where the two differ:

1. **Rule 2 is stronger: the two shift columns do not exist.** `shift.expected_cash` and `shift.over_short` are
   omitted from the till's `shift` table, not kept and left `NULL`. The server alone derives and stores both
   (§4.10.1; ADR 0063's formula), so a till column could only ever be empty or wrong.
   `apps/pos/test/database.test.ts` asserts their absence.
2. **Rule 1's second kind gains `pending_customer`** (`LOCAL_SCHEMA_VERSION` 2, 6B Task 8): a customer
   quick-created at the till is a row the till created and owns until the server acknowledges it. It is never a
   second writer to `catalogue_customer`, whose only writer stays `SqliteSyncStore.applyChanges`. The local file
   therefore holds eighteen tables: eight `catalogue_*` mirrors, `meta`, `sync_cursor`, and eight tables of the
   second kind (`shift`, `ticket`, `ticket_line`, `ticket_tender`, `till_event`, `attendance`, `outbox`,
   `pending_customer`).
3. **`synchronous = FULL`, with WAL.** Under `NORMAL`, WAL can lose a committed sale on power loss, and the
   outbox is the one piece of unrecoverable state the till holds. A completed ticket and its outbox row commit
   in one transaction, and under `FULL` that commit is on disk when it returns.
4. **The version-1 → 2 upgrade is idempotent.** `openPosDatabase` accepts schema version 1 or 2 and re-runs the
   whole `create … if not exists` schema in one transaction. A version-1 file gains `pending_customer` and keeps
   every unsent ticket, exact amount and revision. A file with any other version is refused as
   `ERR_TILL_STORE_CORRUPT` and left untouched for recovery.
5. **`outbox_refused` is a view, not a column** (ADR 0056's PR 12 amendment): the unacknowledged ticket and
   till-event rows the server refused after their shift's close was acknowledged. It has one definition for
   every reader, and a file written before it gains it on its next open. It stores nothing, so rule 1's "no third
   kind" holds.

Rule 3 (every money, quantity and revision column is `TEXT`) is unchanged. `tests/invariants/phase-6b-pinned.test.ts`
pins the eighteen tables, the eight mirrors, the `TEXT` columns and `synchronous = FULL`.

## Amendment — the till prices from its mirror by the server's rule (2026-11-15, proposed)

The 2026-11-15 full review (POS-02, POS-16, POS-05) found the till choosing a price list by a rule of its own:
branch lists, then company-wide lists in code order, with neither `currency` nor `customer_kind` read although
both are mirrored. The server never re-prices a ticket (`packages/db/src/sync/limits.ts`, decision (c)), so a
walk-in could be charged a wholesale list's price, and a foreign-currency list could set the shift's currency.

1. **One rule, in `@dulja/domain`.** `selectPrice` (`packages/domain/src/pos/price-selection.ts`) is the server
   resolver's rule as a pure function: the currency, the business date inside the window, the branch's lists
   and the company-wide ones, `customer_kind` null or the caller's, a line whose unit is null or the caller's
   and whose break is reached; then branch-specific, trade-level-specific, unit-specific, the largest break, the
   code. `packages/db/test/inventory/price-parity.test.ts` runs one catalogue through both resolvers for every
   combination of those dimensions and requires the same line. The server's SQL is unchanged.
2. **The customer's own list first** (A10b, `app.party.price_list_id`), read by the same function at its own
   branch and trade level; a list in another currency is still refused as `ERR_MONEY_CURRENCY_MISMATCH`.
   Otherwise the till asks `selectPrice` at **trade level null** — the server's answer for a caller that names
   none — because no party and no till carries a trade level. A list tagged with any level (`retail` included)
   prices only the customer whose own list it is.
3. **A null-unit line prices only the base unit.** 3A defines `unit_id` null as the item's base unit; the
   server's SQL admits such a line for any unit (a carton at the per-piece price). The till keeps the narrower
   reading; the server's is a separate finding.
4. **The till's currency** is the one currency of the walk-in lists at its branch (the lists at trade level
   null, falling back to every list it holds); when they disagree the till refuses with
   `ERR_TILL_CATALOGUE_STALE` rather than guess. The company's base currency is not mirrored.
5. **The till's branch is `meta.branch_id`**, written at enrolment, and the policy row only for a file without
   it, so a branch with no `branch_pos_policy` row keeps its own lists and promotions (POS-16).
6. **Not changed: the business date is still UTC** (POS-05). The server dates a ticket in the company's time
   zone; neither the time zone nor the base currency reaches the till, and carrying them is a change to the
   catalogue stream (`app.branch_pos_policy_sync` or the enrolment answer) outside this amendment.

Owner questions: should a till sell at a named trade level (a per-branch `customer_kind`), so a shop may tag
its walk-in list `retail`? And should the company's base currency and time zone be mirrored to the till, which
would replace rule 4's inference and close POS-05?
