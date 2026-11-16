# OD-05 — the "Multi-branch stock" row of §3.0.3, as slice 3D built it (Plan 3D Task 12)

**Status:** ⚠️ **UNCONFIRMED — built at §2.12's stated default (the spec text as written).** This is a
*decision record*, not an ADR: it decides nothing. It states what the slice assumed while waiting for the
owner, and exactly which files revert under each alternative answer, so that the answer — whenever it comes —
is cheap to apply and impossible to apply half-way.

**Nothing is blocked by this record.** Plan 3D Tasks 7, 8 and 10 are built, and Task 14's slice exit does not
wait on it. Contracts §2.12's OD-05 row states the default as "spec text as written", and that is what was
built.

## The gate, and what it checks

Plan 3D Task 12 states the verification as: *"the confirmation is attached to this task in the issue tracker;
`ls docs/owner/od-05/3d/` shows one file."* Run on 2026-09-20 against this tree, both halves fail:

```
$ ls -1 docs/owner/od-05/3d/
ls: cannot access 'docs/owner/od-05/3d/': No such file or directory
$ ls -1 docs/owner/
ls: cannot access 'docs/owner/': No such file or directory
```

`docs/owner/` does not exist and never has, in any phase — the same finding
`docs/ui/od-24-phase-3c-screens.md` records for OD-24. There is no issue tracker in this workspace either, so
the other half of the verification cannot be evaluated here at all. **The request below has not been sent**;
no date can honestly be recorded for it. What can be recorded is that the work proceeded on the default, and
this file is that record.

## The row, verbatim

> **Multi-branch stock** — "Warehouse per branch, transfers between them, stock and margin visible per
> branch" (legacy: `Warehouses` (tree), `MunIsTrans`).

**Deviation, recorded rather than silently corrected: three documents give this row three different line
numbers, and all but one are wrong.** Plan 3D Task 12 cites **spec:1021**; Plan 3A assumption 12 and contracts
§2.12's OD-05 "Gates" cell both cite **spec:1023**. The row is actually at **spec:1022**, and spec:1023 is the
*Purchase in foreign currency* row that OD-05 gates for slice **3C**. This file uses spec:1022 and says so;
correcting the two plans and the register is a one-line amendment in each, not a decision, and is listed in
the slice report rather than made here. The row's **text** is identical in all three citations, so nothing was
built against the wrong sentence.

The closely related §3.0.4 row this slice also implements is **spec:1053** — "**Two-step inter-branch
transfer** — dispatched into an in-transit warehouse, received at the branch, variance on receipt" — whose
line number every document agrees on, and which the **Phase 3 definition of done** (spec:2289) turns into a
provable clause: *"goods in transit are in neither warehouse's on-hand and in the company's total."*

## The three questions the row leaves open, and the assumption each is built on

| # | Question | Assumption built | Where it lives in this tree |
|---|---|---|---|
| 1 | Two-step transfer with an explicit in-transit state, or a one-step "move stock now" transfer? | **Two-step.** spec:1053 is a §3.0.4 row of its own, and the Phase 3 DoD names the in-transit clause — a one-step transfer makes that clause meaningless rather than false | `packages/db/seed/my/document-types/TRANSFER.json` + `TRANSFER_RECEIPT.json`; `packages/db/src/inventory/transfer.ts` (Tasks 7, 8) |
| 2 | One in-transit warehouse per receiving branch, or one per (source, destination) pair? | **Per receiving branch** — ADR 0043 decision 1. The question a branch manager asks is "what is on its way to me", and the answer must be one warehouse's on-hand, not a sum over one row per sending branch | `resolveInTransitWarehouse(tx, toWarehouseId)`, `packages/db/src/inventory/transfer.ts:49` |
| 3 | Is a receipt variance routine (posts to a loss account) or an exception (blocks the receipt until investigated)? | **Routine, posted to `5110`.** spec:1053's "variance on receipt" states no workflow, and blocking a receipt would leave stock in the corridor indefinitely | `TRANSFER_RECEIPT.json`'s variance legs; `approval.required` is `false` |

