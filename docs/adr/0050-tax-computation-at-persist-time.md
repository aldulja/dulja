# ADR 0050 — One tax computation at persist time

**Status:** Proposed; blocks merge pending owner acceptance. Implementation requested as part of Phase 5 on 2026-10-02.
**Date:** 2026-10-02
**Slice:** 5A; allocated by Plan Contracts §3.9.

## Context

LEGACY-019 records inconsistent rounding; LEGACY-020 records hard-coded rates without provenance or a regime discriminator. The tax engine must supply one stored answer shared by posting and returns.

## Decision

Rates live in `app.tax_code`, seeded from reviewed files. Each code declares its rounding mode. Compute tax when draft lines are saved and persist `tax_amount` and `total_incl_tax`; the evaluator, ledger, and return consume those amounts. Record the regime publication or file in `tax_regime.source`.

## Consequences

A rate change is a reviewed seed change. Issued and posted documents cannot be recomputed. Inclusive amounts split exactly into base plus tax, with one rounding call. Regime mismatches are refused. OD-15 remains outstanding; all shipped rates and return boxes are clearly synthetic.

## Amendment — tax on conversions and partial credits (PR 11 review, 2026-10-06/07)

Still a proposal; the owner approves or rejects it with the rest of this ADR. It is recorded after the code
on PR 11's branch, as this ADR's decision itself was (AGENTS.md requires the proposal first; the review fixed
the design and this amendment writes it down). No migration and no new ADR number: the rules live in
`packages/db/src/ar-ap/invoice.ts` (`convertToInvoice`), `packages/db/src/ar-ap/credit-note.ts`
(`creditNoteFrom`), `packages/db/src/inventory/fulfilment.ts` (`convertOrderToDelivery`),
`packages/db/src/documents/link.ts` (`linkFulfilment`) and the `PUT …/documents/{id}/lines` handler in
`apps/api/src/routes/accounting/documents.ts`.

