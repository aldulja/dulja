# OD-05 — Customer credit control (§3.0.3, spec:1026), as slice 4A built it (Plan 4A Task 12)

- Asked: not yet sent — the request at the end of this file is ready to send; there is no issue tracker in
  this workspace and no date can honestly be recorded for a request that has not gone out
- Answered: pending
- Decision: pending — the default (the spec text as written) stands until the owner answers
- Credit hold wanted: pending (asked below; built as a hold under the default)
- Recorded by: the 4A Task 12 agent, 2026-09-28, as a pending record. The owner's answer is recorded by
  whoever receives it, on the `Decision:` line above

**Status:** ⚠️ **UNCONFIRMED — built at §2.12's stated default (the spec text as written).** This is a
*decision record*, not an ADR: it decides nothing. It states what the slice assumed while waiting for the
owner, and exactly what reverts if the answer is "no", so that the answer is cheap to apply and impossible to
apply half-way. It follows the shape of Phase 3's record, `docs/decisions/od-05-3d-multi-branch-stock.md`.

**Nothing is blocked by this record.** Plan 4A Task 12 is "one isolated task, droppable without renumbering
any interface". Tasks 3 and 5 are built to the default, and Task 14's slice exit does not wait on it.

## The gate, and what it checks

Plan 4A Task 12 Step 1 gives the verification as:

```
test -s docs/review/2026-09-05-od-05-credit-control.md \
  && grep -qE '^- Decision: (confirmed|declined)$' docs/review/2026-09-05-od-05-credit-control.md \
  && echo "OD-05 recorded"
```

**It does not pass, and it cannot pass without deciding.** Its second half accepts only `confirmed` or
`declined`, and the owner has said neither. Writing either word would record a decision nobody made. The
`Decision:` line above says `pending`, and the grep fails on it. That failure is the correct result.

**The path is also different, deliberately.** The plan names `docs/review/2026-09-05-od-05-credit-control.md`.
Phase 3's OD-05 record is in `docs/decisions/`, so this record is there too, where the next reader of OD-05
will look. When the owner answers, change the `Decision:` line here. The plan's command then passes with this
path in place of the plan's.

`docs/owner/` does not exist and never has, in any phase. No owner material has been received for OD-05.

## The row, verbatim

> **Customer credit control** — "Distribution runs on credit; needs limits, ageing, and a block on over-limit
> sales" (legacy: `Accounts.MaxLimit`, `DebtAge`). — spec:1026

The coverage row this slice owns is **spec:1042**: "Customers/vendors (Party), sales and purchase invoices,
credit notes, receipts/payments, allocation, ageing, credit limits, payment terms". Its only acceptance test
is test 8, which is 4B's. The override is **R8** (spec:2179): "Overrides — negative stock, credit limit, …
are explicit permissions exercised per document by a second principal and recorded as a `document_event`".

## What was asked

Does the business run credit control as spec:1026 describes — per-customer limits and a block on over-limit
sales? And does it also want a per-customer *hold* that no override lifts?

## What was built under the default

- **`party.credit_limit numeric(19,4)`**, null meaning no limit (not a zero limit), with
  `party_credit_limit_check (credit_limit is null or credit_limit >= 0)`. **`party.credit_hold boolean not null
  default false`**. Both are in migration 0045 (`0045_alter_party_and_document_add_credit_terms.sql`, 4A Task 3).
- **`app.assert_credit_available()`** runs on the trigger **`document_credit_control`**, a second
  `BEFORE UPDATE OF status` trigger on `app.document` beside 2B's. It fires when `status` becomes `issued`.
  It refuses the transition with **`ERR_CREDIT_LIMIT_EXCEEDED`** when the customer's open base balance plus
  this document's base total exceeds the limit. The only release is an `accounting.credit_limit.override`
  `document_event` recorded by a **second** principal. 2B's `document_event_override_guard` refuses the maker
  (spec:2179, §4.5.3).
- **`ERR_CREDIT_HOLD`**, raised first, which an override does **not** lift (§4.8.1 "blocks regardless").
- **`app.party_open_balance(p_party_id, p_as_of)`** is the one read of the customer's exposure. The trigger
  and **`creditStatus()`** (`packages/db/src/ar-ap/credit.ts`) both use it, so a screen cannot disagree with
  the control. It works in base currency (LEGACY-014) and coalesces at the sum (LEGACY-011). It **fails closed**
  with `ERR_POLICY_REQUIRES_MISSING` for a party that has a limit and no receivable account (LEGACY-042).
