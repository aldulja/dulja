# ADR 0059 — POS cash rounding is absorbed into the ticket, because the ledger has no rounding account

- Status: **proposed** (spec:95 — a decision touching money semantics is written as a proposal and asked)
- Date: 2026-09-05
- Slice: 6B

## Context

§3.7.6's Payment row requires *"rounding per the currency's POS rounding rule"*, and
`branch_pos_policy.rounding_increment` (§4.6.4) is where the increment lives — a configuration column with a
default, not a statutory rule, and this ADR states no jurisdiction's rounding practice.

The original plan relied on three facts:

1. **§4.15 registers no POS-rounding account.** The account-code register is closed and a plan may not
   invent a literal in it (hazard 32).
2. **The `POS_TICKET` policy balances `Σ` tender debits against `Σ`(item amount + tax) with no residual
   leg** (6A). A tender total that differed from the line total by one cent would fail
   `ERR_LEDGER_UNBALANCED` at post, for every rounded cash ticket in the shop.
3. **The original `Ticket` had no rounding field.** The integration correction below adds verifiable rounding evidence to distinguish automatic rounding from manual discounts; the posting treatment remains a signed line discount.

## Decision

**When every tender on a ticket is `cash`, the payable amount is the ticket gross rounded to the branch's
`rounding_increment`, and the difference is applied to the highest-amount item line's `discount`.**

- Rounding **down** produces a positive discount; rounding **up** produces a negative one. `document_line.discount`
  is a signed `numeric(19,4)` with no non-negative CHECK, so a negative discount is representable, and
  §4.4.2's A9 rule is untouched: `discount` is a magnitude adjustment on the line, not a direction.
- Tax is **re-extracted from the rounded gross**, so the till's `taxAmount` and 6A's step-(g)
  recomputation agree by construction rather than by tolerance.
- The ticket's gross therefore **equals** the payable exactly, `Σ` tenders `= Σ` gross, and the policy
  balances with no residual leg and no new account.
- A ticket carrying **any** non-cash tender is **not** rounded: a card or transfer settles to the cent.

## Consequences

- Rounding is **not separately visible in the ledger**. It appears as a line discount, which is where a
  till's price adjustment already lives, and the receipt prints it on its own line so the customer sees it.
  Reports separate it from manual discounts through the line's own record (the reporting resolution below).
- A shop wanting rounding as its own ledger line needs a `5140`-shaped account in §4.15 **and** a
  `Ticket.rounding: MoneyJson` field in §4.10.1 **and** a fifth `POS_TICKET` rule. That is the amendment;
  only `applyCashRounding` and the policy change on this side of it.
- The increment is per branch and per policy row, so two branches of one company may round differently, and
  the branch increment must remain positive under 6C’s CHECK; zero is refused rather than used as a disable mode.

## What we are asking

Confirm with the accountant that cash rounding appearing as a **line discount** on the ticket, rather than as
its own ledger account, is acceptable for the audit trail — and that the receipt showing it on a separate
line is sufficient disclosure to the customer.

## Reporting resolution — cash rounding is not a discount (2026-10-22)

The PR 12 review asked whether `pos.sales_by_cashier`'s `discountBase` should count rounding: authority and
branch limits already read the reconstructed manual discount, but the posted line keeps the wire discount and
6D's report summed `document_line.discount`, so a sale of 50.03 settled at 50.05 reported a −0.0200 discount
nobody gave. On 2026-10-22 the owner directed the review's open questions to be settled by best practice, and
best practice is that an automatic cash adjustment is reported apart from the discounts a cashier grants. The
**ledger treatment above is unchanged**: the adjustment still posts inside the target line's discount, with no
rounding account and no residual leg.

- **Each item line records the rounding it absorbed**, under `document_line.custom_fields.posCashRounding`
  (`CASH_ROUNDING_FIELD`, `packages/db/src/sync/cash-rounding.ts`), as a four-place figure, absent when there is
  none. A sale or blind return records the adjustment `verifyCashRounding` has proved, on its target line only.
  A referenced refund records its share of the sale line's record by the same cumulative rule as its discount,
  cost and gross (ADR 0056; `posReturnShare` over `loadPosReturnHistory`, which now also sums the record), so the
  completing refund takes the exact residue. No migration: the record is data on the line, written at draft.
- **The record is in the line's own direction**, like `cost` (§4.4.2): positive when rounding raised the amount
  moving the way the line moves. `reverseDocument` copies `custom_fields` and negates quantity and discount, so a
  reversal mirror unwinds the rounding with no rewrite at any depth of a chain. The signed adjustment — rounded
  payable − original gross, the sign `Ticket.cashRounding.adjustment` already carries — is the record times the
  sign of the line's quantity.
