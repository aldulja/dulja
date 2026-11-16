# ADR 0044 — The invoice is financial only: `1250` and `2150` as the two clearing corridors

- **Status:** Proposed (spec:95 — this touches money semantics, so it is asked before it is implemented)
- **Date:** 2026-09-05
- **Slice:** 4A
- **Supersedes:** nothing. **Amends:** the three §4.14 inventory cells listed in 4A Task 0 amendment 1.

## Context

§4.14 describes `SALES_INVOICE` as "outbound / issue (or none when linked to a DO)" and
`PURCHASE_INVOICE` as "inbound / none when linked to a GRN, else receipt". Neither is expressible.
`posting-policy.schema.json` gives `inventory.effect` a single value per policy, `when` exists only on
`policyLine`, and the schema has been frozen at `$id` `urn:dulja:posting-policy:1` with
`"version": { "const": 1 }` since 2A widened it — "a schema change is a new `version` const and a new
`$id`" (§4.4.1). A conditional effect would therefore be a new schema version invalidating every
policy file in the repository, to serve one document type.

## Decision

Every one of slice 4A's six document types declares `inventory: { "effect": "none" }`. Stock moves
only where Phase 3 put it:

- **out** on `DELIVERY_ORDER`, which debits `1250` goods delivered not invoiced and credits the item's
  inventory account at `line.cost` (3D);
- **in** on `GOODS_RECEIPT` / `SHIPMENT`, which debit the item's inventory account and credit `2150`
  goods received not invoiced at `line.amount` (3C).

`SALES_INVOICE` then debits cost of goods sold and credits `1250` at the cost the delivery wrote, and
`PURCHASE_INVOICE` debits `2150` and credits trade payables at the amount the receipt accrued. Both
corridors net to exactly zero per pair. The conversion services copy the corridor figure forward
rather than recomputing it.

## Consequences

- **`1250` and `2150` become testable invariants**, not descriptive accounts: a non-zero balance means
  goods delivered and not yet invoiced, or received and not yet invoiced, and nothing else. Tasks 6
  and 7 assert `0.0000` after each pair.
- **One physical movement keeps one cost** (spec:1228, LEGACY-009). Relieving `1250` by a recomputed
  figure would leave a residue after every `inventory.cost.replay`.
- **A sales invoice cannot be raised without a delivery for a product line.** The refusal is
  mechanical, not procedural: with no linked delivery there is no cost on the line, the evaluator
  emits the two cost legs at `Money.zero` under amendment A5, and §4.7.2's new no-movement branch
  refuses the post with `ERR_POLICY_REQUIRES_MISSING` naming the line. A service-only invoice is
  unaffected — its cost legs are filtered out by `when: { "item.kind": "product" }`.
- **A tenant that wants a one-document stock-issuing invoice can still have one**, as its own
  configured type with its own policy and zero code (test 15). The release seeds no such shape.
- **Test 22's equivalence changes shape, and 6A decides how — not 4A.** §6.1 row 22 and spec:2440 ask
  that a `POS_TICKET` and "the equivalent back-office invoice" produce identical ledger entries **and
  cost consumptions**. Under this decision they cannot: a `SALES_INVOICE` alone has **zero** cost
  consumptions and credits `1250`, while a `POS_TICKET` (outbound / `issue`) consumes a layer and
  credits `1300`. Comparing the ticket against the *pair* `DELIVERY_ORDER ∪ SALES_INVOICE` does not
  rescue it either: the union multiset carries a `1250` debit and a `1250` credit the ticket never
  produces, on two effective dates, and hazard 18's projection set is frozen and does not net pairs.
  So test 22's "equivalent back-office invoice" is either **a tenant-configured stock-issuing type**
  (the bullet above), seeded by 6A's own fixture and never by the release pack — **or** §6.1 row 22
  and hazard 18 are amended to compare the pair and net the two `1250` legs. **6A's Task 0 decides
  which**, because 4A cannot see the POS policy and must not guess it. This is written down here for
  the same reason 3D wrote down the negative-cost rule instead of leaving 4A to discover it cold
  (3d:2740); amendment 17 puts the note in §6.1 so 6A reads it in its own section.