- **`accounting.credit_limit.override`** is one of 4A's seven codes (migration 0047), held by the seeded
  `accountant`. The parties module also requires it, beside `accounting.party.manage`, to set or clear
  `creditLimit`.
- **`docs/runbooks/credit-control-override.md`**, the two-principal procedure.
- **Proven against Postgres**, not just written: `packages/db/test/ar-ap/credit-control.test.ts` (16 cases,
  over the test-only `CREDIT_TEST` type) and the credit-control case of
  `packages/db/test/ar-ap/sales-invoice.test.ts`, which runs on the real `SALES_INVOICE`. The `legacy-042` 4A
  block and the `parties` route suite also cover it. All were green in this sandbox on 2026-09-28 (Task 14's
  exit report has the run).

Ageing is 4B's and is covered by 4B's own OD-05 task.

## Three questions the row leaves open, and the assumption each is built on

| # | Question | Assumption built | Where it lives |
|---|---|---|---|
| 1 | Is a per-customer **hold**, distinct from a limit, wanted? spec:1026 does not ask for one; §4.8.1 added it | **Yes, and not overridable.** It defaults to `false`, so nobody is on hold unless someone puts them there | `party.credit_hold`, `ERR_CREDIT_HOLD` (0045) |
| 2 | **Which documents** does "a block on over-limit sales" stop? | **Every document that sells on credit, at `→ issued`**: an outbound policy that names no `party.payable_account` rule (`app.policy_extends_credit`, since the code review of 2026-09-29). The trigger decides by policy shape, never by type code. Today that means `SALES_INVOICE` and also 3D's `DELIVERY_ORDER`, so stock cannot leave for a held or over-limit customer. A `PAYMENT`, `PURCHASE_RETURN` or `PURCHASE_CREDIT_NOTE` is **not** controlled: the first build decided by `direction` alone, so a vendor on hold could not be paid and a payment counted as credit exposure — a defect, not a reading of spec:1026. A refund cannot post at all yet (ADR 0047 open question 5). A reversal that lowers the exposure — a DELIVERY_ORDER reversed into DELIVERY_ORDER — is not controlled either (code review, second pass), so goods can always be taken back from a held customer | `app.assert_credit_available()` guard 2, `app.policy_extends_credit` (0045) |
| 3 | Is the limit compared in the **invoice currency** or in **base**? | **Base.** There is one bare `numeric(19,4)` limit per party, and a party may be invoiced in several currencies. Comparing in any other currency would repeat LEGACY-014 | `app.party_open_balance`, `creditStatus` |

Question 2's refund consequence was first recorded rather than fixed. The code review of 2026-09-29 narrowed
the trigger to documents that sell on credit, because payments to vendors were being refused; that narrowing is
part of what the owner confirms or rejects here. How a refund posts is still open (ADR 0047 open question 5),
so no refund reaches the trigger either way.

## If the owner confirms the row as written

Change `Decision:` to `confirmed`. Fill in `Answered:`, and set `Credit hold wanted:` from the owner's
sentence. Nothing else changes: the default *is* the spec text, built as designed. If the owner confirms the
limit but does not want the hold, apply only the hold half of the table below.

## If the owner declines

**A rejection is applied by a NEW migration, never by editing 0045.** 0045 is committed, and has run in
every test database. §3.4.7's expand/contract rule and §3.4.5's "a down file drops only what its own up
added" both forbid editing it, and §3.4.1 forbids renumbering.

**Finding: the plan's number for that migration no longer exists.** The plan puts the contract migration at
"the next free number in 4B's range, 0048–0052", owned by 4B. Against this tree, 0048, 0049 and 0052 are
taken, 0050 is `bank_match` (4B Task 7) and 0051 is `pdc` (OD-09). Once 4B lands, **no number in that range
is free** unless OD-09 is declined and 0051 is left unused. A "no" therefore also needs a number allocated
under Plan Contracts §3.4.1's ⚠️ proposal for a branch that is not a slice. That allocation is the owner's to
approve. It is not a number this record can take.

What that migration and PR remove, against this tree:

