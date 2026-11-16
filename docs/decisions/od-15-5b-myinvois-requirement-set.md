# OD-15 — LHDN MyInvois credentials and the current requirement set

**Status:** live statutory integration pending; plan-default implementation selected by the owner on 2026-10-02. **Spec:** spec:92, 982, 2226, 2405, 2467;
Part VII #3. **Gated slice:** 5B, Task 9 only.

## The row, verbatim (spec:2405)

> | Phase 5 | LHDN MyInvois credentials and the current requirement set (§4.7) |

## What was assumed, and where each assumption lives

Nothing about MyInvois was assumed. The default §2.12 records is "abstract interface only", and that
is implemented for review: `EInvoiceTransmitter` (§4.9.3) is implemented by `createHttpTransmitter` over a
profile, and the only deployed profile is `synthetic.v1.json`, which points at loopback.
`registerDefaultTransmitters` registers `synthetic` when `APP_ENV !== "production"` and registers
`myinvois` only when this task has run.

## What a company configured for `myinvois` experiences until then

Its posted documents of opted-in types get an `einvoice_transmission` row at `pending`; the job
raises `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE`, writes it to `last_error`, and leaves the row pending.
Nothing is lost and nothing is sent anywhere. `docs/runbooks/einvoice-transmission.md` §3 says so.

## If the answer is "not in scope yet"

Nothing changes. Leave `company.einvoice_transmitter` null on every company; the three gates are off
and no transmission row is ever written. Revisit when the phase-in reaches the company.

## Owner-directed plan-default completion — 2026-10-02

The owner instructed the engineer to use the Phase 5 plan and choose best-practice defaults for missing inputs. The plan explicitly allows dropping the live authority task while all interfaces, tests and synthetic transport remain complete. The selected configuration keeps company e-invoicing disabled by default, registers synthetic transport only outside production and preserves the fail-closed authority path. This selection does not assert that any company is exempt or out of scope. OD-15 remains pending for live statutory integration and does not block completion of the chosen local implementation scope.

## If the answer is "in scope, here are the credentials"

Task 9 runs: ADR 0051 first, then the profile, then the two functions, then the registration branch.

## Public-document retrieval — 2026-10-02

Official SDK pages were retrieved and transport/version/QR evidence was recorded in ADR 0051. The reviewed-work implementation now contains OAuth acquisition/reuse, submission encoding and exact-byte hashing, receipt correlation, status decoding, cancellation encoding and validation-link construction. The additive contract reconciliation remains proposed. A sandbox transport profile draft is kept under `docs/owner/od-15/`, outside the deployed profile directory. Company applicability, credentials, complete immutable field mappings, version/signing requirements and live sandbox proof remain unprovided. No authority profile has been registered and the accepted-ADR guard has not been relaxed.
