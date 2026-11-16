# ADR 0043 — In-transit warehouse resolution and the two-step transfer protocol

- **Status:** Accepted — a low-risk implementation choice, recorded and executed under AGENTS.md's "Change
  Discipline" clause, and implemented in the same PR (3D Task 7). It adds no table, no column and no
  migration; decisions 1–4 are about where a uuid is written and which row is looked up, not about money.
  **Decision 5 is the exception and is not this ADR's to accept:** the variance arithmetic it describes lives
  in `evaluatePolicy` under **ADR 0042, which is still a _proposal_** (spec:95 — money semantics). If the
  owner rejects 0042, decision 5 falls with it and the receipt leg becomes an exact-quantity receipt;
  decisions 1–4 stand either way.
- **Date:** 2026-09-05
- **Slice:** 3D
- **Spec:** spec:1053 (the two-step transfer), spec:2289 (the Phase 3 definition of done — "goods in transit
  are in neither warehouse's on-hand and in the company's total"); contracts §4.2.11 (custom fields as
  core's extension point), §4.3.4 (`document` and `document_line`), §4.4.1 (`inventory.to_warehouse`),
  §4.4.2 (`planMovements`), §4.7.3 (`inventory_movement`, `stock_on_hand`); §3.4.1 (unused migration
  numbers stay unused). Part I SAH-018.

## Context

spec:1053 requires a two-step inter-branch transfer: "dispatched into an in-transit warehouse, received at
the branch, variance on receipt", and the Phase 3 definition of done requires that goods in transit be "in
neither warehouse's on-hand and in the company's total". Three things had to be decided and none is in the
spec: how many in-transit warehouses exist and what they are keyed by; where the ultimate destination is
recorded between dispatch and receipt; and whether `document_line` gains a `to_warehouse_id` column.

## Decision

**1. One `kind = 'in_transit'` warehouse per receiving branch**, resolved by
`resolveInTransitWarehouse(tx, toWarehouseId)` as "the in-transit warehouse whose `branch_id` is the
destination's branch". Not one per (source, destination) pair, and not one per company. The question a branch
manager asks daily is _"what is on its way to me"_, and the answer must be one warehouse's on-hand rather
than a sum over one row per sending branch. A company-wide corridor would answer that question wrongly for
everyone. `app.warehouse` already carries `kind` and `branch_id` (3A, migration 0029), so this needs no table
and no column.

**2. A missing in-transit warehouse raises `ERR_VALIDATION_FAILED` naming the branch**, and never falls back
to the destination warehouse. The fallback is arithmetically harmless and makes the definition-of-done clause
silently false: the destination's on-hand would rise at dispatch. A configuration gap must be loud, and the
message says exactly what to create.

**3. `document.to_warehouse_id` is the in-transit warehouse; the final destination lives in the document
custom field `final_warehouse_id`.** The policy's `to_warehouse: "header.to_warehouse"` is what the receipt
movement resolves from, so the header column must hold the corridor. The destination is read once, by the
receipt drafting service, and one uuid does not earn a column (§4.2.11 makes the custom-field bag core's
extension point for exactly this).

> **Where that bag actually is.** The 3D plan's draft of this decision said
> `document.custom_fields.final_warehouse_id`. **`app.document` has no `custom_fields` column** — migration
> 0011 gives one to `app.document_line` and nothing has ever given one to the header. The header's bag in
> this tree is `app.custom_field_value` keyed by a `custom_field_definition` of `entity = 'document'`
> (migration 0006), which is precisely what `loadSnapshot` reads into `DocumentSnapshot.header.customFields`
> and what `when: { "document.<code>": … }` resolves against. `draftTransfer` therefore creates that one
> definition on first use (data, never DDL) and writes the value through the existing `setValues` service.
> The decision is unchanged; only the plan's spelling of the storage was wrong.

**4. `document_line` gains no `to_warehouse_id` column.** 3A's assumption 3 left the column to this slice "if
it needs one". It does not: a dispatch note travels to one place, so one destination per document is the
honest shape, and a transfer to two branches is two documents — which is also how two receiving branches
acknowledge independently. `planMovements` already resolves `"line.to_warehouse"` to
`line.toWarehouseId ?? header.toWarehouseId`, and `LineSnapshot.toWarehouseId` stays the constant `null` 3A
made it. Migration **0043**, allocated to this slice, stays unused (§3.4.1).

**5. The receipt leg's quantity may differ from the dispatch leg's.** `TRANSFER_RECEIPT` carries
`expected_quantity` (what was dispatched) and `counted_quantity` (what arrived) on each line; the evaluator
rule gives the issue movement the expected quantity and the receipt movement the counted one, and the
difference posts to `5110`. This is the only in-schema place spec:1053's "variance on receipt" can live,
because `inventory.effect` is one value per policy. **ADR 0042 records that rule and is a proposal**; this
ADR records that the two-step protocol is what needs it.

## Consequences

- A tenant must configure one in-transit warehouse per branch before transferring to it. That is a seed-pack
  and onboarding fact, not a code fact, and the error message says exactly what to create.
- Goods in transit are visible: `1310` carries their value and the in-transit warehouse carries their
  quantity, both queryable per branch. The legacy system had `MunIsTrans` as a boolean on a warehouse row and
  no ledger account at all.
- A dispatch that is never received leaves stock in transit indefinitely and visibly. Ageing that balance is
  7B's `inventory.transfer_register` report, not a job that guesses.
- `stock_on_hand` needs no change: the in-transit warehouse is a warehouse, so the projection's own MERGE
  handles it, and every report that wants "real" stock filters on `warehouse.kind = 'stock'` (Task 10).
- The `final_warehouse_id` definition is visible on the custom-field definitions endpoint and on any screen
  that lists them. That is the price of using core's extension point instead of a column, and it is the
  cheaper of the two: a header column is a §4.3.4 amendment and a migration on a live table.

## Amendment — branch-restricted transfers, 2026-10-23 (accepted 2026-11-04; implemented in migration 0119)

- **Status:** **Accepted by the owner on 2026-11-04, with every recommended default below; implemented in
  migration 0119** (`packages/db/migrations/0119_admit_transfer_receipt_at_receiving_branch.sql`, registered
  in Plan Contracts §3.4.1's tail). It was a proposal (spec:95 — security and the data model), raised by the
  Phase 6 plan audit. Decisions 1–5 are unchanged. The questions are kept as the owner answered them; what
  was built is under *Implementation* at the end.
- **Why.** ADR 0062's 2026-10-23 amendment records that, after 6C's migration 0068, no principal restricted
  to one branch can complete an inter-branch transfer, the seeded `branch_manager` included, although
  spec:2160 gives that role "receiving transfers". The "after 0068" cases in
  `packages/db/test/inventory/transfer-receipt.test.ts` and
  `apps/api/test/routes/accounting/document-transfer.test.ts` pinned that behaviour until migration 0119.
  Three of this ADR's choices meet 6C's row policies there:
  - the dispatch carries the sending branch;
  - the receipt copies the dispatch's branch and is gated at it;
  - the dispatch names a destination stock warehouse that only its own branch can see.

**Questions for the owner, each with the default this proposal recommends:**

1. **Which branch stamps and gates the receipt.** *Recommended:* the receiving branch. `draftTransferReceipt`
   would stamp the `TRANSFER_RECEIPT` with its corridor's branch. Under decision 1 the corridor and the
   final warehouse are always the same branch. The receipt route would ask `actor_has(approval.create,
   company, that branch)` instead of resolving the dispatch's branch. The receipt's post would then be gated
   at the receiving branch by 2B's status trigger, with no further change.
2. **How the receiving branch reads the dispatch.** It needs the dispatch's header, lines and
   `final_warehouse_id`, and it must not get them through a `SECURITY DEFINER` function or a permissive
   policy (ADR 0062). The receipt also links to the dispatch lines (`receives_against`), and migration 0037's
   link guard reads the source line.
   - *Option a — recommended.* Change Form A on `app.document` for one case only: a posted document whose
     `to_warehouse_id` is an in-transit warehouse of a branch the actor is in. It stays restrictive. The
     parent guard then exposes the dispatch's lines to that branch alone, and to no other document.
   - *Option b.* Build the receipt from the corridor's own rows, which Form C already shows to B, and drop
     the line link. This loses what the `receives_against` link records: the dispatch's residual open
     quantity, which is the record of what never arrived, and migration 0037's refusal of a second receipt
     of the same dispatch.
   - Either option is a change to a security policy, and 6C's "where to stop" rule forbids making it
     without this decision.
3. **Which branch gates the dispatch, and how the sending branch names a destination it cannot see.**
   *Recommended:* gate the create stage at the source warehouse's branch, which is the branch the draft
   carries, and not at the branch the body supplies. Resolve the destination's corridor through a bounded,
   company-bound lookup of the destination's branch. A broader change is not needed: Form A″ already shows
   the corridor to the sending branch, and the dispatch's post on A's authority alone already works.
   Related, and a defect rather than a decision: the create gate reads a `branchId` that
   `TransferDraftBody` does not declare and the handler discarded. A caller could therefore steer the gate
   to a branch other than the one the draft will carry (reported 2026-10-23 alongside this proposal).
   *Fixed 2026-10-24:* `TransferDraftBody` is `.strict()`, as 3D Task 7 specified, so a body naming a
   `branchId` is refused 400 and the gate asks for company-wide authority again. The regression case is in
   the "after 0068" block of `apps/api/test/routes/accounting/document-transfer.test.ts`. This closes only
   the defect; the question above stays the owner's.

**The owner's answers (2026-11-04):** the recommended default on all three — the receiving branch stamps
and gates the receipt; option a; and the dispatch's create stage gated at the source warehouse's branch, with
the destination's corridor found through a bounded, company-bound lookup of the destination's branch.

### Implementation (migration 0119, 2026-11-04)

**1. The receipt is the receiving branch's document.** `draftTransferReceipt` stamps the `TRANSFER_RECEIPT`
with its corridor's branch, read from the dispatch's `to_warehouse_id` and required to be an `in_transit`
warehouse of the dispatch's company. A dispatch with no such corridor is refused as before ("it was not drafted
by draftTransfer"). `POST …/documents/{id}/receipt` keeps its `submit` stage and the dispatch's policy, so it
still asks `approval.create ?? approval.post`, `inventory.transfer.create` as seeded. It now asks that code at
the corridor's branch, through the gate's new `branch` option (`transferReceiptBranch` in
`apps/api/src/inventory/count-handlers.ts`), and no longer at the dispatch's branch. A path document with no
corridor is asked at its own branch, as before, and the service refuses it. The receipt's post is gated at the
receiving branch by 2B's status trigger, with no change there.

**2. Option a, and the widened read is a read.** 0119 replaces Form A on `app.document`:

```sql
create policy branch_isolation on app.document as restrictive
  using (app.actor_in_branch(company_id, branch_id)
         or (status = 'posted'
             and exists (select 1 from app.warehouse w
                          where w.tenant_id = document.tenant_id and w.company_id = document.company_id
                            and w.id = document.to_warehouse_id and w.kind = 'in_transit'
                            and app.actor_in_branch(w.company_id, w.branch_id))))
  with check (app.actor_in_branch(company_id, branch_id));
```

It stays `AS RESTRICTIVE`, with no `SECURITY DEFINER` and no permissive policy. The corridor lookup is bound to
the document's tenant and company and is itself subject to `app.warehouse`'s policies. The unchanged USING of
`document_parent_visibility` then shows the dispatch's lines to the receiving branch alone. So the receipt's
`receives_against` links, migration 0037's link guard, the dispatch's residual open quantity (what never
arrived — superseded by the 2026-11-15 amendment below) and the refusal of a second receipt all work for that branch as they do for a wider principal. A
draft or issued dispatch stays the sender's, and a third branch is in neither the dispatch's branch nor the
corridor's.

Only reads are widened; every write still needs the writer's own branch:

- Form A's WITH CHECK is written out as 0068's predicate. The receiving branch cannot UPDATE the dispatch
  header: a no-op re-save is refused by that WITH CHECK, and a move into its own `branch_id` is refused first
  by 0117. Nor can it reverse the dispatch, because the mirror `reverseDocument` drafts is the sender's row.
- `document_parent_visibility`'s WITH CHECK now asks that a line's parent pass `actor_in_branch` (that it be
  writable), not merely that it be visible. For every row visible before 0119 the two are the same condition.
  This one is load-bearing. 0113 admits a `cost` change on a posted line, for the cost replay. Without the
  tightened check, the receiving branch could rewrite the sender's posted dispatch-line `cost`: a one-off
  probe on 2026-11-04 that kept 0068's WITH CHECK showed that UPDATE succeed.
- A line INSERT is refused by 0113, and a DELETE of the header or a line by 0023's draft-only guards. The
  widened read admits only POSTED documents, so every write path is refused.

**3. The dispatch's create stage is gated at the source warehouse's branch.** `POST …/documents/transfers`
asks its `create` stage at the source warehouse's branch (`transferSourceBranch` in
`apps/api/src/inventory/transfer-handlers.ts`). That branch is read under the caller's own policies and bound to
the path company. It never comes from a body `branchId`, which the strict body still refuses. A source the
caller cannot see resolves no branch, so the gate asks for company-wide authority, as before.

The handler now binds only the source to the path company. `draftTransfer` reads the source first, then
resolves the destination inside the source's company: `resolveInTransitWarehouse(tx, toWarehouseId,
companyId)` is now company-bound. When the destination is hidden from the caller, its branch comes from
`app.transfer_destination_branch(company, warehouse)`. That function:

- returns the branch of a live `stock` warehouse of that company in the current tenant, and nothing else;
- answers only a principal that holds a live role in that company;
- is `SECURITY DEFINER`, owned by `app_auth` (NOLOGIN, no BYPASSRLS, assumable only by `app_migrator`), with
  a fixed `search_path` and no PUBLIC EXECUTE;
- reads six warehouse columns granted to `app_auth`, and `tenant_isolation` still applies inside it;
- is no policy's predicate.

It follows the pattern of 0068's `resolve_cashier_employee`. For `app_auth` to read the row at all, Form A″ is
scoped `to app_rw, app_migrator`, as 0068 scoped Form A′ and `terminal_enrolment`'s Form A for their
resolvers. Its USING is unchanged, so for the application roles B's stock warehouse is still hidden from A.
The corridor itself needed nothing: Form A″ already showed it to every branch.

**Judgement calls the owner may revisit:**

- The lookup is a `SECURITY DEFINER` function. The answer named "a bounded, company-bound lookup" without
  saying how. Reading a row Form A″ hides needs either a definer over a re-scoped policy, or switching the
  actor to the system principal as ADR 0061's amendment does. The definer fails closed if a later policy is
  added, and it impersonates no one.
- The receipt route keeps the dispatch's policy as the source of its code. The answer said "instead of
  resolving the dispatch's branch", so only the branch moved. The two seeded policies name the same create
  code.
- The generic document read routes still ask read authority at a document's own branch. A principal
  restricted to the receiving branch therefore reads the dispatch through RLS, which the receipt route uses,
  and not through `GET …/documents/{id}`. A screen listing incoming dispatches would need its own gate (OD-24).

The policy count is unchanged: nineteen `branch_isolation` policies plus the one child guard. The proof is
the "after 0068 and 0119" cases in `packages/db/test/inventory/transfer-receipt.test.ts` and
`apps/api/test/routes/accounting/document-transfer.test.ts`, which pinned the refusals until this amendment.
They now cover:

- a principal restricted to A dispatches, and one restricted to B receives and posts at B;
- a second receipt is refused, and the dispatch reads nothing open at B (amended 2026-11-15, below);
- a third branch sees no header, line or receipt, and the sender cannot read the receipt;
- every write path from B onto the dispatch is refused;
- the lookup's bounds and the two-tenant stop;
- the controls: both branches, and company-wide.

## Amendment (2026-11-15) — a dispatch line is received at most once; a total loss consumes it

- **Status:** _Proposed_ — a change to how a receipt is linked to its dispatch (the data model) and to what
  leaves the corridor (money semantics), so it is the owner's to accept. Implemented ahead of approval on branch
  `claude/fix-transfer-receipt-once`, as the full review of 2026-11-15 directed (findings INV-01, blocker, and
  INV-05). No migration: the link guard (0116) and the view are unchanged.
- **Supersedes:** in the 2026-11-04 implementation section above, "the dispatch's residual open quantity (what
  never arrived)" and the test bullet "the residual open quantity is readable at B". What never arrived is now
  the receipt line's variance, not an open quantity on the dispatch.

**The defect.** `draftTransferReceipt` set every receipt line's `expected_quantity` to the whole dispatched
quantity and linked only what arrived: `least(counted, expected)`, or NULL for a total loss, because the link
table refuses `0.000000`. The guard bounds `Σ link.quantity`, and a NULL link adds nothing to it. So a dispatch
received as a total loss stayed fully open, and a second receipt of it posted. Receiving 6 and then 4 of one
10-unit dispatch did the same. Each receipt took the full expected quantity out of transit, so 20 units left the
corridor for a 10-unit dispatch. The second ten were another dispatch's goods, and that dispatch could then no
longer be received (`ERR_STOCK_INSUFFICIENT`). `PATCH …/counts` (`recordCounts`) made the same thing reachable
without a visible short receipt, by rewriting a draft receipt's counted quantity behind its link (INV-05).

**Decision.**

1. **A receipt line accounts for what is still open on its dispatch line.** `draftTransferReceipt` reads each
   dispatch line's open quantity through 3C's `openQuantity` (the view of 0116), after it takes the line's
   `document_link:` advisory lock. That figure becomes the line's `expected_quantity`, which is what movement 1
   takes out of transit. On a dispatch that no live receipt holds, it equals the dispatched quantity, as before.
2. **The link quantity is that same expected quantity, whatever arrived.** A full arrival, a shortfall, an
   overage and a total loss all link the whole expected quantity. A total loss no longer links NULL. What never
   arrived is the line's variance (`counted − expected`, posted to `5110`). An overage still links at the
   expected quantity, as before, because more arriving than left is a variance and never a larger fulfilment.
3. **Nothing open, nothing received.** A receipt of a dispatch with nothing open is refused
   `ERR_DOC_LINK_OVER_FULFILLED`, and so is a `received` entry naming a dispatch line with nothing open. A line
   with nothing open is not drafted. Because every receipt consumes everything open, a live receipt leaves the
   whole dispatch received.
4. **Release is the link's ordinary release.** A draft receipt holds its claim. A void receipt releases it (ADR
   0040 decision 4 and 0116's chain rule), and the dispatch can be received again. `TRANSFER_RECEIPT`'s policy
   forbids reversal, so a void is the one path.
5. **`recordCounts` writes count sheets only.** It refuses (`ERR_VALIDATION_FAILED`, 400 on `PATCH …/counts`)
   a document whose policy is a transfer (`inventory.effect: "transfer"`, decided by policy shape, never by type
   code) or which is the target of any fulfilment link. A mistaken receipt is voided and drafted again.

**Trade-off the owner may revisit.** A short receipt is final. The units that did not arrive are written off to
`5110` at once, and a late second delivery against the same dispatch is not possible. Late goods come in through
a `STOCK_COUNT` surplus (or a new transfer). The alternative is to leave a shortfall in transit until a later
receipt or an explicit write-off clears it. That needs a "close the dispatch" action and a decision on when the
loss is booked. It is not built.

**Proof.** The "full review INV-01/INV-05" cases in `packages/db/test/inventory/transfer-receipt.test.ts`: a
total loss and then a full receipt, and 6 and then 4 of 10, each refuse the second receipt and leave the other
dispatch's 10 in the corridor; a void receipt releases the dispatch; `recordCounts` refuses a draft receipt.
Also the `PATCH …/counts` case in `apps/api/test/routes/accounting/document-transfer.test.ts` and the SAH-017
block "A transfer dispatch is received at most once". The 2026-11-04 case for the receiving branch now expects
the link to account for the whole line (3, not 2) with nothing left open.

## Amendment — a received dispatch cannot be reversed, 2026-11-16 (review MON-03)

- **Status:** _Proposed_. It writes down a rule the code now enforces; the owner may replace it.

**Context.** Decision 1 gives every receiving branch one in-transit warehouse, shared by every dispatch to it.
`reverseDocument` mirrors a document whole, so the mirror of a dispatch issues the dispatched quantity out of
that warehouse. Once a `TRANSFER_RECEIPT` has taken those units out, the mirror takes another dispatch's goods
instead: the sender's books gain stock it never got back, `1300` is overstated by the dispatch's cost, the
corridor reads empty while the other shipment is on the road, and that shipment's receipt is then refused
`ERR_STOCK_INSUFFICIENT`. Nothing in this ADR or the spec said whether a received dispatch could be reversed,
and `reverseDocument`'s dependant guard read `returns` and `converts_to` links but not `receives_against`.

**Decision.** A dispatch is refused reversal (`ERR_DOC_STATUS_ILLEGAL`) while any document linked to it by
`receives_against` is not void — posted, issued or draft.

- A **posted** receipt blocks for good. Its policy forbids reversal (decision 5's variance makes a mirror
  wrong), so the goods have arrived. A mistaken transfer is undone by a new TRANSFER back, and a mis-count by
  a STOCK_COUNT at the receiving branch.
- An **unposted** receipt blocks too, as an unposted `converts_to` target does. Posting it after the
  reversal would drain the corridor the mirror already emptied. The remedy is to void it (issued) or discard
  it (draft), and then reverse.
- No receipt can be drafted after the reversal commits: `draftTransferReceipt` receives only a posted
  transfer, and 0110's link trigger admits only an issued or posted source.

**Consequences.** One residual is not closed here. `draftTransferReceipt` reads the dispatch without a row
lock, so a receipt drafted concurrently with the reversal can read the dispatch as `posted` before the
reversal commits. Its link insert then waits on the reversal's `for update` (the foreign key's `FOR KEY
SHARE`) and commits a draft receipt against a reversed dispatch. Closing it needs a `for share` read in
`draftTransferReceipt`, as `convertToInvoice` does, or a post-time check that the dispatch is still posted.

**Proof.** `packages/db/test/inventory/transfer-reversal.test.ts` and SAH-018's "review MON-03" block in
`tests/regression/sah-018.test.ts`.