**One correction to the plan's own description of question 3's artefact.** Plan Task 12 and Task 13 both speak
of "`TRANSFER_RECEIPT`'s **four** ledger rules". The seeded policy carries **six**: the two `1310` ↔
`item.inventory_account` legs that move the goods' value out of the corridor, plus **two pairs** of variance
legs — `5110` debit / `1310` credit when `line.quantity_sign` is `negative` (a shortfall) and `1310` debit /
`5110` credit when it is `positive` (an overage). The plan's count omits the overage pair. Every sentence
about *what* the rules do is correct; only the number is wrong, and the six rules are what
`packages/db/test/inventory/transfer-receipt.test.ts` asserts (a full receipt posting no variance, a shortfall,
an overage, and the corridor clearing exactly in all three).

## What is built, and where the assumption is visible

- **`TRANSFER`** — `direction: internal`, `requires: ["warehouse", "to_warehouse"]`,
  `inventory.effect: "transfer"` with `to_warehouse: "header.to_warehouse"` resolved by `draftTransfer` to the
  **corridor**, not to the destination; ledger legs debit `1310` (goods in transit) and credit the item's
  inventory account; series `TRF`; `dimensions.required: ["BRANCH"]`.
- **`TRANSFER_RECEIPT`** — the mirror, plus the two variance pairs above; series `TRR`;
  `reversal.allowed: false` (the correction route is a `STOCK_COUNT`, per `docs/runbooks/stock-count.md`).
- **The destination survives the corridor in a custom field, not a column.** `draftTransfer` writes
  `final_warehouse_id` (`FINAL_WAREHOUSE_FIELD`, `packages/db/src/inventory/transfer.ts:34`) as a document
  custom field, created on first use with `on conflict do nothing`; `draftTransferReceipt` reads it back.
  ADR 0043 decisions 3–4 are why `document_line` gained no `to_warehouse_id` column.
- **A missing in-transit warehouse raises**, naming the branch, and never falls back to the destination —
  ADR 0043 decision 2. A fallback is arithmetically harmless and makes the DoD clause *silently* false.
- **The DoD clause's arithmetic has one query, not two.** `stockOnHandTotals`
  (`packages/db/src/reports/stock-on-hand.ts:121`) returns `onShelves`, `inTransit` and `total` from a single
  statement, so no caller can read the shelves and the company total at two instants and report a total that
  never existed. The report route's `includeInTransit` defaults to **`false`**
  (`packages/contracts/src/inventory/reports.ts:52`), which is the first half of the clause.

**None of this has been observed to run.** `packages/db` is container-backed and there is no Docker daemon in
this sandbox; `transfer.test.ts` (11 cases, including one named "THE DoD CLAUSE") and `transfer-receipt.test.ts`
(12 cases) typecheck against the real exports and have never executed. That is the gap `AGENTS.md` records for
Phases 0–2, unchanged. The assumptions above are therefore **assumptions about intent that are also unproven
in execution**, and the owner's answer does not change that second fact either way.

## If the owner confirms the row as written

Tick nothing else. Note the confirmation and its date below, and the slice is already the answer. This is the
expected outcome and the one §2.12's default describes.

> *Confirmation: not received as at 2026-09-20.*

## If the owner rejects the two-step transfer (question 1)

Plan Task 12 Step 3 lists four files. **Against this tree that list is incomplete**, and the honest list is
below. The additions are routes, seed tests and a runbook — no new design decision hides in any of them, but a
reversal that touched only the plan's four would leave a registered route with no handler and three seed tests
red.