- **`pos.sales_by_cashier`** reports `discountBase` (wire `discount`) as manual discounts only — the posted
  discounts plus their lines' signed adjustments — and a new `cashRoundingBase` (wire `cashRounding`) as the sum
  of the signed adjustments: positive when rounding raised the takings, negative when it lowered them, and zero
  over a sale and all its refunds. The record counts only on a terminal's document, as the refund history trusts
  only those. The Z-report reads tenders and cash control from the ledger and shows no discount, so it is
  unchanged. The back office's sales-by-cashier table shows the rounding beside the discount.
- Proved in `apps/api/test/routes/sync/cash-rounding.test.ts`: a rounded sale with no discount reports
  `discountBase` 0.0000 and `cashRoundingBase` +0.0200 (and −0.0200 rounding down); a manual 1.0000 discount
  with +0.0200 rounding reports exactly 1.0000; a referenced refund of one of three units returns 0.0063 of
  +0.0190 and the completing refund the residue; a blind return reports −0.0200; a reversal nets both to zero.

Tickets posted before this change carry no record, and the report treats their rounding as discount; no
deployed database holds any.

A referenced partial refund of a sale that carried both a manual discount and rounding takes its share of the posted discount and of the rounding record separately, each rounded to four places, so its reported manual discount can differ from a third (say) of the original by 0.0001; the refund that completes the line takes both residues, so every sale nets exactly. A hand-drafted line's value under the field is never read: only a terminal's POS ticket counts (`loadPosReturnHistory`, `salesByCashier`).

## Proposal preparation

Prepared for owner review on 2026-10-07 from [2026-09-05-dulja-phase-6b-pos-application.md](../superpowers/plans/2026-09-05-dulja-phase-6b-pos-application.md). The source proposal date above is preserved. This record is proposed; no owner acceptance or implementation is recorded here.

## Policy discrepancies resolved for implementation

The original proposal conflicted with 6C’s positive-only `rounding_increment` constraint and left the currency/branch relationship open. The recommended resolution presented for review was to retain `rounding_increment > 0`, keep `currency.pos_rounding_increment` display-only under ADR 0009 decision 7, and apply the branch policy alone. The proposed configurable branch-column default is `0.05`; this is a configuration default, not a statutory claim. No currency seed increment is changed or hard-coded.

The renewed whole-phase instruction authorizes these implementation defaults, as recorded below. Operators can configure each branch to its approved positive value; zero is not a disable mode.

## Implementation scope — 2026-10-07

The user renewed the whole-phase implementation instruction after the consolidated proposals and recommended policy were presented. Implementation uses the configurable positive branch increment (plan default `0.05`) as its sole rounding source. `currency.pos_rounding_increment` remains display-only. The copied zero-disable consequence is corrected above to agree with 6C’s positive-only constraint. This is implementation authorization; the ADR remains Proposed for formal review.

## Integration correction — verifiable rounding evidence (2026-10-07)

The signed-discount treatment alone trips ordinary discount authority and zero branch limits. Automatic cash rounding therefore needs evidence that the server verifies, rather than an unchecked exemption flag. Add optional `Ticket.cashRounding?: { lineNo: number; adjustment: MoneyJson } | null` in 6C, before the new till ships. `adjustment` is signed rounded payable minus original gross. Old tickets without evidence retain ordinary discount checks. This is a necessary protocol correction to implement the authorized branch-rounding behavior; it introduces no ledger account or residual posting.

For the declared target line, reconstruct its manual discount as `wireDiscount + adjustment`; derive original inclusive gross from signed quantity times unit price, rounded at money scale, less that discount. Other lines retain their discounts. Choose the largest absolute original gross, breaking ties by lowest unique line number. Verify the target, currencies, signs, nonempty cash-only tenders, actual branch’s positive increment, and exact adjustment equal to the rounded sum of original gross less that sum. Verify final line gross, pinned-code tax at the ticket’s effective date and tender total exactly. Only then do authority and branch limits consume the reconstructed manual discounts. A manual discount hidden by an automatic surcharge remains a manual discount and requires its authority. Metadata on account or mixed/noncash tickets is refused.

This treatment is restricted to the inclusive `POS_TICKET` policy. It is symmetric for signed returns. A stale branch increment causes refusal and retained needs-attention/outbox data, never silent repricing. Server support must precede till emission. Final lines, tenders and evidence enter the local outbox atomically and survive queued retries.

Share one pure `roundToIncrement` implementation through the domain package. It uses Decimal division and the existing explicit rounding function at scale zero before multiplying by the increment; do not use `Money.divide` for the quotient, because its four-place rounding can change a near-half decision. No floating-point monetary value enters the calculation.

