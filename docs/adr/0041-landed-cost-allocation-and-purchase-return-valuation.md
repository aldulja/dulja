# ADR 0041 — Landed-cost allocation, and how a purchase return is valued

- **Status:** Proposed — the allocation half is implemented behind it; the return-valuation half needs the
  owner's accountant to confirm (raised with OD-05's Landed cost row, Task 12)
- **Date:** 2026-09-07
- **Slice:** 3C
- **Spec:** spec:95 (an ADR proposal precedes a money-semantics change), spec:1020 (landed cost), spec:1049,
  spec:1698 (purchase return); Part I LEGACY-007, LEGACY-009, LEGACY-049

## Context

An import shipment's freight, duty, clearance and handling belong in unit cost. Two questions follow, and the
second is not obviously answerable from the spec.

1. **How is a cost line split across the goods lines, and where does the split live?**
2. **When those goods go back to the supplier, what value leaves stock — and what does the supplier owe?**

## Decision — the allocation

1. **Three methods, closed:** `by_value` (weights are the goods lines' `amount`), `by_quantity` (weights are
   `quantity`), `by_weight` (weights are `custom_fields.weight_kg`, a §4.2.11 custom field). The method is a
   parameter of the allocation call and is stored on every row it writes, so a shipment carrying two cost lines
   may split one by weight and the other by value — which is what a real customs bill does.
2. **The split is exact, by `Money.allocate` (§4.2.1) and never by a division.** `Σ allocated` equals the cost
   line's `amount` to the cent, with the largest-remainder residue going to the first weight. A division with a
   rounding fudge is how a shipment's freight comes to differ from the sum of its shares.
3. **The split is stored per (cost line × goods line) pair** in `app.landed_cost_allocation`, with
   `unique (cost_line_id, target_line_id)` as the upsert key. Every pair is written on every call, zero shares
   included, so a re-allocation replaces the whole split rather than adding to it.
4. **It reaches the layer exactly once, through the movement's value.** `receiptValue` (§4.7.2, Task 8) is
   `toBase(line.amount + Σ allocated, rate)`; `inventory_movement.value` is immutable and 3B's `replay`
   recomputes `unit_cost = value / quantity` from it. There is therefore no second path by which freight enters
   or leaves a cost, and **allocation is a draft-only operation** — enforced by a trigger, not by convention.
5. **The ledger reaches the same total by addition.** A receipt's ledger legs are all `line.amount` (a cost
   reference cannot post — §4.3.2 step 6 balances before step 9 fills it), so the freight is capitalised by the
   cost line's own debit to `1300`. Σ debits to inventory = goods amount + Σ cost amounts = the layer's value.

## Decision — the purchase return, and the part that is a proposal

