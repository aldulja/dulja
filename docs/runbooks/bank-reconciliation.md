# Runbook — monthly bank reconciliation

The procedure for reconciling one bank account against the bank's statement for a month. It is written
down once here rather than implied by an API (spec:1043, acceptance test 39; ADR 0048).

**Who:** a principal holding `accounting.bank.reconcile` (the `accountant` role).
**When:** after every bank statement arrives; before the period is closed.

The one rule the whole procedure rests on: **nothing in it changes a ledger entry.** An import writes a
statement and its lines; a match writes one `app.bank_match` row; an unmatch sets `unmatched_at` on that row.
None of them writes, updates or deletes a ledger entry, a balance or a document — which is also why a match
against a document in a locked period succeeds: there is nothing for the lock to protect.

> The HTTP routes below are Task 8's (`/v1/companies/{companyId}/bank-statements`). Until that module is
> mounted, the same steps are the `packages/db` functions named beside each one.

---

## 1. Export the statement

Export the statement from the bank as CSV. Note the **statement date** and the printed **opening and
closing balances** — the import needs all three, and it refuses a file that does not add up.

The file may carry one signed amount column (money in positive) or the bank's two-column form, where a
**debit is money out**. Dates may be `YYYY-MM-DD`, `DD/MM/YYYY` or `MM/DD/YYYY`; a decimal comma is allowed.

## 2. Import it

```http
POST /v1/companies/{companyId}/bank-statements
Idempotency-Key: <a fresh uuid>

{ "bankAccountId": "<the bank's account id>", "csv": "<the file>", "mapping": { … } }
```

(`importStatement`.) The statement is in the **bank account's** currency — `coalesce(account.currency,
company.base_currency)` — never one the request names.

- A refusal naming a difference (`opening + Σ lines ≠ closing`) means the mapping picked the wrong columns or
  the file is partial. Fix the file or the mapping; nothing was imported.
- A refusal naming a line and a value means a date that is not on the calendar or an amount finer than 4 dp.
  The import never rounds or coerces a figure.
- `ERR_CONFLICT_UNIQUE` means a statement for this account and date already exists. A wrong statement is
  superseded by the next one, never deleted.

## 3. Match each line

```http
GET  …/bank-statements/{statementId}/lines?filter[matched][eq]=false
POST …/bank-statements/{statementId}/lines/{lineId}/matches
     { "kind": "receipt" | "payment", "documentId": "…", "amount": { "amount": "…", "currency": "…" } }
```

(`listStatementLines({ unmatchedOnly: true })`, `match`.) The amount is a **magnitude**; the line's sign
carries the direction. A line may be matched to several documents, and a document to several lines, until
either side is used up.

Every refusal is `ERR_BANK_MATCH_AMOUNT` (422), and its detail says which of these it is:

| Detail names | Meaning | Remedy |
|---|---|---|
| "money in" / "money out" — the direction disagrees | a receipt against a debit, or a payment against a credit | match the other line |
| "the reversal of a receipt is money out" | a reversed receipt (a bounced cheque) is money **out** | match its reversal to the bank's debit line and the original to the credit |
| "is not a receipt banked through account …" | the document is of another type, or has no leg on this bank account | pick the right document, or the right kind |
| "already carries … of matches" | the line is used up | unmatch the wrong match first |
| "already matched for …" | the document's bank leg is used up | the same document is on the statement twice — find the other line |
| "already carries a live match to document …" | the pair is matched already | unmatch it and match the whole amount once |
| a currency | the amount is not in the statement's currency | send it in the account's currency |

## 4. Read the reconciliation

```http
GET …/bank-statements/reconciliation?filter[bank_account_id][eq]=…&filter[as_of][eq]=YYYY-MM-DD
```

(`reconciledBalance` and `unmatchedStatementLines`.)

- **`statement` must equal `ledger`.** `statement` is the closing balance of the latest statement dated on or
  before `as_of`; `ledger` is the bank account's balance at `as_of`, in the account's own currency (a EUR
  receipt banked into a ringgit account counts at its ringgit figure).
- **`unreconciled`** lists every receipt and payment with a leg on the account up to `as_of` that is not
  fully matched. Each is either a genuine timing difference (an item that clears next month — leave it) or a
  document that belongs to another account.
- **`unmatchedLines`** lists every statement line not fully matched. Each is either a missing document (post
  it, then match it) or a line no v1 kind covers — see *Known limits*.

## 5. A wrong match is unmatched, never deleted

```http
POST …/bank-statements/matches/{matchId}/unmatch
     { "reason": "matched to the wrong line" }
```

(`unmatch`.) A reason is required and is stored on the row (`unmatch_reason`), so the audit log's
after-image carries it. The row survives with `unmatched_at` and `unmatched_by` set; an unmatch is never
undone — match again instead, which writes a new row.

## 6. Never "correct" the ledger through reconciliation

If a figure in the ledger is wrong, the remedy is a reversal in an open period (spec:2224) and a new
document — never an edit, and never a "correcting" match. A reversed receipt or payment is listed and
matched like any other document: the original against the bank's original movement, the reversal against
the bank's reversing movement.

---

## Known limits (v1)

- **Bank charges, interest and other bank-originated lines have no reconcilable kind.** The kinds are
  `receipt`, `payment`, `till_banking` (6D) and `payroll_batch` (8C). Post the charge as a journal so that
  `statement = ledger` holds; the line itself stays in `unmatchedLines`.
- **A receipt or payment reversed before it reached the bank** is listed in `unreconciled` together with its
  reversal, and neither half can be matched, because neither is on any statement. The pair nets to zero in
  `ledger`, so `statement = ledger` still holds.
- **Till bankings and payroll batches** join the same matching when 6D and 8C register their sources; until
  then a line for either stays unmatched.