Required proofs include both rounding directions for sales/returns, taxable and untaxed lines, zero manual-discount limits, forged target/adjustment/totals, hidden manual discounts, mixed tenders, wrong currencies, obsolete branch increments, queued retries and duplicate acknowledgements. Plan Contracts and the strict schemas must carry the evidence field before implementation. Formal ADR status remains Proposed.

## PR 12 review amendment — promotion evidence (2026-10-23; owner direction 2026-10-22: best practice; proposed)

6B Task 6 says a promotion's discount and the cashier's own discount add, and that the branch limit is checked
against the cashier's alone (6B Task 5 defines the promotions). The recovered tree added the two into the line's
`discount` and then treated the sum as the cashier's, at the till and at the server. A promoted sale needed
`pos.ticket.discount`, and at 0066's default policy (every manual-discount limit zero) every promoted sale was
refused, `ERR_TILL_LIMIT_EXCEEDED` at the till and `ERR_POS_LIMIT_EXCEEDED` at the server. A head-office promotion
larger than a branch's manual limit needed a supervisor override on every sale. The wire carried nothing that
told the two shares apart, and an unchecked flag would let any till exempt any discount. So a promotion uses
the same pattern as the cash rounding above: optional evidence that the server proves before it honours it.

- **Wire.** `TicketLine.promotion?: { promotionId: string; discount: MoneyJson } | null` (§4.10.1) is the
  promotion's share of the line's `discount`, signed like it (negative on a return line), and the promotion
  that earned it. The strict schema admits exactly those two fields. Absent or null means the whole discount
  is the cashier's, so a till that predates the field is read exactly as before. The posted line and the
  ledger are unchanged: `document_line.discount` is still the wire discount (promotion, manual and rounding
  together), with no account and no column.
- **One arithmetic.** `promotionDiscount(terms, line)` and `promotionActiveAt(window, at)`
  (`packages/domain/src/pos/promotion.ts`, exported by the domain barrel) are what the till prices with and
  what the server verifies with. They read the three shapes 6B Task 5 defined for 3A's `definition`:
  `percent_off`, `amount_off` and `bundle`. The result is a magnitude, capped at the line's gross. It is zero,
  never a guess, for another item, another currency, an unknown kind or a figure that does not parse at money
  or quantity scale.
- **Windows are compared as instants** (6B Task 5 Step 4 compared text). The mirror holds PostgreSQL's
  `to_jsonb(timestamptz)` rendering, in whatever offset the server session used and without milliseconds,
  while the till's clock is `toISOString()`. As text, `'+'` sorts before `'.'`, so a promotion was dropped at
  the very instant it ended, and a non-UTC session offset shifted every window by hours. `promotionActiveAt`
  parses both bounds and the instant. Both ends are inclusive, a NULL bound is open, sub-millisecond digits
  truncate on both sides, and an unreadable bound makes the promotion inactive. The till's SELECT still
  prefilters coarsely, because 3A has no `archived_at` on a promotion and retired rows stay in the mirror for
  good: it drops other branches' rows and rows whose `ends_at` text sorts before the till's UTC date less two
  days. Every offset is under a day, and every other rendering (a five-digit year, a BC date, `infinity`) is
  text `Date.parse` cannot read, so the prefilter drops only rows `promotionActiveAt` refuses anyway.
- **Till.** `DraftLine.promotion` keeps the promotion's share beside `discount`, which stays the sum for
  totals, tax and the wire. `manualDiscount(line)` (the discount less the promotion) is the only figure that
  `sell`'s `pos.ticket.discount` check and both limit figures in `checkLimits` read. The gross stays the whole
  line's on both sides, so the till and the server still refuse with the same words.
  - A promotion discounts the price the line is actually sold at. A price override is promoted afresh at the
    overridden price, because the wire carries no catalogue price and the server recomputes from the wire's
    `unitPrice`. The plan's snippet kept the catalogue-price promotion.
  - `sell` fixes one instant for pricing and for `soldAt`, so the server checks the window at the moment the
    till applied it.
  - The evidence goes on sale and blind-return lines whose promotion share is not zero. It never goes on a
    referenced return, which restores its sale's discount as it was and whose discount neither authority nor
    the limits read.
  - It is written to the outbox payload in the sale's own transaction, and `tender` copies it onto the
    completed payload: rounding changes a line's discount, never its promotion share. A queued retry sends it
    unchanged. There is no SQLite column for it.