- **Rejected alternative — `when: { "document.kind": … }` on the cost legs with `effect: "issue"`.**
  It would express the two *ledger* shapes but not the two *movement* shapes, so a delivered invoice
  would issue the stock a second time; suppressing that needs a null `quantity` on a goods invoice
  line, which makes the invoice a false record of what was sold.
- **Rejected alternative — a second document-type code.** §4.14 registers one code and 4A's card
  enumerates four invoice and credit-note types; a fifth would make "sales invoice" ambiguous in every
  report, and the corridor design removes the need for it.

## Note — the code review's second pass (2026-09-29)

A hand-drafted negative line on a receipt, issue or transfer policy is now refused at post (step 6d), and so is
a moved line of any other kind (step 6e) — including an `account` line carrying an item. A negated
DELIVERY_ORDER therefore cannot be used as a partial return; a partial return still has no path, which remains
this ADR's open consequence for the owner.

## Amendment — a price is per entered unit (2026-11-16, MON-02 and MON-14)

- **Status:** Proposed (money semantics; the owner's to accept).
- **Context.** The 2026-11-15 review (MON-02) found that `convertToInvoice` extended a priced, amount-less
  source line as `unit_price × quantity`, and `linkFulfilment` copied a price as
  `round(unit_price × quantity − discount, 4)`. `quantity` is always BASE (0032's trigger derives it from
  `unit_id`/`unit_quantity`), while `unit_price` is per the ENTERED unit: `price_list_line` names its unit,
  the till extends `price × entered quantity` (`packages/db/src/sync/apply.ts`), and an order's `amount` is
  `unit_price × unit_quantity`. An order of 2 CTN (12 PCS each) at 30.0000 a carton converted to an invoice
  of 720.0000 — revenue, receivable and output tax twelve-fold — and a receipt priced from a carton PO
  accrued `2150` twelve-fold. MON-14: the copy rewrote `amount` and left `tax_amount`/`total_incl_tax` as
  they were, so a taxed draft so priced was refused at post.
- **Decision.**
  1. `document_line.unit_price` is a price per the line's ENTERED unit (`unit_id`; the base unit when the
     line names none). Every place that extends a price into a value multiplies it by the line's entered
     quantity: `unit_quantity` where one was entered, else the base `quantity` divided through the unit's
     exact `app.unit_conversion` factor (`numerator / denominator`, base per entered unit) — a delivery 3D
     drafts from an order carries the order's unit and price and a base quantity only. The one definition is
     `enteredQuantity` (`packages/db/src/documents/link.ts`); `convertToInvoice` and `linkFulfilment` both
     use it. A base-unit line, or a line with no unit, is unchanged (its entered quantity is its quantity).
     A line naming a unit its item has no conversion for is refused `ERR_VALIDATION_FAILED` rather than
     extended over its base quantity.
  2. `linkFulfilment` extends the source price over the TARGET's quantity expressed in the SOURCE's unit.
     When the two lines name different units, the target's `unit_price` is the source price re-expressed per
     the target's unit (`× base per target unit ÷ base per source unit`, rounded once at 4 dp
     HALF_AWAY_FROM_ZERO); the `amount` is extended from the source's own price, never from that rounded
     figure, so 18 PCS against a carton order at 30.0000 is 45.0000 at 2.5000 a piece.
  3. After a copy prices at least one line, `linkFulfilment` recomputes the draft's tax with
     `computeDocumentTax` — the persist-time computation `PUT …/lines` and `convertToInvoice` use (spec:2228,
     ADR 0050) — so a priced, taxed draft posts without its lines being PUT again.
- **Consequences.** A converted invoice line still copies the source's `unit_id` and price with a BASE
  `quantity` and no `unit_quantity` (a partial conversion's entered quantity need not be exact at 6 dp, and
  0032's trigger would refuse an inexact pair); its stored `amount` is the figure that posts. A reader that
  re-extends such a line's price must go through `enteredQuantity`, never `unit_price × quantity`.
  Proven by `packages/db/test/ar-ap/entered-unit-price.test.ts` and LEGACY-066's `review 2026-11-15` block.
