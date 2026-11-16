# ADR 0048 — Bank reconciliation never alters a ledger entry

- **Status:** Proposed (spec:95 — this touches money semantics, so it is asked before it is implemented)
- **Date:** 2026-09-28
- **Slice:** 4B (Task 6 — migration 0049 and the statement import; Task 7 — migration 0050, the matching)

## Context

spec:1043 requires "statement import (CSV), match/unmatch against receipts, payments, payroll batches and
till bankings; unreconciled-items report", and acceptance test 39 adds "matching never alters a ledger
entry; the reconciled balance equals the bank account's ledger balance". The legacy system's equivalent
did the opposite: SAH-031 shows a direct `UPDATE "VouItems"` on a signed, locked, closed-period voucher
silently rewriting `AccTotals` to match, and SAH-041 shows the anti-tampering triggers shipped inactive.

## Decision

**A match is a row in `app.bank_match` and nothing else.** No statement import, no match and no unmatch
writes, updates or deletes a `ledger_entry`, an `account_balance` or a `document` row.
`packages/db/src/ar-ap/reconciliation.ts` is outside `posting/` and `costing/`, so the
`posting-only-tables` lint (§3.7.5) makes that mechanical rather than a promise. **A match in a locked
period therefore succeeds** — there is nothing for `assert_period_open` to refuse — and the locked
period's ledger rows are byte-identical afterwards, which is what the sah-031 regression block asserts.

**Unmatching sets `unmatched_at`; nothing is deleted.** §3.5.4's `app_rw` DELETE list is pinned to five
tables and 2B is its only extender, so a `bank_match` row survives its own reversal and the audit trigger
keeps the before-image. spec:2049 admits deletion for drafts and for the erasure workflow, and a match is
neither. Statements and their lines are not deleted either: a wrong statement is superseded, and neither
table's foreign keys cascade.

**A statement line's `amount` is signed; a match's `amount` is a magnitude.** The line's sign is the bank's
own convention (money in positive) and the match's direction comes from the line, so
`bank_match.amount` carries `check (amount > 0)` and the direction is never inferred from a sign
(§4.4.2 A9's rule applied one layer out). A `reconcilable_kind` whose direction disagrees with the line's
sign is `ERR_BANK_MATCH_AMOUNT`, not a silent partial match. A line of zero is refused at import and by
`bank_statement_line_amount_check`: a zero movement is not a fact about the bank and could never be matched.

**The `Reconcilable` registry, not a type list.** `registerReconcilableSource(source)` is the seam 6D's
till bankings and 8C's payroll batches plug into, and the `reconcilable_kind` CHECK already admits both
labels (§4.8.3), so neither slice edits a file of this one. **4B registers the `receipt` and `payment`
sources itself**: `reconciliation.ts` is in this slice's migration and file range and does not exist
before Task 6, so 4A had nothing to register into (contracts §4.8.3, 4A amendment 12, round 7).

**A source lists from the ledger's bank leg, not from a document total.** `Reconcilable.amount` is
`Σ(debit − credit)` on `ledger_entry` for the statement's own `bank_account_id`, and `valueDate` is the
document's `effective_date`. That works for a receipt banked into any of several bank accounts, for a
payment that draws on one, and for 6D's and 8C's documents without either slice having to know what a
"total" means for its own type.

**`CsvMapping` carries the statement header.** §4.8.3 freezes `importStatement`'s input as
`{ companyId, bankAccountId, csv, mapping }`, and `bank_statement.statement_date`, `opening_balance` and
`closing_balance` are all NOT NULL, so `mapping` is the only place they can come from. The **currency is
not** on the mapping: it is `coalesce(account.currency, company.base_currency)`, because a statement is
always in its account's currency and letting a caller declare another is a class of error. In the
two-column bank form, **debit is money out**: `amount = credit − debit`.

**The import validates the statement against itself.** `closing_balance − opening_balance` must equal
`Σ amount` over the parsed lines, or the import is refused with `ERR_VALIDATION_FAILED` naming the
difference. A statement that does not add up is a bad file or a bad mapping, and importing it would make
every later "reconciled == ledger" assertion meaningless. For the same reason an amount finer than 4 dp
and a date that is not on the calendar are refused, naming the line, rather than rounded or coerced: a
stored line that differs from the file is a silent correction (SAH-019) the balance check cannot see.

**A statement belongs to one company, and so does every line of it.** RLS bounds the tenant and nothing
else, so the import matches the bank account on both its id and the company, and a line's key is
`(tenant_id, company_id, statement_id)` against the statement's `(tenant_id, company_id, id)` — a line
cannot name a sibling company's statement inside the same tenant, and every read takes the company.

**Task 7's matching rules (migration 0050).** Written here because each one closes a gap the plan text left
open, and each is money semantics:

- **A match row is fixed at insert, and the unmatch carries its reason.** `app.bank_match` gains
  `unmatch_reason text` beside §4.8.3's columns, and `bank_match_guard` (0046's `allocation_guard`, applied
  to the twin table) admits a row only live and admits exactly one update — the unmatch, once, with a
  non-blank reason. `unmatch(…, { reason })` has always compelled a reason, and `app.audit_row` writes
  `to_jsonb(new)`: a reason with no column is one no auditor can recover — the loss ADR 0023 fixed for
  `fiscal_period.reopen_reason` and 4A's amendment 11 fixed for `allocation.unallocation_reason`.
