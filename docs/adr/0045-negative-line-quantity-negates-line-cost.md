# ADR 0045 — A negative line quantity makes `line.cost` negative

- **Status:** Proposed (spec:95 — this touches money semantics, so it is asked before it is implemented).
  The code review of 2026-09-29 implemented the exemption the open question below describes (see its
  amendment at the end) — ahead of approval, like the rule itself.
- **Date:** 2026-09-05
- **Slice:** 4A. **Raised by:** 3D, in its own plan text, as blocking Phase 4.

## Context

3D's `DELIVERY_ORDER` policy addresses both of its ledger legs as `amount: "line.cost"` with a **fixed**
`side` — debit `1250`, credit the item's inventory account. A cancelled delivery is a `DELIVERY_ORDER`
with negated quantities, which 3D's amendment A2 turns into a stock *receipt* automatically, and
3C's `reverseDocument` copies `document_line.cost` onto the reversal line **unnegated**, because a cost
is a magnitude (3c:219). §4.7.2's fill rules never alter `side`. So a reversal's plan has a **positive**
`line.cost` on a **debit** leg to `1250` — and the reversal debits the corridor a second time instead of
relieving it. 3D recorded this and deliberately reversed no delivery order.

4A cannot leave it open: `SALES_INVOICE`'s `reversal.producesType` is `SALES_CREDIT_NOTE` (spec:2024),
credit notes carry negated magnitudes (§4.4.2 A9's own description of the mechanism), and the credit
note's cost legs address `line.cost`. Every corridor round trip in Phase 4 depends on the sign.

## Decision

`evaluatePolicy` resolves the two cost amount references — `line.cost` and `line.variance_value` — to
`cost.negate()` when the source `document_line.quantity` is **negative**, and to `cost` otherwise.
`document_line.cost` remains a non-negative magnitude; `applyMovements`' receipt-value branch 1 keeps
receiving a magnitude; only the evaluator's *reading* is signed, which is what gives A9's sign
normalisation a negative amount to act on so that it flips the `side`.

A **null** cost is not negated. It is emitted at `Money.zero` on the policy's own side exactly as
before (amendment A5), and whatever fills it later fills a magnitude onto that side.

## Consequences

- **A reversal of any cost-bearing outbound document relieves its corridor** instead of doubling it:
  3D's `DELIVERY_ORDER` and `TRANSFER`, 3C's `PURCHASE_RETURN` (whose legs are all `line.cost`), and
  4A's `SALES_INVOICE` → `SALES_CREDIT_NOTE`. This is the known defect `AGENTS.md` records for
  `DELIVERY_ORDER` and `TRANSFER` reversals. `EXPIRY_WRITE_OFF` gains the same rule, but its reversal
  is refused today for another reason: it is an approval-required type, and `reverseDocument` posts its
  draft mirror at once.
- **3D's own delivery-order suite is unaffected** — it reverses nothing, and its forward cases have
  positive quantities.
- **3B's `STOCK_ISSUE_TEST` and its golden fixtures are unaffected** for the same reason. A fixture with
  a negative quantity, if one is later added, gains a negated cost, and that is the point.
- **The alternative — negating the copied `document_line.cost`** — was rejected: it contradicts §4.7.2
  A6's non-negative magnitude, it would hand `applyMovements` a negative value for a receipt movement
  whose quantity is positive, and it would put a sign in a stored column that four consumers read as a
  magnitude.
- **A zero or null quantity changes nothing**, so no account-line or text-line policy is touched.

## Open question for the owner — a policy that already takes its direction from the quantity

`STOCK_COUNT` and `TRANSFER_RECEIPT` do not use fixed sides on every cost rule. They choose the side
with `when: { "line.quantity_sign": … }` (3D, ADR 0042), so on a negative-quantity line the policy has
already picked the relieving side. If such a line ever reached the evaluator with a **non-null** cost,
this rule would negate it and A9 would flip the side a second time, back to the original direction.

No path does that today, and the implementation is exactly the rule above, with no exemption:

- a first post always carries a null cost, because no drafting service writes `document_line.cost`
  (3D Global Constraint 3; contracts §4.7.2, 4A amendment 5), and a null cost is not negated;
- `TRANSFER_RECEIPT` declares `reversal: { allowed: false }`;
- `STOCK_COUNT` is approval-required, and `reverseDocument` refuses an approval-required type (the
  question the Phase 3 test-fix branch left to the owner).

If the owner later lets an approval-required type be reversed, `STOCK_COUNT`'s reversal becomes such a
path. Then either the rule has to skip a rule gated on `line.quantity_sign`, or the reversal has to be
built another way. That choice is the owner's, and it belongs to the ADR that permits the reversal.

## Amendment — the code review (2026-09-29)

The review counted the open question's path as a latent defect, and the fix takes its first option: **a rule
whose `when` selects on `line.quantity_sign` is exempt from the negation**, because it has already chosen its
direction (`packages/domain/src/posting/evaluate.ts`, `resolveCostAmount`). Every other rule negates as
decided above. A reversed `STOCK_COUNT` surplus now plans credit `1300`, debit `5110` beside the issue it
moves; nothing reaches that path today, since approval-required types still cannot be reversed. Test:
`packages/domain/test/posting/code-review-c.test.ts`. The owner may still choose the other option when
approving the ADR that lets such a type be reversed.

## Phase 6 POS return policy (2026-10-07)

The merged posting service refuses negative stock quantities when matching item rules do not explicitly select `line.quantity_sign`. The supplied POS plan omitted that selection and specified only forward cost sides. `POS_TICKET` declares positive/negative item-rule branches: return cost credits COGS and debits inventory at the cost magnitude, while signed revenue/tax use the existing evaluator. This applies this ADR’s explicit-sign exception without changing evaluator polarity or relaxing the posting guard. Prove sales, returns, reversals and costing conservation. Formal ADR status is unchanged.
