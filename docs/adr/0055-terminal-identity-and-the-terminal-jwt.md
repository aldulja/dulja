# ADR 0055 — Terminal identity, one-time enrolment and the terminal JWT

- Status: **Proposed** (security, data-model or sync-protocol decisions require owner approval before implementation)
- Date: 2026-10-07
- Slice: 6A
- Source: [2026-09-05-dulja-phase-6a-sync-protocol-terminal-identity.md](../superpowers/plans/2026-09-05-dulja-phase-6a-sync-protocol-terminal-identity.md)
- Formal ADR acceptance: pending. Implementation of the presented Phase 6 defaults is authorized by the renewed whole-phase instruction; see the decision bundle.

## Context

LEGACY-025 (`procQuickLogin`) derives identity from stored credentials; LEGACY-026 trusts client-writable session context. LEGACY-046 requires one canonical name for each operation-mode concept and a single place to check it. A till must have an auditable identity independent of the human cashier and a device credential that can be revoked without changing that cashier's account (spec:1322).

## Decision

1. A terminal owns a `principal` of kind `terminal`, supplying a real audit identity. The terminal acts; a payload's cashier id is attribution and never supplies the authenticated actor.
2. Enrolment redeems an expiring, one-time hashed code exactly once and registers the device's Ed25519 public key at redemption.
3. Every `/v1/sync/*` call is either signed by that key or carries a short-lived JWT minted from a signed call. Signature verification uses the canonical signed-request form and a ±300-second clock window.
4. The JWT uses HS256 with `TERMINAL_JWT_SIGNING_KEY`, a §3.11 secret. Signer and verifier are the same service; an asymmetric JWT signing key would add a rotation story without a third-party verifier.
5. `pos_terminal.revoked_at` revokes device access independently of human users. Its principal is restricted to the terminal's branch and the `pos_terminal` role's two sync permission codes.
6. Successful enrolment-code issuance is a one-time secret response. It returns plaintext once and atomically records a safe 409 `ERR_IDEMPOTENCY_KEY_REUSED` replay problem, rather than persisting the 201 body in `app.idempotency_key`. `ONE_SHOT_SECRET_RESPONSES` registers only this operation; ordinary in-flight/hash/reclaim controls and the request-spanning transaction remain in force. Failed responses retain their normal cache behavior.
7. A signed request is spent once. The API records the sha256 of each verified canonical message per terminal in `app.terminal_request_guard` and refuses the same message again inside the clock window with `ERR_TERMINAL_SIGNATURE_INVALID`, minting no token; entries older than twice the window are pruned on the next write. No ordering of timestamps is required, so the till's concurrent catalogue and ticket loops are unaffected. (PR 12 review amendment, below.)

## Consequences

- Every environment needs the signing secret under the §3.11 secret policy.
- A terminal clock outside the ±300-second window fails authentication with a diagnostic that names the skew.
- A stolen device key can sell until revoked. Its authority remains bounded to that terminal and branch and the two terminal sync codes; cashier attribution cannot widen those bounds.
- Enrolment and revocation must be audited under the authenticated actor and tested for one-time redemption, expiry and revoked access.
- A lost issuance response cannot be recovered from an idempotency cache. Retrying returns a safe conflict; the operator issues a fresh enrolment with a fresh terminal code. This preserves hash-only storage and prevents a replay from revealing the secret after management authority is removed.

## What we are asking

Approve terminal principals, expiring one-time hashed enrolment, Ed25519 device signatures, same-service HS256 short-lived JWTs and independent revocation with the stated branch and permission bounds?

## Issuance replay correction — 2026-10-07

Review of the first implementation found that ordinary response caching persisted the plaintext code despite the hash-only table design. Decision 6 and Plan Contracts §4.2.9 specify the concrete correction before runtime changes: retain the atomic transaction, persist only a safe replay problem, and prove that neither the plaintext nor a recoverable code is stored. This is an implementation correction within the authorized enrolment design; the ADR remains Proposed for formal review.

## PR 12 review amendment — 2026-10-22

A proposal implemented ahead of approval, like the rest of this ADR.

- **Replay (decision 7).** A captured signed request verified for the whole ±300-second window and bought a fresh 15-minute JWT on every replay. Migration 0060 adds `app.terminal_request_guard`: one row per terminal, holding `{ sha256(canonical message): X-Terminal-Timestamp }`, written by one upsert whose row lock makes two copies of one message race-free. It is one row rather than one row per request because `app_rw` may delete from no table outside contracts §3.5.4's pinned five; it is `AUDIT_EXEMPT`, like `idempotency_key`, because it is per-request transport state. Contracts §3.5.3 and §4.6.1 carry its rows, and §4.10.3 the rule, each marked as part of this proposal. The canonical string signs the method, the path without its query, the body hash and a millisecond timestamp, so two genuinely different requests that agreed on all four would be one message to the guard. The till therefore signs with a strictly increasing millisecond across every request it makes (`signingInstant` in `apps/pos/src/main/transport.ts`), and its own requests never collide; the wire format is unchanged.
- **Terminal-code reservation (decision 2).** `unique (company_id, terminal_code)` covered expired, never-redeemed enrolments, and an enrolment cannot be deleted, so a code nobody redeemed reserved its terminal code for ever. Migration 0060 replaces it with an exclusion: a code is held over `[created_at, expires_at)` by a live enrolment and for ever by a redeemed one, and two holdings may not overlap. A re-issue after an unredeemed code expired succeeds; one while a code is live, or after a till enrolled with it, is `ERR_CONFLICT_UNIQUE` (409), as before. Contracts §4.10.3's sketch is restated to match, and §4.2.9's lost-response sentence now says the code is reserved until that enrolment expires.
