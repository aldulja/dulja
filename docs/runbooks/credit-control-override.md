# Runbook — releasing an over-limit sale

The procedure for letting one sale through a customer's credit limit. The control is in the database
(migration 0045's `app.assert_credit_available()`, spec:1026, spec:2173): it runs when an outbound
document for a customer moves to `issued`, whichever path asks — the API, a job, or `psql` as `app_rw`.
The limit and the customer's open balance are both in the company's **base currency**.

**Who:** two principals. The person raising the sale, and a **second** principal holding
`accounting.credit_limit.override` at the document's branch (the seeded `accountant` role holds it). One
person cannot do both — the database refuses it (`ERR_OVERRIDE_NOT_AUTHORISED`, contracts §4.5.3).

1. The salesperson drafts and submits the invoice as usual. Issuing it fails with
   `ERR_CREDIT_LIMIT_EXCEEDED`, and the message names the customer, its limit, its open balance and this
   document's base total.
2. Decide which it is:
   - **the limit is wrong** — raise `party.credit_limit`
     (`PATCH /v1/companies/{companyId}/parties/{partyId}` with `creditLimit` in the base currency). That is
     a change to master data, is audited, and needs `accounting.credit_limit.override` as well as
     `accounting.party.manage`; it applies to every later sale.
   - **this one sale is an exception** — record an override on this document. It applies to this document
     only, and it is the path this runbook is for.
3. The second principal, signed in as themselves, calls

   ```http
   POST /v1/companies/{companyId}/documents/{documentId}/overrides
   Idempotency-Key: <a fresh uuid>

   { "code": "accounting.credit_limit.override", "reason": "<why, in a sentence>" }
   ```

   The reason is not optional and it is not free of consequence: it is the `document_event.reason` an
   auditor reads (spec:2179).

4. The salesperson issues the invoice again
   (`POST /v1/companies/{companyId}/documents/{documentId}/transitions` with `{ "to": "issued" }`). It
   succeeds. The override event stays on the document forever and appears in
   `GET …/documents/{documentId}/events`.

**A credit HOLD is different and this runbook does not apply.** `ERR_CREDIT_HOLD` is not overridable
(contracts §4.8.1: "`party.credit_hold` blocks regardless"). Releasing a hold is a decision about the
customer, not about one document: clear `party.credit_hold` (`creditHold: false`) under
`accounting.party.manage`, which is audited like any other party change.

**`ERR_POLICY_REQUIRES_MISSING` naming a credit limit is a misconfiguration, not a limit.** A customer
that carries a credit limit and no receivable control account cannot have its exposure measured, so the
database refuses the sale rather than assume the customer owes nothing (LEGACY-042). Set the customer's
`receivableAccountId` (`1200` trade receivables is the default) or clear the limit. An override recorded
on one document lets that sale through exactly as it would an over-limit one — the comparison is what the
override skips — but it fixes nothing for the next sale; the account is the fix.