| Clause of spec:1026 | Built as | If the owner says no |
|---|---|---|
| "limits" | `party.credit_limit` + `party_credit_limit_check` (0045) | The contract migration drops both. `packages/db/src/schema/party.ts` loses the mirror entry. `PartySchema` / `CreatePartyBody` / `UpdatePartyBody` lose `creditLimit` (`packages/contracts/src/accounting/party.ts`). The parties route loses the field-level override check (`apps/api/src/routes/accounting/parties.ts`, `apps/api/src/routes/index.ts:172-174`). `creditStatus` and `packages/db/src/ar-ap/credit.ts` are deleted, with their line in `packages/db/src/ar-ap/index.ts`. `openapi.json` is regenerated |
| "a block on over-limit sales" | `document_credit_control` → `app.assert_credit_available()`, and `app.party_open_balance` (0045) | The same migration drops the trigger and both functions. `ERR_CREDIT_LIMIT_EXCEEDED` and `ERR_CREDIT_HOLD` leave `packages/contracts/src/errors.ts` in that PR, because the `error-codes` lint fails on a code nothing raises. `accounting.credit_limit.override` leaves `packages/contracts/permissions.ts`, the `accountant` grant in `packages/db/seed/roles.ts`, and `app.permission` / `app.role_permission` (the contract migration deletes the rows 0047 inserted). It also leaves the documents module's declared override codes (`apps/api/src/routes/index.ts:134`, 6d8e840), the overrides route's `OVERRIDE_CODES` (`apps/api/src/routes/accounting/documents.ts:677`) and the `overrides` body's enum (`packages/contracts/src/accounting/document.ts:230`). §4.5.3's `OverrideCode` union in `packages/db/src/posting/lifecycle.ts` **keeps** the member: 2B declared it. `docs/runbooks/credit-control-override.md` is deleted |
| "credit hold" (not in spec:1026; §4.8.1's addition) | `party.credit_hold`, `ERR_CREDIT_HOLD`, not overridable | Dropped with the limit, or on its own if the owner keeps the limit and declines the hold. Because §4.8.1 registers it, dropping it also amends that section |
| "ageing" | **Not this slice**: §4.8.2 and `accounting.ageing` are 4B's | Unaffected. 4B's own OD-05 task covers it |

**Tests removed with the columns, in that PR:** `packages/db/test/ar-ap/credit-control.test.ts` (all but the
`payment_term_id` and `price_list_id` cases, which stay); the credit-control case of `sales-invoice.test.ts`;
`tests/regression/legacy-042.test.ts`'s 4A block; the credit-limit cases of
`apps/api/test/routes/accounting/parties.test.ts`; the `creditOverride` option of
`tests/invariants/support/post-ar.ts`; and the three rows for this code in the pinned catalogue suites
(`permission-phase4a`, `permission-catalogue`, `roles-seed`, `packages/contracts/test/contracts.test.ts`).

**What does *not* change.** `payment_term` and both `payment_term_id` columns stay (`payment_term` is not a ⚠️
row). `party.price_list_id` stays (it is 6B's A10(b) and not credit control). Allocation stays. All six
document types stay, and so does the test-only `CREDIT_TEST` type in its suite's `beforeAll`: it names no
credit column. The 2B override machinery (`recordOverride`, `document_event_override_guard`) is unchanged.
The other override codes still use it.

## The owner request, ready to send

> **OD-05, the "Customer credit control" row (spec:1026).** We have built credit control as the spec
> describes it: each customer can have a credit limit, and a sale that would take them over it is stopped
> until a second person with the credit-override permission releases that one sale. Three things need a yes
> or no:
>
> 1. **Credit limits and the block.** Is that how you run credit today, with limits per customer and sales
>    stopped over the limit? Or do you not use credit limits at all?
> 2. **Credit hold.** We also built a separate "hold": a customer on hold cannot be sold to at all, and no
>    override lifts it, until someone takes the hold off. Do you want that? One sentence is enough.
> 3. **What the block stops.** Today it stops both the invoice and the delivery order, so goods cannot leave
>    for a customer who is over the limit. Payments to suppliers and returns to suppliers are not stopped.
>    Is stopping the delivery right? (Refunds to customers are not built yet; they are a separate question.)
> 4. **Who may take a customer off hold.** Today the clerk who maintains customers (`accounting.party.manage`)
>    can put a customer on hold and take them off it, while changing a credit limit needs the credit-limit
>    override permission. Should taking a customer OFF hold need that override permission too?
>
> **Verify:** the answers attached to this task, and the `Decision:` line of
> `docs/decisions/od-05-4a-credit-control.md` reading `confirmed` or `declined`. **Until provided:** nothing
> is blocked; slice 4A ships on the defaults above and this file records exactly what reverts.
