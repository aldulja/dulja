# Periodic tax return

Requires `accounting.tax.manage` to create and generate; filing requires `accounting.tax.file`. The shipped regime is synthetic and must never be used for statutory filing. OD-15 must be resolved before deploying a verified jurisdiction pack.

1. Confirm the period's invoices and credit notes are posted. For example: `GET /v1/companies/{companyId}/documents?filter[status][eq]=draft&limit=50`. Review effective dates and unresolved drafts before proceeding.
2. List existing returns: `GET /v1/companies/{companyId}/tax-returns?filter[regimeCode][eq]=SYNTH-MY-v1&limit=50`. Reuse the period's existing row. A return covers whole fiscal periods.
3. Create a draft using `POST /v1/companies/{companyId}/tax-returns` with `regimeCode`, `regimeVersion`, `periodStart` and `periodEnd`. Include a fresh `Idempotency-Key`.
4. Generate with `POST /v1/companies/{companyId}/tax-returns/{taxReturnId}/generate`. Inspect every `tieOut` row; stop when any `difference` differs from `0.0000`.
5. Compare each box against the accountant's working and review the regime's provenance. Uncoded lines do not contribute to boxes; exempt and zero-rate lines remain posted tax facts.
6. Save the canonical payload and `payloadSha256` with the filing working. An unchanged regeneration produces identical bytes and hash.
7. Correct posted errors through a credit or reversal, then regenerate an unfiled return with a new idempotency key. A correction that changes its figures changes its hash. Filed returns cannot be regenerated.
8. Once the verified payload has been filed through the approved authority procedure, record the acknowledgement using `POST /v1/companies/{companyId}/tax-returns/{taxReturnId}/file` with `filedAt` and optionally a same-company `attachmentId`. Filing changes status only and preserves payload bytes. The e-invoice job submits individual documents; it does not file periodic returns.

Company e-invoicing settings and document transmission recovery are described in [e-invoice transmissions](einvoice-transmission.md). Production authority transport is unavailable until ADR 0051 records verified requirements and OD-15 supplies credentials.

## Approved default screen

Open **Tax returns** in the backoffice shell (`/accounting/tax-returns`). Select the regime/version and enter complete fiscal-period bounds, then create a draft (Ctrl+S). Open a row with its button or arrows/Enter, and generate it with Ctrl+G. Compare the boxes, both reconciliation rows and the payload hash together. Nonzero differences display a textual warning. Ctrl+N starts a new draft form, Escape reverts, and slash focuses the regime filter. The language switcher supports English and Arabic.

The screen uses a stable idempotency key when retrying an ambiguous network failure and protects against duplicate presses. Filed rows disable generation. The default workflow has no filing button; the approved authority procedure and filing API above remain separate. Owner approval of this screen does not make the synthetic regime a statutory return.
