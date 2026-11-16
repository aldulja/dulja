# 0051 — Verified LHDN MyInvois requirements

**Status:** Proposed; partial public-document verification recorded below. Company applicability, a complete mapping and acceptance remain pending OD-15.

Phase 5 implements the transmitter port and exercises it using a loopback synthetic profile. The public MyInvois transport protocol is also implemented for review, with a sandbox profile draft outside the deployed profile directory. No authority mapper, signer or production registration is supplied. The draft and transport are derived from the publications below; company applicability and the complete statutory integration remain pending.

Before adding an authority adapter, the owner and engineer must record the published source URL, title and retrieval date for each requirement, then accept this ADR. The verified record must cover:

- Taxpayer scope, thresholds and effective dates.
- Schema version, identifiers, mandatory and conditional fields, and mapping to immutable document snapshots.
- Submit, poll and cancel methods, paths, authentication and response fields.
- Remote statuses and their mapping to the internal state machine.
- Covered document types, enabled through a versioned posting-policy seed change.
- QR payload and validation URL format.
- Sandbox and production differences, credentials, and unresolved questions.

Unknown values remain absent. Settings default to disabled and unavailable transmitters fail before network access. Proposed ADRs 0052 and 0053 describe the implemented generic transport and retry behavior; neither supplies authority requirements.

## Public SDK evidence — retrieved 2026-10-02

The engineer retrieved the current LHDNM SDK pages directly using Firecrawl with `maxAge: 0`. All ten pages below returned HTTP 200. Full-page Markdown was retrieved; transport field tables, version notes, signature requirements and FAQ passages were reviewed. The table records excerpts and implications, not a complete statutory mapping or an accepted deployment requirement set. No authenticated authority API was called. Company scope, filing requirements, credentials and certificate ownership cannot be established from public SDK pages.

