# 0063 — A shift close derives `expected_cash` from the ledger, and the till sends only the count

- Status: **Proposed** (money semantics — spec:95 requires this be asked, not implemented first)
- Date: 2026-09-08
- Slice: 6D
- Supersedes / Amends: completes the `expected_cash` sentence of contracts §4.6.5 (amendment A3)

## Context

`app.shift` carries three cash figures: `opening_float` (declared at open), `counted_cash` (declared at
close) and `expected_cash` (what the drawer should hold). `over_short = counted_cash − expected_cash`,
positive is over. §4.6.5 described `expected_cash` as "opening_float + Σ cash tenders − Σ paid-outs and
safe-drops of this shift's posted tickets" — a formula over *ticket* data.

Two ways to obtain it were available.

**(a) Sum the tender lines.** Read `document_line` where `kind = 'tender'` and
`custom_fields.method = 'cash'` for every posted document of the shift.

**(b) Read the ledger.** Sum `debit − credit` on the company's `1110` Cash in till over the shift's posted
documents, in the shift's own currency.

## Decision

**(b).** `expected_cash = opening_float + Σ(debit − credit)` over `app.ledger_entry` rows whose
`account_id` is the company's `1110`, whose `currency` equals `shift.currency`, and whose `document_id`
belongs to a document of this `shift_id` with `status in ('posted', 'reversed')` and a `document_type.code`
other than `TILL_OVER_SHORT`. The till sends `countedCash` and nothing else; the server computes
`expected_cash` and `over_short`, and both are refused if they arrive in a payload.

## Consequences

- **The Z-report ties to the ledger by construction, not by agreement.** Acceptance test 21 asserts that
  the Z-report equals the ledger to the cent. Under (a) that assertion compares two independent
  computations and can fail for a reason nobody can localise; under (b) it compares the ledger to itself
  and can only fail if the *posting* is wrong — which is the defect worth catching.
- **Every future cash movement is included with no formula change.** OD-10's paid-outs, safe drops and
  bankings each post a `1110` leg, so they enter the sum the day their document type lands. Under (a) the
  formula would have had to grow a clause per type, and a type whose clause was forgotten would be a
  silent shortfall — SAH-055's shape ("a figure recomputed by a second, staler rule").
- **A POS return is handled without a sign rule.** A refund's cash tender posts a credit to `1110`, so
  `debit − credit` subtracts it. Nothing reads the sign of an amount to decide a direction (§4.4.2 A9).
- **`status in ('posted', 'reversed')` and not `= 'posted'`.** A reversed ticket's own entries stay in the
  ledger and its reversal's entries are there too; both belong in the sum, and filtering to `posted` would
  drop the original and leave the reversal, understating the drawer by twice the sale. This is 4B's
  `ledgerLegSource` predicate, deliberately reused.
- **`TILL_OVER_SHORT` is excluded** because it is posted *from* this figure. Including it would make the
  close idempotent on the wrong thing: a second close would compute an expectation that already contained
  the first close's correction and find a difference of zero.
- **One currency, never base.** A physical count is a count of notes in one currency. Summing base
  amounts would tie a MYR drawer to a MYR-equivalent figure and be off by the day's rate.
- **The cost is one join more than (a).** `ledger_entry` is indexed on `(company_id, account_id)` and the
  shift's documents are reached through `document_shift_idx` (0070), so the read is two index scans.

## Rejected

- **Trusting a till-computed `expectedCash`.** A till's clock and its arithmetic are both outside our
  control, and the figure decides who is short. Refusing the field is cheaper than validating it.
- **A stored running total on `app.shift`.** A counter updated per ticket is a second projection of the
  ledger with no integrity job behind it (D14's reasoning applied to cash).

## Proposal preparation

Prepared for owner review on 2026-10-07 from [2026-09-05-dulja-phase-6d-shifts-till-cash.md](../superpowers/plans/2026-09-05-dulja-phase-6d-shifts-till-cash.md). The source proposal date above is preserved. This record is proposed; no owner acceptance or implementation is recorded here.

## What we are asking

Approve deriving expected cash from the shift-currency ledger legs, including posted and reversed documents and excluding TILL_OVER_SHORT, with the till supplying only its physical count?