- **Server.** `verifyPromotions` (`packages/db/src/sync/promotion.ts`) runs in `applyBatch` step (b), after
  `verifyCashRounding`, so it starts from discounts that are already free of the rounding.
  - **Malformed evidence** is refused with `ERR_VALIDATION_FAILED`: evidence on a referenced return; a currency
    other than the ticket's; a zero share or one signed unlike the line quantity; a share larger than the line's
    discount; or a line whose whole discount, promotion included, exceeds its gross. The last check exists
    because `validateShape` bounds only the manual share it is handed.
  - **A claim is honoured** only when the server's own `app.promotion` row proves it. The row must belong to
    this company and to no branch or the terminal's branch (Form B), and its window must contain `soldAt`.
    Its definition, read in the catalogue stream's normal form (top-level numbers become their decimal text, as
    the till receives them), must give exactly the claimed share from the wire's `unitPrice` and `quantity`.
    The share then comes out of that line's discount on the authority ticket. `validateShape`'s manual checks,
    `requiredCodesFor` and `verifyTicket` all read that ticket.
  - **A claim that cannot be proved is not honoured.** That covers an unknown id, another branch's promotion,
    a sale outside the window, a promotion that does not apply to the item, and a different amount. The line
    keeps its whole discount and the ordinary checks apply. A cashier who holds the authority and the limit is
    accepted. Otherwise the refusal is `ERR_RBAC_FORBIDDEN` or `ERR_POS_LIMIT_EXCEEDED`, a recoverable
    needs-attention refusal like any other, and its detail ends with `promotion evidence not honoured — line N:
    <reason>`.
  - The server never re-prices. A promotion edited, shortened or removed between the sale and the sync makes
    the claim unprovable, as a stale tax rate does (SAH-020), and the manager resolves it like any other
    refusal.

- **Report** (2026-10-23, the same best-practice direction; this replaces the open question first recorded
  here). A verified promotion is not the cashier's discount in `pos.sales_by_cashier` either, by the reasoning
  that took the cash rounding out of it above.
  - Each item line whose claim the server honoured records the share under
    `document_line.custom_fields.posPromotion` (`PROMOTION_FIELD`, `packages/db/src/sync/promotion.ts`). It is a
    four-place figure in the line's own direction, like `posCashRounding`, and absent when there is none.
    `verifyPromotions` returns the honoured shares by line number (`honoured`), and the draft writes them.
  - A referenced refund records its share of its sale line's record by the same cumulative rule as its discount
    (`posReturnShare` over `loadPosReturnHistory`, which now sums this record too). The completing refund takes
    the exact residue. A reversal mirror unwinds it as it unwinds the rounding.
  - `discountBase` is the posted discounts plus the signed rounding less the signed promotion shares.
  - A claim the server did not honour records nothing. A cashier who held the authority and the limit sold that
    discount as their own, so the report shows it as theirs.
  - The ledger, the posted discount and the report's wire shape are unchanged, and no migration is needed. No
    promotion column is added: that needs a report-contract change and a back-office screen, which the owner can
    ask for. Until then a verified promotion shows only as reduced `netSalesBase`.

Proved in `packages/domain/test/pos/promotion.test.ts` (the arithmetic and the instants), in
`apps/pos/test/pricing.test.ts` (an exact end instant, a `+08:00` window, and a prefilter that reads no retired
or other-branch row and keeps a live one whose leading date is a day behind) and in `apps/pos/test/ticket.test.ts`.
At a zero-limit branch, the till tests show:

- a promoted item sells with and without `pos.ticket.discount`, and the outbox carries the evidence;
- a 10 % promotion plus a manual discount inside the 10 % line limit sells, and the manual part still needs
  the code;
- an over-limit manual discount is refused, naming the manual figure only;
- a promoted blind return negates the evidence;
- an overridden price is promoted afresh;
- `tender` keeps the evidence beside cash rounding on the same line.

The server cases are in `apps/api/test/routes/sync/promotion.test.ts`. A promoted sale and a promoted blind
return apply for a cashier without the code at zero limits. The manual part still needs the code and the
limit. Forged, expired, other-branch, other-item and wrong-amount claims are refused and queued, each naming its
reason. Malformed evidence and evidence on a referenced refund are refused outright, as is a whole discount over
the gross. Cash rounding and a promotion on the same line verify together. In `pos.sales_by_cashier`, a promoted
sale with a manual part reports only that part, its two referenced refunds give back the same split and net it
to zero, a promoted blind return and a reversed promoted sale report no discount, and an unproved claim that was
accepted stays the cashier's. The till/server parity case in
`tests/invariants/pos-offline.test.ts` refuses a promoted line's over-limit manual part with the same words on
both sides.