| File | What changes |
|---|---|
| `packages/db/seed/my/document-types/TRANSFER.json` | `inventory.to_warehouse` stays `"header.to_warehouse"` but now resolves to the **destination**; the `1310` leg pair is **deleted** (a one-step move debits and credits the item's inventory account at two warehouses, which nets to nothing in the ledger — which is exactly why `1310` exists only for the two-step form) |
| `packages/db/seed/my/document-types/TRANSFER_RECEIPT.json` | **deleted**; its contracts §4.14 row struck (§4.14 line 391) |
| `packages/db/src/inventory/transfer.ts` | `resolveInTransitWarehouse`, `draftTransferReceipt`, `FINAL_WAREHOUSE_FIELD` and the custom-field definition helper deleted; `draftTransfer` sets `to_warehouse_id` to the destination and drops the `custom_fields.final_warehouse_id` write |
| `packages/db/src/index.ts` | the deleted exports removed from the barrel |
| `apps/api/src/inventory/count-handlers.ts` | `POST …/documents/{documentId}/receipt` — its `createRoute` and handler deleted |
| `apps/api/src/routes/accounting/documents.ts` | the `documentRoutes.openapi(transferReceiptRoute, transferReceiptHandler)` registration deleted |
| `packages/contracts/src/inventory/transfer.ts` | `TransferReceiptBody` deleted; `packages/contracts/openapi.json` regenerated |
| `packages/db/test/inventory/transfer.test.ts` | the two in-transit cases and the DoD case replaced by a single "source down, destination up, company total unchanged" case |
| `packages/db/test/inventory/transfer-receipt.test.ts` | **deleted** (12 cases) |
| `packages/db/test/inventory/policies.ts`, `test/seed/document-types.test.ts`, `test/seed/permission-phase3d.test.ts`, `test/seed-idempotent.test.ts` | the `TRANSFER_RECEIPT` row struck from each pinned list |
| `packages/domain/test/posting/evaluate-transfer.test.ts` | the receipt-policy cases dropped; `packages/domain/src/posting/evaluate.ts` is **unchanged** (it names the code only in a comment) |
| `tests/invariants/test-07-one-costing-answer.test.ts` | the two-step transfer leg of the acceptance scenario becomes a one-step move; the transfer-shortfall tie-out is dropped |
| `apps/api/test/routes/accounting/documents.test.ts` | the receipt-route cases dropped |
| `docs/runbooks/stock-count.md` | the "correcting a mis-counted transfer receipt" section (line 113) struck |
| `docs/adr/0043-…md` | superseded; ADR 0042 is unaffected (it is `STOCK_COUNT`'s variance schema, which stands alone) |

**What does *not* change.** Task 10's `includeInTransit` parameter and `stockOnHandTotals`' `inTransit` member
stay: `warehouse.kind = 'in_transit'` is 3A's column (migration 0029) and other slices may still use it.
`1310` stays in `chart-of-accounts/3c-purchasing.json` — it is 3C's seed, not this slice's.

**And the Phase 3 definition of done changes, which is the owner's to accept and not this slice's to
reinterpret.** "Goods in transit are in neither warehouse's on-hand and in the company's total" has no meaning
without an in-transit state. Escalate the clause; do not quietly redefine it.

## If the owner wants a blocking variance instead of a posted one (question 3)

`TRANSFER_RECEIPT`'s `approval` gains `required: true` with `approve: "inventory.adjustment.approve"`, so a
receipt whose counted quantity differs needs the accountant — and **only that**. The six ledger rules, the
two-quantity movement and `5110` are unchanged: a variance still posts, it just posts later.
`draftTransferReceipt` needs no change at all, because the transition is the caller's. One test file gains a
case (`transfer-receipt.test.ts`: a variance receipt refuses to post unapproved); nothing else moves.

## If the owner wants one corridor per (source, destination) pair (question 2)

`resolveInTransitWarehouse`'s single `select` gains the source branch in its `where`, and its doc comment and
ADR 0043 decision 1 are rewritten. No seed, no policy, no migration and no contract changes — the corridor is
resolved by lookup, never named on the wire, which is the property ADR 0043 was written to get. This is the
cheapest of the three answers to reverse, and deliberately so.

## The owner request, ready to send

> **OD-05, the "Multi-branch stock" row (spec:1022) and the two-step transfer (spec:1053).** We have built
> both to the spec text as written. Three specifics need a yes or no, because each changes a default rather
> than a feature:
>
> 1. **Two-step transfers.** Today a branch dispatch puts stock into an "in transit" holding area and the
>    receiving branch confirms what actually arrived. Is that how your branches work — or does stock simply
>    move from one branch to the other the moment it is sent?
> 2. **One "in transit" area per receiving branch.** A branch manager sees one list of everything on its way
>    to them, whichever branch sent it. Is that the right view, or do you need to see it separated by sending
>    branch?
> 3. **Short deliveries between branches.** If ten cartons are sent and nine arrive, we book the missing
>    carton as a loss and let the receiving branch carry on. The alternative is to stop the receipt until
>    someone investigates — which means the stock stays "in transit" on the books until they do. Which do you
>    want?
>
> **Verify:** the answers attached to this task, or one file in `docs/owner/od-05/3d/`. **Until provided:**
> nothing is blocked; slice 3D ships on the defaults above and `docs/decisions/od-05-3d-multi-branch-stock.md`
> records exactly what reverts under each alternative.