A `PURCHASE_RETURN` is an **issue**, so its ledger legs are both `line.cost` (§4.3.4's rule) and its value is
what the costing engine says the goods carry — freight included. Two consequences, and the owner's accountant
should confirm both:

6. **Stock leaves at carrying cost, not at the supplier's price.** `line.cost` is the only expressible choice:
   §4.4.1's `amountRef` enumeration has no member meaning "the difference between two others", and inventing one
   is a schema change (a new `version` const and a new `$id`) rather than a plan's decision. It is also the
   right answer for the report that matters — valuation drops by exactly what `cost_consumption` records, so
   acceptance test 7 ties to the cent.
7. **The counterparty is `party.payable_account`, and the difference is 4A's.** The return debits trade
   payables at carrying cost: at Phase 3 it is a debit note against the supplier, which is what a returns
   document is. The supplier will credit the _goods_ price, not our freight, and the difference — freight spent
   on goods that went back — is recognised when 4A's `PURCHASE_CREDIT_NOTE` lands against this document. **We
   deliberately do not debit `2150` GRNI instead**, even though the receipt credited it: the policy cannot know
   whether the invoice has arrived, and one counterparty with a visible difference is better accounting than
   conditional accounting the policy cannot express.

## Consequences

- Re-allocating a shipment by a different method is a single idempotent call; there is no un-allocate endpoint
  and there never will be one, because `app_rw` holds no DELETE on the table (§3.5.4).
- A shipment posted before its landed cost was allocated has layers at the goods price only. That is not
  silently corrected: the remedy is `reverseDocument` and a re-post, and Task 9's DoD test performs exactly that
  sequence so the path is exercised rather than described.
- `by_weight` needs `weight_kg` on every goods line; a line without it is refused by name at allocation time
  rather than silently weighted zero.
- If the accountant rejects point 7, the change is two `account` refs in one seed file (`PURCHASE_RETURN.json`)
  and the two assertions in `purchase-return.test.ts` that name the account — no code, no migration. That is
  recorded here so the reversal cost is known before the question is asked.

## Amendment (2026-11-15, full review INV-03) — a capitalised cost line posts only when wholly allocated

- **Status:** Proposed — implemented ahead of approval on `claude/fix-landed-cost-unallocated`, as the rest of
  this ADR was.

**Context.** The Consequences above assumed a shipment "posted before its landed cost was allocated has layers
at the goods price only". That was true of the layers but not of the ledger: `GOODS_RECEIPT` and `SHIPMENT` debit
`1300` by every `line.kind: account` line's amount whether or not it was allocated, while `applyMovements` puts
into the layers only `line.amount + Σ allocated` (§4.7.2 branch 3). A 10 @ 100 receipt with an unallocated 120.00
freight line posted 1300 at 1120.00 beside layers at 1000.00, and the 120.00 stood in 1300 for good with no stock
behind it — test 7's TIE-OUT A (Σ valuation = 1300 + 1310) broken for the company. The same happened when an
allocation was made and then lost: `PUT …/documents/{id}/lines` deletes and re-inserts every line, and the FK
cascade drops `landed_cost_allocation` with the old lines; and a cost line re-priced after it was allocated left
shares that no longer summed to it.

**Decision.**

8. **At post, a receipt refuses a cost line it capitalises unless that line is wholly allocated.** `postDocument`
   step 6h (`refuseUnallocatedLandedCost`, `packages/db/src/posting/post.ts`) asks every document whose policy is
   `inventory.effect: "receipt"` with `costing: "create_layer"`: for each `account` line whose planned debit lands
   on an inventory account — an item's own `inventory_account` on that document, or `1300`/`1310`, the two the
   valuation tie-out sums — Σ `allocated_amount` of that cost line onto the goods lines that plan a receipt must
   equal the capitalised amount, to the cent, in document currency. Otherwise the post is refused with
   `ERR_POLICY_REQUIRES_MISSING` (422) naming the document, the line number, the amount, the account and what is
   allocated. No new error code.
9. **The check reads the allocation as it stands at post,** so the two invalidation paths above — a cascade by a
   line replacement, and a cost line edited after allocation — are caught by the same rule, and nothing has to
   track edits.
10. **Not asked:** a reversal mirror (its movements carry the original's cost and the original passed this
    check); a policy that expenses an account line rather than capitalising it (its debit lands on no inventory
    account); and a zero-amount cost line. The check runs before step 7, so a refused post consumes no number.

**Consequences.**

- The remedy for an unallocated freight line is to allocate it (`POST …/documents/{id}/landed-cost`) and post
  again; nothing posts that the layers do not hold. The second bullet of the Consequences above now applies only
  to documents posted before this amendment.
- A receipt whose only goods are free of charge cannot carry a capitalised freight line by `by_value` (every
  basis is zero, refused at allocation); `by_quantity` or `by_weight` serves.
- Owner question: should a capitalised cost line that genuinely belongs to no goods line (for example freight on
  a receipt later found to be wholly refused) be posted to an expense instead? Today the clerk removes the line or
  allocates it; the policy cannot express a third choice without a seed change.