| Official publication | Retrieved facts |
|---|---|
| [Getting started](https://sdk.myinvois.hasil.gov.my/start/) | Integration uses externalised identity and asynchronous document validation; taxpayer digital profiles must be established. |
| [Login as Taxpayer System](https://sdk.myinvois.hasil.gov.my/api/07-login-as-taxpayer-system/) | OAuth 2.0 client credentials; `POST /connect/token`, `client_id`, `client_secret`, `grant_type=client_credentials`; scope optional. Response has `access_token`, `token_type`, `expires_in`. The page says tokens last one hour and should be reused rather than requested for each operation. |
| [Submit Documents](https://sdk.myinvois.hasil.gov.my/einvoicingapi/02-submit-documents/) | `POST /api/v1.0/documentsubmissions/`; `documents[]` contains `format`, base64 `document`, `documentHash`, `codeNumber`; document follows UBL 2.1 for the selected type/version. HTTP 202 returns `submissionUID`, `acceptedDocuments[]` and `rejectedDocuments[]`. Initial acceptance only passes synchronous validation; it is not the final valid state. Accepted rows carry `uuid` and `invoiceCodeNumber`. Limits: 100 documents, 5 MB per submission, 300 KB per document. Duplicate submissions return 422 and a `Retry-After` header. |
| [Get Submission](https://sdk.myinvois.hasil.gov.my/einvoicingapi/06-get-submission/) | `GET /api/v1.0/documentsubmissions/{submissionUid}?pageNo={pageNo}&pageSize={pageSize}`; paginated document summaries, `overallStatus` and per-document `status`. `submissionUid` and document `uuid` are distinct identifiers. `longId` is returned only for valid documents. |
| [Get Document Details](https://sdk.myinvois.hasil.gov.my/einvoicingapi/08-get-document-details/) | `GET /api/v1.0/documents/{uuid}/details`; `uuid`, `submissionUid`, `longId`, `status`, validation results. Document states are `Submitted`, `Valid`, `Invalid`, `Cancelled`. Proposed mapping: submitted, accepted, rejected, cancelled respectively; unknown states remain diagnostic failures. |
| [Cancel Document](https://sdk.myinvois.hasil.gov.my/einvoicingapi/03-cancel-document/) | `PUT /api/v1.0/documents/state/{UUID}/state` with body `status=cancelled` and `reason` (up to 300 characters). Cancellation is permitted within 72 hours after validation. Outside that window, adjustments use credit/debit/refund notes. Referencing documents can prevent cancellation. |
| [Invoice v1.1](https://sdk.myinvois.hasil.gov.my/documents/invoice-v1-1/) | Version 1.1 maintains the 1.0 structure with signature validation enabled. Mandatory/conditional supplier, buyer, identification, address, classification, totals and exchange-rate fields require an explicit mapping. No taxpayer identifiers or classification values can be inferred from local UUIDs or account codes. |
| [Signature](https://sdk.myinvois.hasil.gov.my/signature/) | Certificate ownership/validity, X.509 public certificate, RSA signature and XAdES signed properties matter to validation. A payload SHA-256 is not a digital signature. Certificate/private-key custody and the signature-creation algorithm still require a reviewed implementation. |
| [Integration Practices](https://sdk.myinvois.hasil.gov.my/integration-practices/) | Reuse access tokens, avoid duplicate submissions, poll submission status instead of re-submitting, respect throttling and use exponential backoff. The current worker's local retry budget does not establish compliance with these authority requirements. |
| [FAQ](https://sdk.myinvois.hasil.gov.my/faq/) | Production portal: `myinvois.hasil.gov.my`; production system API and identity: `api.myinvois.hasil.gov.my`. Sandbox portal: `preprod.myinvois.hasil.gov.my`; sandbox system API and identity: `preprod-api.myinvois.hasil.gov.my`. Production credentials cannot be used in sandbox. Validation link: `{envbaseurl}/uuid-of-document/share/longid`, using the **portal** base URL. Both document UUID and long ID are required. Version 1.0 remains available without signature validation until an official retirement notice; version 1.1 is recommended. A current retirement notice was not separately verified. |

The getting-started overview describes signed documents generally; the FAQ explicitly distinguishes 1.0 and 1.1 signature validation. Do not collapse those statements into a blanket version mandate or select a company’s version without its confirmed requirements.

## Reconciliation identified from public evidence

The original synthetic HTTP profile was insufficient to express this protocol. The following discrepancies were identified before adding the public transport:

1. `EInvoiceAuthSpec` supports a bearer secret only. A company client secret must instead obtain an expiring access token, cached per environment/client with single-flight refresh and redaction of both secrets and tokens.
2. `createHttpTransmitter` serializes the internal document object. Submission needs the authority document bytes, their digest and a base64 envelope. Certificate-backed signing for 1.1 is a separate operation. The signed submission bytes must be stable on retries.
3. One status pointer cannot select a matching document from accepted/rejected submission arrays or distinguish asynchronous acceptance from final validity. The adapter must correlate the document code, persist its UUID/receipt metadata, and reconcile status without blind re-submission after an ambiguous response.
4. The frozen QR port accepts only `{ externalId }`; the published link also requires `longId`. Poll returns `raw`, but credentials are redacted before storage and the present QR builder receives no receipt metadata. A reviewed additive receipt contract and durable handling are needed; a process-local map would lose data after restart.
5. The generic cancellation body is `{ externalId, reason }`; the authority expects its own state body. The adapter needs explicit encoding and the published cancellation window and failure semantics.
6. Immutable snapshots currently lack several legal identities, addresses and classification inputs. Record where each required field is captured, validated and frozen before submission. Current company/party UUIDs are not authority identifiers. Determine direct-taxpayer versus intermediary login, covered document types, consolidated/self-billed requirements and the effective date from the owner’s scope.

These are concrete discrepancies between retrieved documentation and the shipped contract, not inferred API details. ADRs 0052/0053 and Plan Contracts §4.9.3 require a corresponding reviewed amendment before an authority implementation is registered. The accepted-ADR production-profile guard remains intact.

## Public transport implemented for review — 2026-10-02

The additive contract amendments are recorded in Plan Contracts and proposed ADRs 0052/0053. `authorization.ts` implements client-credentials token acquisition, reuse, expiry, rotation-aware single-flight acquisition and one bounded refresh after HTTP 401. It keeps tokens in process memory and redacts both tokens and secrets. The existing bearer profile remains supported.

`myinvois.ts` encodes one document per submission, hashes the exact encoded UTF-8 bytes, base64-encodes those bytes and checks the published per-document limit before network access. Submission acceptance remains `submitted`; it matches the document code in accepted/rejected arrays. A versioned opaque receipt in the existing external-ID column retains both submission UID and document UUID across restarts. Polling matches the UUID, cancellation uses the UUID and published state body, and the validation link requires a matching valid receipt with a long ID. QR builders receive the individual redacted response through an optional additive receipt field. HTTP authentication refusals cannot produce successful states.

`docs/owner/od-15/myinvois-sandbox-profile.draft.json` records the published sandbox transport as review data. It is **outside** `packages/db/einvoice-profiles`, is not loaded by the CLI and is not registered by application startup. No request has been sent to an authenticated authority API. Loopback protocol fixtures contain a minimal transport specimen, not a complete valid statutory invoice.

This resolves the transport seams in items 1–5 for review, but does not complete their operational requirements. The caller must still supply a reviewed immutable legal-field mapper and an encoder for the selected document type/version. Version 1.1 certificate custody and signing, stable signed bytes across retries, duplicate/ambiguous-submission recovery, authority throttling/backoff and cancellation-window behavior need their company-specific implementation and sandbox proof. Item 6 remains open. Registration stays disabled until those requirements and this ADR are accepted.

## Remaining OD-15 evidence

The owner must identify the company, confirm MyInvois in-scope status/start date, select sandbox/production and direct/intermediary registration, and provide the applicable tax-return regime/filing periods. Credentials and signing material belong in environment/secret bindings, never this document or chat. The tax-return publication is a separate requirement from MyInvois document submission.

After the complete requirement set and contract reconciliation are reviewed, acceptance enables the production profile/mapping, sandbox verification and deployment checks. Public documentation retrieval alone does not discharge these gates.
