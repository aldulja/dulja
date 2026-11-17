# ADR 0047 — Realised and unrealised FX in one document type

- **Status:** Proposed (spec:95 — this touches money semantics, so it is asked before it is implemented).
  **Implemented ahead of approval**, as ADR 0020 was, as 3B's 0037–0039 were and as this slice's 0046 and
  0048 are: 4B Task 5 ships it on this branch. Decision 9 (cross-currency allocation) was added in a second
  pass of the same task, and it changes 4A's `app.allocation` (migration 0046, never applied to any
  database) and `allocateSettlement`. If the owner rejects a decision below, `packages/db/src/ar-ap/fx.ts`,
  `packages/db/src/ar-ap/allocation.ts`, `FX_REVALUATION.json`, migrations 0046 and 0048, the revaluation
  route and the three allocation-changing handlers in `apps/api/src/routes/accounting/documents.ts` are what
  change. Four questions are the owner's and are listed under **Open questions**.
- **Date:** 2026-09-28
- **Slice:** 4B (Task 5)

## Context

§3.0.4 row 1045 requires "rates with source, base = value × rate, FX difference on settlement,
revaluation", and acceptance test 8 requires all four in one scenario. §4.14 registers exactly one
document-type code for 4B, `FX_REVALUATION`, and §4.15 registers the pair `4900` / `5910` plus the
rounding account `5920` — all three seeded by 0C, none by this slice.

4A landed first (round 7) and fixed three facts this ADR builds on: `allocateSettlement` stores
`fx_difference = settlement base − settled base` and posts nothing; as landed it **refused a pair in two
currencies** (`ERR_MONEY_CURRENCY_MISMATCH`), because `allocation.amount` is denominated in the settled
document's currency and no column denominated the payment in the settlement's — which made test 8's
"invoice EUR, part-pay USD, settle in base" inexpressible; and `app.party_ageing_rows` (0048) relieves a
settlement by `base_amount + fx_difference`, once both of the pair's documents exist as of the report date.

Six things had no registered answer; the sixth is decision 9.

1. **Who posts the settlement difference, and when?** §4.8.1's comment says "the settlement's policy" does.
2. **How are realised and unrealised told apart when they share a code?**
3. **What gets revalued at period end, and against what?**
4. **Which way does each entry go?**
5. **How does the ageing tie-out survive every allocation change?**
6. **How does a settlement in one currency pay a document in another?**

## Decision

