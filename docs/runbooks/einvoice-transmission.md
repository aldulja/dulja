# Runbook — e-invoice transmissions

**Who:** anyone holding `accounting.tax.file` (seeded to `accountant`).
**When:** a transmission is stuck at `pending`, `submitted` or `error`, or a document was transmitted
that should not have been.

## 1. Find the row

    GET /v1/companies/{companyId}/einvoice-transmissions?filter[status][eq]=error&limit=50

`lastError` is the refusal, `attempts` the number of claimed attempts (including configuration failures before HTTP), and `polledAt` the last completed attempt. (`claimed_at`, the column that says a call is in flight right now, is deliberately not on
the wire: it is a lock, not a fact about the transmission, and an operator who needs it reads the row.)

## 2. What each status means

| Status | Meaning | What to do |
|---|---|---|
| `pending` | The document posted; no remote call has succeeded yet. Either the job has not run or every attempt failed. | `POST …/{id}/submit` |
| `submitted` | The remote system queued the request and has not yet returned a final verdict. | Automatic polling backs off and stops at twelve total attempts, including submission and transient retries. After that, escalate for controlled reconciliation through the existing `pollTransmission` service; the submit API cannot act from this state. |
| `accepted` | Final. `qrPayload` and `externalId` are set. | Nothing |
| `rejected` | The authority refused the document. `lastError` carries its reason. | Correct the document by **reversal** (LEGACY-041, never by editing), post the correction, and let its own transmission run |
| `cancelled` | Withdrawn with the authority. | Nothing |
| `error` | A remote error outcome or an unmapped response status. Transport and configuration exceptions preserve the prior status and record `lastError`. | Read `lastError`, resolve the cause, then `POST …/{id}/submit` |

## 3. The three configuration failures, in the order they occur

| `lastError` contains | Cause | Fix |
|---|---|---|
| `has no e-invoice transmitter configured` | `company.einvoice_transmitter` is null — someone turned e-invoicing off after the document posted | `PUT /v1/companies/{id}/einvoice-settings`, then resubmit if pending/error/rejected |
| `not registered` | The company names a transmitter this deployment did not register. **Before OD-15 is discharged this is every `myinvois` company and it is expected** | Nothing until ADR 0051 lands (plan Task 9) |
| `EINVOICE_CLIENT_SECRET is not set` | `EINVOICE_CLIENT_SECRET` is not set in this environment | Set the Cloudflare secret binding; `containerSecrets()` already enumerates the name |

## 4. Cancelling

    POST /v1/companies/{companyId}/einvoice-transmissions/{id}/cancel
    { "reason": "<what the operator will tell the authority>" }

Legal only from `accepted`. The row is never deleted (spec:2049) — `status` becomes `cancelled` and
`cancelledAt` is stamped.

A refused or unconfirmed remote cancellation keeps `status=accepted`, its QR link and acceptance timestamp. Read `lastError` for the cancellation diagnostic; the claim is released so a corrected eligible attempt can run. Polling can also discover a cancellation made remotely and records `cancelledAt` in that case.

The public authority transport enforces a nonempty reason of at most 300 characters. Its published cancellation window is 72 hours after validation; the complete integration must verify that window and handle referencing documents or later corrections through appropriate notes. A local cancellation action alone does not prove remote eligibility.

## 5. What is never a fix

- Editing `app.einvoice_transmission` by hand. Every column is audited (test 13) and `app_rw` holds
  no DELETE on the table (§3.5.4).
- Re-posting the document. A document has one transmission — `unique (document_id)` — and a second
  post is a second document.
- Turning a gate off in code. The three gates are policy data and a company column; changing either
  is a seed PR or an API call.

## 6. Verification and authority receipts

`bun run --cwd packages/db einvoice:verify --profile synthetic` prints four structural checks. `--transmitter` remains an alias. OAuth profiles additionally need a public client identifier supplied through `--client-id` or the process environment `EINVOICE_CLIENT_ID`; the client secret remains in `EINVOICE_CLIENT_SECRET`. The verifier obtains a token and probes a deliberately nonexistent receipt. It detects authentication refusals and throttling; success proves connectivity/authentication, not invoice validity, legal mapping or signing.

For the synthetic stub's dynamically assigned port, append `--base-url http://127.0.0.1:<port>` while the stub is running and its local test credential is configured. This verification-only option accepts only an explicit loopback origin for the synthetic profile, refuses invalid/non-loopback URLs before credential lookup or HTTP, and leaves the committed profile and application registration untouched. It cannot override an authority host.

The MyInvois sandbox profile under `docs/owner/od-15/` is a draft and is deliberately not discoverable by this command. `--profile myinvois` continues to fail closed until Task 9's accepted integration exists.

An authority `externalId` is an opaque versioned reference containing both submission UID and document UUID. Keep it intact: polling uses the submission UID, cancellation uses the UUID. The accepted poll's redacted receipt supplies the long ID for its validation link. `request_sha256` hashes the encoded document bytes supplied to the authority envelope. A digest does not prove a certificate signature. Never retry an ambiguous live submission blindly; the complete authority integration must reconcile it under the verified duplicate policy before registration.