**Context.** Under policy version 2 SALES_INVOICE and PURCHASE_INVOICE apply tax, but 4A's delivery/receipt →
invoice conversion wrote every line with no tax code and zero tax and never ran the persist-time computation,
and 3D's order → delivery conversion carried no code either, so a converted invoice could never carry tax.
The only way to add codes afterwards was `PUT …/lines`, whose delete-and-reinsert cascaded the conversion's
`converts_to` links away (0037's `target_line_id … on delete cascade`) and let the delivery be invoiced twice.
Separately, 4A's partial credit note pro-rated net, tax and gross independently, which was harmless while
every tax was zero and is not now (decisions 8 and 9).

**Decisions.**

1. **Which code a converted line carries.** `ConvertToInvoiceBody` and each `ConvertLineSchema` gain an
   optional, nullable `taxCodeId` (additive). A line's code is its own, else the body's, else the SOURCE
   line's, else none — chained on _absent_, so an explicit `null` at either level means "no code" and stops
   the chain (a line's `null` beats the body's code; the body's `null` beats the source lines' codes). Every
   resolved code must be a code of the source's company, checked once for the set before any insert
   (`ERR_NOT_FOUND`, as `assertLinesBelong`): `document_line_tax_code_fk` is tenant-composite only.
2. **Tax is computed at persist time on the conversion too.** After the lines and links are written,
   `computeDocumentTax` runs — the one computation this ADR names — so an archived code or one not effective on
   the invoice date is its `ERR_TAX_REGIME_MISMATCH` (422).
3. **The converted draft is tax-EXCLUSIVE.** The conversion residue ("whole − Σ already converted") sums
   earlier conversions' `amount`, which must stay the net figure; an exclusive computation never rewrites
   `amount`. The header is written `tax_inclusive = false`, and a coded line into a target type whose policy
   _declares_ `tax.inclusive: true` (which wins over the header) is refused (`ERR_VALIDATION_FAILED`).
4. **A tax-inclusive source fails closed.** When the source's header is `tax_inclusive` and the target applies
   tax, any coded line — named by the caller or inherited from the source line — is refused
   (`ERR_VALIDATION_FAILED`): the source's price is gross, and a residue over gross figures is not defined.
   An inherited code is refused rather than dropped, because dropping it would draft an untaxed invoice under
   a taxing policy with no signal. The exit is explicit: `taxCodeId: null` converts the source untaxed, the
   gross price invoiced as the net, on the caller's stated choice.
5. **3D carries the tax facts it already prices with.** `convertOrderToDelivery` writes the order's
   `tax_inclusive` on the delivery header and each order line's `tax_code_id` on every delivery line drafted
   from it (each FEFO split alike). DELIVERY_ORDER applies no tax, so nothing is computed on the delivery;
   the facts travel so decision 1 inherits the order's code by default and decision 4 sees an inclusive
   order's gross price.
6. **A derived draft's lines are not replaceable.** `PUT …/documents/{id}/lines` refuses (409
   `ERR_DOC_STATUS_ILLEGAL`) a draft any of whose lines is the target of a `converts_to` link ("delete the
   draft and convert again"), and a draft holding a `returns` target **only when its header's
   `reverses_document_id` is set** — a `creditNoteFrom` note, since a client draft through `POST …/documents`
   can never set it ("delete the draft and draft the credit note again"). Those are the claims whose figures
   the residue rules sum. The remedy is to delete the draft (0037's other release path, which drops the
   links with the lines they priced); a draft cannot be voided (0022 admits `void` from `issued` only).
   **Deviation from the review's design**, which asked for every link kind: `fulfils`, `receives_against` and
   a client-keyed `returns` draft such as 3C's `PURCHASE_RETURN` keep `PUT …/lines` as their release path
   (0037), and `apps/api/test/routes/accounting/document-transfer.test.ts:377` replaces a TRANSFER_RECEIPT's
   `receives_against` lines and expects 200. The first, unscoped form of this guard broke that test and froze
   client-drafted purchase returns (PR 11 integrated review); the review's sanctioned fallback was to drop
   the guard entirely, which would have left the blocker's own path open.
7. **3C's price copy carries the order's tax facts too** (PR 11 integrated review). The purchase side, and a
   client-drafted delivery, are priced by `linkFulfilment`'s `priceFromSource` (`POST …/documents/{id}/links`),
   not by 3D. Where a price is actually copied, a copy between documents whose `tax_inclusive` differs is
   refused (`ERR_VALIDATION_FAILED`, before anything is written: draft the target with its order's
   `taxInclusive`), so an inclusive order's gross price can no longer reach decision 4 as a net one; and for
   `fulfils` and `receives_against` only, the source line's `tax_code_id` is copied onto a target line that
   names none, as decision 5 does for 3D. Service callers pass `priceFromSource: false`, so no service path
   changes.
8. **A partial credit note derives its tax** (PR 11 review, blocker B1). `creditNoteFrom` pro-rates the net
   (`amount`) and the gross (`total_incl_tax`) — the completing credit taking the residue of each, as before —
   and writes each credited line's tax as gross − net. Pro-rating all three independently left a credited
   line 0.0001 out of `amount + tax = total` about one time in five on a one-third credit, and the credit note
   could not post (the document-currency balance check has no tolerance). Over a full sequence of credits the
   credited tax sums exactly to the source line's. **Known limit:** on a line whose tax is a few
   ten-thousandths credited in many pieces, the completing credit can carry tax of the opposite sign (net
   0.0017 at 11% over five units: four notes of tax 0.0001, then −0.0002); it posts balanced and every sum
   stays exact. Removing it means cumulative-share rounding for every partial split, which is open question 6.
9. **A partial credit refuses a history it cannot trust** (PR 11 integrated review). Decision 8's residues
   assume every claim already counted against the line is a share of it with `total = amount + tax`. A
   counted `returns` claim is trusted only when its document's `reverses_document_id` is the settled invoice,
   its target line is the target of that one link and no other, and that line holds the identity; every note
   `creditNoteFrom` writes, and every untaxed 4A-era note, meets all three. Any other claim — for example a
   credit note drafted through `POST …/documents` and priced through `POST …/links`, which leaves its tax and
   gross at zero — refuses the credit with `ERR_VALIDATION_FAILED` naming the claim's documents, where
   before it let a wrong note post (net 300 − 100 against gross 333 − 0 derived a tax of 133).

**Consequences.** A delivery- or receipt-sourced invoice is taxed by the code its order carried, by a code the
caller names, or — explicitly — by none. An inclusive source cannot be converted with tax at all until
question 1 below is answered. A partial credit note always posts balanced and refuses a history it cannot
trust. Tests: `packages/db/test/tax/convert-to-invoice-tax.test.ts` (both directions, the partial-conversion
residue, foreign currency base twins, every refusal, the order → delivery carry, the link price copy),
`packages/db/test/tax/credit-note-rounding.test.ts` (the 0.0001 split in both directions, full sequences,
foreign currency, the opposite-sign limit, every untrusted history) and
`apps/api/test/routes/accounting/invoices.test.ts` / `document-links.test.ts` (the wire, `null` at both
levels, the PUT-lines 409s and the client `PURCHASE_RETURN` that may still replace its lines).

## Amendment — round 3: deliveries, tax planning, the seed and tax returns (PR 11 review, 2026-10-07)

Still a proposal; the owner approves or rejects it with the rest of this ADR. Like the amendment above it is
recorded after the code (AGENTS.md requires the proposal first; the review fixed the design and this writes it
down). It takes no migration, no new error code and no new ADR number. Decisions are numbered on from the
amendment above. The rules live in `packages/db/src/inventory/fulfilment.ts`, `packages/domain/src/posting/evaluate.ts`,
`packages/db/src/seed/` (config and `tax.ts`), `packages/db/src/tax/returns.ts`, `packages/db/src/tax/codes.ts`,
`packages/db/src/posting/tax.ts` and `packages/domain/src/tax/jurisdiction.ts`.

10. **A drafted delivery shares the order line's discount; it does not copy it.** `discount` is a line total.
    `convertOrderToDelivery` gives each line it drafts (every FEFO lot split, the shortfall pair, every partial
    delivery) the share pro rata to that line's quantity — `Money.multiply` by the exact micro-unit `Rational`,
    rounded once HALF_AWAY_FROM_ZERO — and the line that completes the order line takes the residue: the order
    discount less what earlier lines of this call and earlier deliveries of that order line already carry.
    Earlier deliveries are read after the per-line `document_link:<line>` advisory locks (LEGACY-017's order), over
    both order → delivery kinds (the service's `converts_to` and a client-drafted `fulfils`), counted as
    `app.document_open_quantity` counts a claim. Before this, a 6 + 4 split of 10 × 10.0000 less 5.0000 was
    invoiced 90.0000, and since decision 5 it was also taxed on 90; it now invoices 95.0000, taxed on 95.0000.
11. **A delivery history outside zero to the order line's discount is refused.** A client-drafted delivery
    carries the discount its client keyed; when the counted deliveries already carry more than the order line's
    discount, or the opposite sign, the residue would be a surcharge (or more than the order gave) on a
    delivery the service drafts, which 4A's conversion would invoice and tax. `convertOrderToDelivery` refuses
    with `ERR_VALIDATION_FAILED` naming those deliveries, on every asked line of that order line, before
    anything is written — decision 9's posture towards an untrusted history. An undiscounted order line
    therefore admits no delivery discount: an allowance keyed on a client delivery of it holds the service's
    deliveries of the rest until that delivery is corrected, deleted, voided or reversed (question 7).
12. **A non-completing share never takes more than is left.** Shares rounded HALF_AWAY_FROM_ZERO can round up
    (five units less 0.0003, delivered singly, carried 0.0004 in four shares and left −0.0001), so a
    non-completing share is capped at what the order line has left to carry. With decision 11, every figure the
    service writes lies between zero and the order line's discount, in its sign — a departure from decision 8's
    pure pro-rata, in the way decision 8's known limit anticipates.
13. **Tax lines are planned once per document, not once per `each_tax` rule.** `evaluatePolicy` builds
    `plan.taxLines` over the union of lines any `each_tax` rule's `when` matches, each line counted once,
    grouped per tax code; `lineNo` is the group's first line and `amount` is signed. Ledger legs remain one set
    per rule. Planned per rule, a reverse-charge pair (debit input, credit output, one code) planned one group
    twice and step 11 failed on `app.tax_transaction`'s `(document_id, line_no, tax_code_id)` key; two
    overlapping filters planned one code from two first lines and a return counted that tax twice. A
    single-rule policy (every seeded one) plans byte-identical tax lines; a policy with none plans none.
14. **The seed never loads a synthetic regime into a production company.** `SeedConfig.appEnv` is read from the
    seed's own `APP_ENV` exactly as the API reads it (unset is `dev`; anything outside dev, staging, production
    exits 2). In production the `tax` loader validates a regime's files, then skips one whose `source` begins
    with `SYNTHETIC` (the OD-15 guard's marker) and reports it in `SeedResult.skipped`. The seed is an offline
    CLI that never reads the container's environment, so it warns when `APP_ENV` is unset, and every runbook
    seed command names it, which a test checks across `docs/runbooks`.
15. **No two returns of one company and regime share a day.** A `tax_transaction` is in every return whose
    inclusive range covers its `effective_date`, so overlapping ranges reported it twice. `createTaxReturn`
    refuses a range against any return of the same company and regime that shares a day with it, naming each,
    as 409 `ERR_CONFLICT_UNIQUE`; `unique (company_id, regime_id, period_start)` stays as the backstop. Adjacent
    ranges and another regime's returns over the same days are admitted. A filed return blocks overlap like any
    other: a correction goes into a later period's return (decision 16).
16. **A filed return's period takes no new tax facts.** At posting step 11, `insertTaxTransactions` reads
    `for share` the returns of the document's company and regime whose range covers its `effective_date`; if
    one is filed the post is refused with `ERR_PERIOD_NOT_OPEN`, naming the return and its range. An invoice,
    a credit note and a reversal are refused alike; a document with no tax line is unaffected, and the fiscal
    period remains the ledger's own control.
17. **A stale return does not file.** `fileTaxReturn` rebuilds the payload with the builder `generateTaxReturn`
    uses and refuses any byte difference from the stored payload with `ERR_DOC_STATUS_ILLEGAL`, "regenerate it
    before filing". Filing still writes no payload (test 26's byte identity). Decision 16's share lock and
    filing's `for update` on the return mean a racing post and filing cannot both commit with the post inside
    the filed range.
18. **A return is in the company's base currency, empty or not.** `JurisdictionPack.buildReturn` takes an
    optional `currency` (additive); when given, every box is in it and a transaction in another currency is
    `ERR_TAX_REGIME_MISMATCH`. `generateTaxReturn` always names the company's base currency; the MYR golden
    payloads are byte-identical.
19. **The tie-out reads the accounts the regime's own codes name.** Each side sums `account_balance` over every
    distinct account named by the regime's output (or input) codes, archived codes included, falling back to
    the §4.15 account (2300 output, 1350 input) when the regime declares none; `accountCode` is the sorted codes
    joined with `+`, still `2300` and `1350` for the synthetic regime. Because the sign comes from
    `app.account.type`, an output code's account must be a liability and an input code's an asset:
    `createTaxCode` refuses a misfit with 422 `ERR_POLICY_REQUIRES_MISSING`, and the seed's `taxLoader` with a
    `SeedError`.
20. **Lock order for the return writers.** A taxed post holds the tenant's audit chain from its first audited
    write and takes the covering return `for share` only at step 11, so `createTaxReturn`, `generateTaxReturn`
    and `fileTaxReturn` take the audit chain (`lockTenantAuditSerial`) before their first row lock and queue
    behind a post rather than deadlock with it (40P01 before). `createTaxReturn` locks the regime row
    `for no key update`, not `for update`: an insert into `app.tax_code` takes `for key share` on the regime
    through its foreign key before its audit trigger waits on the chain, so `for update` deadlocks with
    `POST …/tax-codes`. **Accepted cost:** generate and file now hold the tenant-wide audit chain across the
    payload build (and the generate route across the tie-out), so every audited write in the tenant waits for a
    return build.

**Consequences.** The deliveries of an order line carry its discount once between them, within bounds. A
reverse-charge policy posts. A production seed loads no synthetic regime. A return's range excludes every other
return of its regime; a filed tax period is closed to tax facts; filing requires a generation current with the
period; an empty return is in the company's currency; the tie-out follows the regime's own accounts. Under
AGENTS.md's company-binding rule the five return and code services also take an optional `companyId` (a Plan
Contracts row, not a decision of this ADR). Tests: `packages/db/test/inventory/fulfilment-discount.test.ts`,
`packages/domain/test/posting/evaluate.full.test.ts`, `packages/db/test/posting/tax-transaction.test.ts`,
`packages/db/test/seed/tax-pack.test.ts`, `packages/db/test/tax/return-integrity.test.ts`,
`packages/db/test/tax/returns.test.ts`, `packages/domain/test/tax/malaysia.test.ts`, and
`apps/api/test/routes/accounting/tax-returns.test.ts`, `tax-codes.test.ts` and `tax-company-scope.test.ts`.

### Open questions (the owner's)

1. **How should a tax-inclusive source be invoiced with tax?** Extract the net per conversion (the residue
   would then sum extracted bases and strand the rounding difference in `1250`/`2150`), define the residue
   over gross figures, or keep refusing. Until answered, only an explicit untaxed conversion is possible.
2. **Is a SALES_ORDER's or PURCHASE_ORDER's `tax_inclusive` a meaningful "prices are gross" signal** when its
   policy applies no tax? Decision 5 treats it as one (0054's column comment: "Line amounts include tax when
   true"); if it is not, the delivery should not carry it.
3. **Should an uncoded line into a target that applies tax be refused** unless the caller states
   `taxCodeId: null`? Today it drafts untaxed with no signal, as on every other entry point (the generic
   draft and `PUT …/lines`); refusing would change every existing 4A conversion caller.
4. **The other link kinds' cascade.** `PUT …/lines` on a draft that is a `fulfils` or `receives_against`
   target still drops those links (by 0037's design) and reopens the source, which a conversion can then
   take again while the client's draft still stands. Carry the links across the replacement, or refuse and
   redraft, as decision 6 does for the service-computed kinds.
5. **Should the conversion residue trust a client's `converts_to` link?** `POST …/links` admits every link
   kind, so a client `converts_to` claim at figures the client chose is summed by `convertToInvoice`'s residue
   exactly as decision 9 now refuses to sum an untrusted `returns` claim. Tax is unaffected — a converted line's
   tax is computed by the engine from its own net — but the net residue is not. Restricting `converts_to` to
   the service (or applying decision 9's trust test) is 4A's to decide.
6. **Cumulative-share rounding for every partial split?** Cutting each partial share as
   `round(full × cumulative quantity ÷ whole) − already taken` would remove decision 8's opposite-sign limit and
   the same overshoot on net and gross, for credit notes and conversions alike, but it changes how money
   splits across notes.
7. **Refuse or clamp an out-of-bound delivery history?** Decision 11 refuses, which holds an undiscounted
   line's remaining deliveries until a client delivery carrying an allowance is corrected, voided or reversed
   (possibly a posted delivery). The alternative clamps what the service writes to between zero and what is
   left, never refusing; it keeps deliveries moving but carries the order/delivery discount mismatch into the
   invoice's net and taxable base without a signal, as question 5's trust of a client `converts_to` does.
8. **`ERR_PERIOD_NOT_OPEN`'s title and remedy.** The frozen registry entry reads "Fiscal period is not open" /
   "Use an open period." (Plan Contracts §4.2.4 names `assert_period_open` as its raiser; the title is pinned
   at `apps/backoffice/test/shell.test.tsx:310`). Decision 16 also raises it for a document dated in a filed
   tax return's range, with a detail naming the return. Generalise the title and remedy (for example "Period
   is not open" / "Use an open fiscal and tax period.") and register `insertTaxTransactions` as a raiser, or
   keep the entry and rely on the detail.
9. **Should decision 15 be a database constraint?** It is enforced by `createTaxReturn` under a lock, so a
   writer of `app.tax_return` that bypasses it is not held to it. An exclusion constraint —
   `exclude using gist (company_id with =, regime_id with =, daterange(period_start, period_end, '[]') with &&)`,
   which needs `btree_gist` — would make it the database's; that is a migration, so it was not taken here.

## Amendment — tax side, the tie-out's remittance and inclusive rounding (2026-11-15 full review)

**Status:** Proposed, with the ADR. Findings MON-04, MON-06 and MON-12 of the 2026-11-15 full review
(`docs/review/2026-11-15-full-review.md`). Every decision above stands; these add to decisions 19 and to the
original "each code declares its rounding mode". No migration, no pack-file change and no authority datum (OD-15):
the synthetic regime's boxes gain a `side` their own labels already state.

21. **A tax fact's side is its document's.** A code's `kind` is not a side: `zero`, `exempt` and `out_of_scope`
    are used on sales and purchases alike, and summing boxes by kind put an exempt supplier's PURCHASE_INVOICE
    into the supplies box S3 (MON-04). The pack format states no side on a document type, and
    `PostingPolicy.direction` is the goods' direction (a sales credit note is `inbound`), so the side is
    **derived** from the policy: `taxSideOf(policy)` is `output` when every `each_tax` rule posts to
    `tax_code.output_account`, `input` when every one posts to `tax_code.input_account`, and `null` for a
    reverse-charge pair or a policy with none (`packages/domain/src/tax/side.ts`). `generateTaxReturn` reads it
    from the policy each document posted under; it is not stored, so `app.tax_transaction` is unchanged.
22. **Boxes sum by side and kind.** `ReturnBoxDef.side` and `TaxTransactionRow.side` are optional (additive to
    §4.9.1 and amendment A5). A box with a side takes a fact only when the fact's side — the document's, or the
    code's own when the document has none — is the same or unknown. `SYNTH-MY-v1`'s S1–S3 are `output` and
    P1–P2 `input`. An exempt or zero-rated purchase is in no box of this regime; a definition that wants one
    adds an input-side box (OD-15). Payload bytes are unchanged: a box's `side` is not in the payload.
23. **A code that declares the other side is refused.** An `input` code on an output-side document, or an
    `output` code on an input-side one, is `ERR_VALIDATION_FAILED` (400) at persist time (`computeDocumentTax`),
    and `ERR_POLICY_REQUIRES_MISSING` (422) at post — the refusal its non-zero twin already got from the missing
    account. The evaluator makes the check before its zero-amount group drop, which had skipped it, so a
    zero-rated input code on a sale no longer posts (`packages/domain/src/posting/evaluate.ts`). `zero`,
    `exempt` and `out_of_scope` codes declare no side and are admitted on either.
24. **The tie-out explains the tax accounts' non-tax movement** (amends decision 19; MON-06). `ledgerBase` is
    `account_balance` over the period less the legs, on the same accounts and periods, of documents that carry
    no `tax_transaction` of the regime — the remittance of an earlier period's tax, an `OPENING_BALANCE`, a
    manual JOURNAL — read from `ledger_entry` because `account_balance` has no document key. Before, a period
    after the first remittance reported the last period's tax as its difference. **Accepted cost:** a manual
    JOURNAL that corrects tax on these accounts no longer shows as a difference; it is explained the same way.
    The response shape is unchanged.
25. **The code's rounding mode rounds the tax on an inclusive line too** (MON-12). Inclusive is now
    `tax = round(amount × rate / (1 + rate), 4, mode)` and `base = amount − tax`; `base + tax = amount` still
    holds exactly. Rounding the base in the mode and subtracting rounded the tax the other way under
    `TOWARD_ZERO` and `AWAY_FROM_ZERO` (inclusive 10.0000 at 0.11 toward zero: 0.9910 before, 0.9909 now). The
    half modes differ only at an exact midpoint of the tax, which the shipped 0.11 rate cannot produce, so no
    golden figure changed. The till prices through the same `computeTaxLine`.

**Owner questions.** (a) Should an exempt or zero-rated purchase be reported at all, and in which box — the
synthetic regime now reports it nowhere (OD-15 decides for the real one)? (b) Should a manual JOURNAL on a tax
account be listed in the tie-out as its own explained line rather than netted out of `ledgerBase`, which needs
a contract change to `TaxReturnTieOutRow`?

Tests: `packages/db/test/tax/direction.test.ts`, `packages/domain/test/tax/engine.test.ts`,
`packages/domain/test/tax/malaysia.test.ts`, `packages/domain/test/posting/evaluate.full.test.ts`,
`apps/api/test/routes/accounting/tax-codes.test.ts` (MON-13, a 200 archive whose replay is not a 500) and
`tests/regression/legacy-020.test.ts`.

## Phase 6 historical POS refunds — 2026-10-08

The authorized POS return integration in proposed ADR 0056 extends `computeDocumentTax` with optional server-only verified historical-source context. Referenced refunds derive net/gross/tax from immutable sale facts and trusted quantity-bounded return links, using proportional shares and the exact completing residue as the existing credit-note path does. Wire tax is compared with those derived facts. This prevents repeated inclusive-quotient rounding from exceeding the original tax by a fourth decimal. Archived or expired codes are admitted only when immutable same-company source facts prove their use; new sales and blind returns retain the unchanged engine path. Posting still owns all tax-transaction writes. Full refunds must conserve gross, net, tax and carrying cost. This implements the existing source-fact preservation requirement for POS and does not resolve the unrelated open questions above; formal ADR status remains Proposed.
