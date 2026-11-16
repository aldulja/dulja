# 0052 — The e-invoice transmitter is a port and its remote shape is a profile

- Status: **proposed** (spec:95 — this touches the data model and an integration's security posture; do not merge the implementation before this is accepted)
- Date: 2026-10-02
- Slice: 5B

## Context

§4.9.3 freezes `EInvoiceTransmitter` — `canonicalise`, `qrPayload`, `submit`, `poll`, `cancel` —
and says in its own heading that "no LHDN endpoint, field, version or threshold appears in this
document or in any plan until ADR 0051 records them from the authority's current documentation".
spec:2226 and Part VII #3 (spec:2467) say the same twice more, and add: "do not rely on this
document or on training data".

That leaves a writing problem. A slice must ship an adapter, tests that run in CI, and a
transmission log whose state machine is exercised — before anyone has read the authority's
documentation. Two shapes were considered.

**Shape A — constants marked "per ADR 0051".** One TypeScript module with `const SUBMIT_PATH =
"<per ADR 0051>"` and a runtime throw. Every test is skipped until OD-15 lands, the state machine
is unexercised, the transmission log's retry and reconciliation are unproven, and Phase 5 closes
on a promise. It is also the placeholder pattern the plan discipline forbids outright.

**Shape B — the remote shape is data.** This is what Phase 8 already does with statutory rates:
spec:2229 says "no rate lives in code, and a rate change is a seed PR, not a release", and
§4.12.3 gives the rate table a JSON Schema and a version. The e-invoicing problem is the same
problem — a value the authority owns, which changes on the authority's schedule, and which nobody
on this team may guess.

## Decision

**The transmitter is a port; its remote shape is a versioned profile file validated against a
committed JSON Schema.**

1. `packages/domain/src/tax/einvoice.ts` holds §4.9.3's five declarations verbatim, plus
   `canonicalJson`, `EInvoiceProfile`, `EInvoiceCallSpec`, `EInvoiceAuthSpec` and
   `TRANSMISSION_STATUSES`. It is pure: no I/O, no `fetch`, no `node:` import.
2. `packages/domain/einvoice-profile.schema.json` says what a profile is: a base URL, one auth
   block, and exactly three call specs (`submit`, `poll`, `cancel`), each a method, a path
   template, a JSON Pointer to the status in the response, and a `statusMap` onto the six
   `TransmissionStatus` labels. **Nothing speculative is in the schema** — no pagination, no
   webhooks, no batching, no body templating.
3. A profile file lives at `packages/db/einvoice-profiles/<code>.v<n>.json`, **outside
   `packages/db/seed/`** (2C made `assertPackShape` derive its allowed directories from
   `SUB_PACKS`, so an unregistered directory under `seed/my/` makes `bun run seed` exit 3).
4. `createHttpTransmitter({ profile, canonicalise, qrPayload, fetchImpl? })` turns any conforming
   profile into an `EInvoiceTransmitter`.
5. **`canonicalise` and `qrPayload` are constructor parameters, not profile data.** Their content
   is prose in the authority's documentation, not a call shape; expressing them as a body-
   templating language would be over-building, and the judge panel's standing objection to
   over-building applies.
6. Two transmitter codes exist and the vocabulary is closed: `synthetic` (loopback only,
   registered when `appEnv !== "production"`) and `myinvois` (registered only by the OD-15 task,
   from ADR 0051).

## Consequences

- Every task of slice 5B ships running, CI-green code before OD-15 lands, and the transmission
  log's state machine, the retry, the reconciliation poll, the route module and step 14's three
  gates are all exercised against the synthetic profile.
- Discharging OD-15 is **one reviewed JSON file plus two functions**, not a rewrite. ADR 0051 is
  the file's `source`, and `scripts/check/no-authority-literals.sh` fails the build if the file
  exists without it.
- An authority's schema-version bump is `myinvois.v2.json` beside `v1`, with
  `einvoice_transmission.profile_version` recording which file each call was made with — SAH-013's
  "pinned versions" applied to an integration.
- A profile cannot express an authority that needs request signing, mutual TLS or a multi-step
  handshake. If ADR 0051 finds one, **the OD-15 task widens the schema's `auth` block and this
  ADR is superseded rather than stretched** — that widening is an explicit step of that task.
- The synthetic transmitter can produce fake acceptances, so it is refused in production twice:
  it is not registered when `appEnv === "production"`, and the settings route refuses the value.
  **Amended 2026-10-07 (PR 11 review, proposed):** both entrypoints now read `APP_ENV` the same way —
  unset is `dev`, and anything outside `dev | staging | production` stops the process (the API's
  `readConfig`; the worker's `parseAppEnv` in `apps/worker/src/app-env.ts`, which writes the refusal to
  stderr and exits 2 before any handler or transmitter is registered). Until then the worker mapped any
  other value, a misspelt `prod` included, to `dev` and registered the synthetic transmitter. The worker's
  telemetry and Sentry take the validated value too.

## Public-protocol amendment — implementation for review, 2026-10-02

ADR 0051's retrieved SDK proves the bearer-only assumption insufficient. The owner has instructed completion of Phase 5. The profile schema now explicitly adds OAuth client credentials with token URL and optional scope; the HTTP adapter obtains, reuses, expires and refreshes process-only access tokens. Generic protocol codecs provide request/outcome functions for asynchronous envelopes, without adding a body-template language. Existing bearer/synthetic behavior is preserved. MyInvois transport receives an explicit immutable canonicaliser and document encoder; it cannot substitute synthetic snapshots for missing legal data or signing.

This supersedes the bearer-only limitation in this proposed ADR. It does not assert acceptance of the incomplete statutory requirement set or authorize production registration. The authority profile draft is reviewable outside the deployed profile directory.