- **Every read and write names the company.** `match`, `unmatch`, `reconciledBalance` and
  `unmatchedStatementLines` take a required `companyId` (as Task 6's `listStatementLines` does), and the
  match row's line key is `(tenant_id, company_id, statement_line_id)` against a new
  `bank_statement_line (tenant_id, company_id, id)` unique — so a match cannot name one company and point at
  another's line inside the same tenant.
- **A kind's source decides which documents it covers.** `match` resolves the document through its kind's
  registered source (over the one-day window of the document's `effective_date`), so a `receipt` naming a
  PAYMENT, or a journal that happens to debit the bank, is refused; a kind with no registered source matches
  nothing.
- **The ledger figure is in the account's own currency.** For a base-currency bank account every figure — a
  source's `Reconcilable.amount`, `match`'s capacity and `reconciledBalance().ledger` — is read from the
  BASE columns (a EUR receipt banked into a ringgit account arrived as ringgit); for a foreign-currency
  account it is the document columns of the rows in that currency, and a base-only row moves no foreign
  amount. A raw `Σ(debit − credit)` adds euros to ringgit as soon as one foreign document touches the account.
- **A full reversal runs the other way.** A reversed receipt (a bounced cheque) is money out: its mirror
  matches the bank's debit line and never the original credit a second time. The direction a match needs is
  the kind's, turned round for a document whose `reverses_document_id` names a `reversed` original, and it
  must agree with both the line's sign and the document's own bank leg.
- **Capacity is per bank account.** A document's remaining figure is its leg on the line's bank account less
  its live matches on lines of that account's statements, so a receipt split across two bank accounts is
  reconciled on each separately.

## Consequences

- `reconciledBalance(tx, { bankAccountId, asOf })` returns `{ statement, ledger, unreconciled }` and
  `statement === ledger` is the definition of done. It does **not** return unmatched *statement* lines —
  the frozen type has no member for them — so `unmatchedStatementLines` is a sibling function and the
  API returns both (Task 8).
- 7C's registered `accounting.unreconciled_items` report code is **not** shipped here (§4.16.1 owns it);
  this slice's unreconciled list is that function behind a `GET`.
- A partly-matched line is legal during a month and illegal at close: `reconciledBalance` reports the
  residue through `unreconciled` and the operator's runbook step is to finish or unmatch it.
- `listStatementLines` reports `matchedAmount` as Σ live `bank_match.amount` against the line and its
  `unmatchedOnly` filter keeps a line while `|amount| > matched` (Task 7 replaced Task 6's constant).
- Two limits are recorded in `docs/runbooks/bank-reconciliation.md` rather than designed away: a bank
  charge or interest line has no kind to match (the vocabulary is §4.8.3's four), and a receipt reversed
  before it reached the bank stays listed with its reversal, neither half matchable — the pair nets to zero
  in the ledger, so `statement == ledger` still holds.