**1. A separate document, posted in the allocating transaction.** §4.4.1's `amountRef` union has thirteen
members and none of them is an allocation's FX difference, so a `RECEIPT` policy cannot address the figure;
and the difference arises at *allocation* time, not at posting time. `settleWithFx` is `allocateSettlement`
followed by `postSettlementFxDifference` on the caller's one transaction, and every HTTP path that changes an
allocation posts through it: `POST …/documents/{id}/allocations` (the plan's call site), `POST
…/documents/settlements` with allocations, and `POST …/allocations/{id}/unallocate`. A later, separate call
would leave the tie-out false in between, which a reader of the ageing report could observe.

**2. One code, marked by `document_line.custom_fields.fxKind ∈ realised | unrealised`** on every line
(contracts §4.14, round 8 amendment 5). `app.document` has no `custom_fields` column, and header custom
fields need a `custom_field_definition` per company that a job cannot create. A realised document's lines
also carry `settlementDocumentId`, `settledDocumentId` and `partyId`; an unrealised one's carry
`fiscalPeriodId`, `revaluedAccountId` and `revaluedCurrency`. `reverseDocument` copies the bag.

**3. A realised document carries its settlement's `party_id`; an unrealised one carries none.** The
realised correction is the party's — it moves the party's control account — so `partyBalance` and 0045's
credit-control read, which both sum the ledger of the party's documents, must see it: without it a party
fully settled in two other currencies reads `partyBalance.base ≠ 0` while its control account is at zero.
Two guards keep it from being mistaken for what it is not: `app.party_ageing_rows` excludes
`FX_REVALUATION` from its open items explicitly (0048's rule 5 — counted there it would age as a receivable
of exactly the FX amount, which rule 3 already counts at the settlement base), and `allocateSettlement`
refuses an `FX_REVALUATION` on either side of a pair. The unrealised document is company-level (one
document spans every exposed account) and names no party. The party is also on every line's
`custom_fields.partyId`.

**4. The realised document posts a DIFFERENCE, keyed by the `fxKind` probe alone.** No `document_link`
row: 3C's trigger (0037, rewritten by 0109/0110) refuses a posted target (amendment 5). What is posted is
what the settlement's **live** allocations call for less what realised documents for that settlement already
carry on the control account — per (relief date, settled document). So a second call posts nothing, a call
after `unallocate` posts the withdrawal, and a call after a re-allocation posts the new difference.

**5. Dated where the ageing relieves the pair** — the **later** of the settlement's and the settled
document's effective dates. Dated on the settlement alone, a deposit received before the invoice it pays
would break the tie-out for every as-of date in between. *(Amended by the code review of 2026-09-29, below:
the date is now the allocation's own `effective_date`, which is that later date moved to the first open day
when its period is closed.)*

**6. One direction rule, in debit-positive terms on the subject account**, for both halves: a positive delta
debits the subject and credits the result account, a negative one the reverse, and

    resultAccount = resultSide === "credit" ? 4900 : 5910

with no reference to the party's kind or the account's type. Both lines are non-negative magnitudes, so
§4.4.2 A9 holds by construction. **For the realised half the subject's delta is `−side × fx_difference`**,
where `side` is the settlement's own effect on the control account (−1 a receipt crediting `1200`, +1 a
payment debiting `2100` or a refund debiting `1200`): the settlement relieved `fx_difference` more than the
settled document charged. The plan's code used `fx_difference`'s sign directly, which is right for a
receipt and posts a vendor's over-payment as a gain; the side term is the correction. An un-allocation's
withdrawal of a gain is a debit to the result account and so lands in `5910` — the rule has no exception
for an unwinding.

**7. What is revalued, and against what carried base.** Party control accounts are revalued from the
**open items** (`ageingRows` at the period's `ends_on`), not from `account_balance`'s per-currency rows,
which on a control account are not an open-item view (ADR 0046). **Every other account is revalued only
when it is denominated in a foreign currency** — `account.currency` set and not the base currency, asset or
liability, not a group. The plan named "every monetary account carrying a non-base balance"; in this tree
that includes `2150`, whose `PURCHASE_INVOICE` debit is in the invoice currency while its `GOODS_RECEIPT`
credit is in base, so a foreign bill would leave a permanent non-base balance on a clearing account and be
revalued every month. The carried base of each (account, currency) includes any unrealised revaluation
still outstanding on it, so a period whose predecessor was never reversed is revalued by the increment.
The one conversion is `toBase` (round(value × rate, 4), HALF_AWAY_FROM_ZERO); a missing `app.rate_for` row
is `ERR_RATE_NOT_FOUND` naming the pair, never 1 (LEGACY-012, LEGACY-014). One revaluation per company per
period (the guard counts `posted` and `reversed`), dated `ends_on`, tagged to the `HQ` branch by code.

**8. Only the unrealised document is reversed at period start** (`reverseRevaluation`, through 1A's
`reverseDocument`); it refuses a realised one, which is undone through its settlement.

**The ageing tie-out is self-consistent for any value of `fx_difference`.** For one settlement:

| | ageing base | control-account ledger base |
|---|---|---|
| settled document | `charged − base_amount` | `charged` |
| settlement | `−settlementLeg + base_amount + fx` | `−settlementLeg` |
| realised FX document | (absent — 0048 rule 5) | `+fx` (in the settlement's orientation) |
| **Σ** | `charged − settlementLeg + fx` | `charged − settlementLeg + fx` |

4B therefore reads the stored `fx_difference` and never recomputes it. The unrealised term is the one
remaining difference, and `ageingTieOut` states it as its own column.

**9. A cross-currency allocation states BOTH figures (second pass).** `app.allocation` gains
`settlement_amount numeric(19,4) not null check (settlement_amount > 0)`, in the SETTLEMENT document's
currency, beside `amount` in the settled document's; `allocation_guard` fixes it at insert with the rest.
`AllocationLine` gains `settlementAmount?: Money` (and the wire line an optional `settlementAmount`): required
when the two documents' currencies differ (`ERR_VALIDATION_FAILED` otherwise), and equal to `amount` when they
agree (omitted, it defaults to `amount`). Neither figure is derived from the other, because that needs a cross
rate nobody entered: a USD 260 receipt that pays EUR 200 of an invoice says so in both currencies, and the
bank's own conversion is what it is.

- `base_amount = toBase(amount, settled rate)` and `fx_difference = toBase(settlementAmount, settlement rate)
  − base_amount`, with the completing-residue rule on each side judged on that side's OWN currency — the
  settled document completes when `amount` is its open balance, the settlement when `settlementAmount` is
  what it has left.
- Capacity and open balance stay in each document's own currency: as the settled document a row consumes
  `amount` (base `base_amount`), as the settlement `settlement_amount` (base `base_amount + fx_difference`).
- `app.party_ageing_rows` relieves the settlement side by `settlement_amount`; the plan's `base ÷ rate`
  fallback, and its up-to-0.0001 residue, are gone.
- An `amount` not in the settled document's currency, or a `settlementAmount` not in the settlement's, is
  `ERR_MONEY_CURRENCY_MISMATCH` naming the line.
- `draftSettlement`'s inline allocations (4A's `POST …/documents/settlements`) stay same-currency: their
  amounts are in the settlement's currency by that body's contract. A cross-currency receipt is posted and
  then allocated through `POST …/documents/{id}/allocations`.

## Consequences

- `FX_REVALUATION` declares `reversal.allowed: true, producesType: "FX_REVALUATION"`, so D13 reverses a
  revaluation with no new code; the reversal lands in the **next** period, which must be open.
- A realised difference posts into the period of its relief date; if that period is not open the allocation
  itself is refused (`ERR_PERIOD_NOT_OPEN`), and nothing is written. *(Superseded by the amendment below: it
  now posts on the first open day, and only a company with no open period on or after the date refuses.)*
- Posting either document needs `accounting.journal.post` (the policy's `approval.post`, §3.6.2), checked by
  2B's status trigger at the document's branch — so the principal who allocates a settlement that realises
  a difference must hold it.
- A realised document names a party, so `postDocument`'s step 14 enqueues `accounting.projection.rebuild`
  for it as for any party document (a warning when the caller supplied no `JobClient`), and 0045's credit
  check reads the corrected balance.
- A cross-currency pair changes no ledger row: the settlement posts in its own currency as before, and the
  only new ledger rows are the realised FX document's, in base.
- No account code is added by this slice.

## Open questions (the owner's)

1. **Who may realise an FX difference?** Today an allocating principal needs `accounting.journal.post`
   when the allocation realises one; the seeded `user` role holds `accounting.receipt.create` and not that
   code, so a clerk can allocate a same-rate receipt and is refused (403) for a cross-rate one.
2. **Decision 9 as a whole** — that a settlement may pay a document in another currency at all, and that
   both figures are entered rather than one derived from a cross rate. It is what test 8 needs; it changes
   4A's table and service.
3. **What "party balance correct in all three currencies" means.** Test 8 asserts it as the OPEN-ITEM view
   per currency (the ageing and each document's open balance: nothing outstanding in EUR, USD or MYR) plus
   `partyBalance().base = 0`. `partyBalance().byCurrency` is the LEDGER per currency — after test 8 it reads
   EUR +1000, USD −260, MYR −3960 — and on a cross-currency month is not an open-item view (ADR 0046); it is
   not asserted as "correct".
4. **Decision 7's narrowing** — whether an undesignated multi-currency bank account should be revalued too,
   which needs a way to tell it from a clearing account.

## Open question 5 (added by the code review, 2026-09-29)

5. **How does a refund post?** `PAYMENT` debits only `party.payable_account` and `RECEIPT` credits only
   `party.receivable_account`, and the evaluator's `when` has no condition on the party, so a customer refund
   (money out against a credit note) and a vendor refund cannot post to the party's own control account.
   Decision 6's `side` term already describes "a refund debiting `1200`"; no seeded policy produces one.
   `draftSettlement` now refuses a settlement whose control leg misses `app.party_control_account` with a
   message that says so. A posting rule for refunds is money semantics and is not built.

## Amendment — the code review (2026-09-29)

Still a proposal; the owner approves or rejects it with the rest of this ADR.

- **An allocation carries its own accounting dates** (migration 0046, amended in place): `effective_date` =
  `app.first_open_date(company, greatest(settlement date, settled date))` and, on un-allocation,
  `unallocated_on` = `app.first_open_date(company, effective_date)`, both stamped by `allocation_guard`.
  Decision 5's realised difference is dated on `effective_date` and its withdrawal on `unallocated_on`, and
  0048's ageing counts the allocation live on `[effective_date, unallocated_on)`. Before this, once the pair's
  period closed, an allocation or un-allocation at a different rate could never be made (the FX document
  landed in the closed period and the whole allocation rolled back), and a receipt allocated late could then
  block the invoice's reversal for good. Because the ageing and the FX document now move together, the
  tie-out holds at every as-of date, and a closed month's ageing no longer changes after the close.
  `reverseDocument` refuses a date before any `unallocated_on` of the document, the one date that would
  open a gap again. Tests: `packages/db/test/ar-ap/code-review-b.test.ts` (B1) and
  `code-review-reverse.test.ts`.
- **One definition of the control account**, `app.party_control_account` (0045), replaces the six
  spellings decision 7 and the tie-out used.

## Open question 6 (added by the code review's second pass, 2026-09-29)

6. **May a document post to a party's control account from the other side?** The posting service now refuses a
   settlement whose party leg misses `app.party_control_account` on every path (step 6c), but a cross-kind
   invoice — a SALES_INVOICE to a vendor that also holds a receivable account, or the mirror — and a party-less
   JOURNAL posted directly to 1200 or 2100 still post, and each breaks the 1200/2100 tie-out. Whether control
   accounts refuse direct journals and cross-kind documents is not settled by the spec.

## Amendment — the full review (2026-11-15): cost-leg returns and late reversals (MON-01, MON-11, MON-07)

Still a proposal; the owner approves or rejects it with the rest of this ADR. Migration 0129 and
`packages/db/src/ar-ap/{fx,allocation}.ts`, branch `claude/fix-fx-cost-leg-returns`.

- **Unrealised FX is only a rate movement** (MON-01). The revaluation reads the open items through
  `app.party_ageing_rows`, which since 0129 carries a foreign-currency document whose control legs are base cost
  legs at its keyed total and its own rate (ADR 0046's 2026-11-15 amendment). A EUR return revalued at an
  unchanged rate now posts nothing (it posted Dr 5910 / Cr 2100 for the whole return); after a move from 4.0 to
  4.2 a EUR 30 return posts 6.0000, never the cost. The price-versus-cost residue is a base-currency row and is
  skipped like every base row.
- **Realised FX is only a rate difference** (MON-11). `docFacts` measures such a document on the same exposure,
  so a return keyed at EUR 120 (cost 460) allocated to a EUR invoice at one rate settles 120 at base 480 and
  realises 0.0000 (it realised −20.0000, posting purchase-price variance as an FX gain). `partyBalance` reads the
  same derivation, so the vendor's EUR balance is reduced by the keyed return, and the residue shows in base.
- **A reversal never counts as the period's revaluation** (MON-07). The "already revalued" guard ignores a
  document with `reverses_document_id` set: a reversal copies the original's `fxKind` lines and may be dated on
  a later period's end, which silently skipped that period's revaluation.
- Tests: `packages/db/test/ar-ap/fx-cost-leg-return.test.ts`, each failing on `6a8d239`.
