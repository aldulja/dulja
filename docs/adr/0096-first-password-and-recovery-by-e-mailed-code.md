# ADR 0096 — First password and recovery by an e-mailed one-time code, inside the desktop app

**Status:** Proposed — security-relevant (the authentication flow), so it waits on the owner's approval (spec:95). Implemented ahead of approval, as the 2026-11-15 review's fix brief directs.
**Date:** 2026-11-16
**Deciders:** owner (pending)
**Branch:** `claude/fix-set-password` — not a slice; a review fix. Number allocated by the 2026-11-15 review's orchestrator. **Migrations:** none.
**Findings:** PRD-01 (blocker) and OPS-08, `docs/review/2026-11-15-full-review.md`.

## Context

Dulja never stores or checks a password (spec:2131, LEGACY-028); Supabase Auth does. But nothing in the product let anyone choose one. The seed creates the owner with no password (`packages/db/src/seed/auth-admin.ts`), `POST /v1/admin/users` invites with none (`apps/api/src/auth-admin.ts`), and the back office's sign-in screen offered e-mail and password only. Supabase's invite and recovery e-mails carry a link, which opens a browser at the project's Site URL; the back office runs at `dulja://app` inside `backoffice.exe`, which no link reaches, and nothing registers a protocol handler. So nobody could sign in without an engineer setting a password in the Supabase console.

Two ways out were weighed:

- **A deep link** (`dulja://` registered with Windows, invite and recovery sent with `redirectTo`). It needs a protocol handler in the installer and the main process, a single-instance hand-off of the URL to the running window, and the token travelling through the OS shell. It fails on a machine where the installer did not register the scheme, and it widens the desktop's attack surface (any page can invoke `dulja://`).
- **A one-time code typed into the app.** Supabase Auth already issues one with every recovery e-mail (`{{ .Token }}`), and `verifyOtp` accepts it. Nothing leaves the app, nothing new is installed, and the code is useful only together with the e-mail address it was sent to.

## Decision

1. The sign-in screen offers **"First time here, or forgot your password?"**. It is the standard set-password step of the sign-in flow, not a new workflow: the same screen, the same fields, the same hand-off.
2. The step calls `resetPasswordForEmail(email)` — never `signInWithOtp`, so a request can never create an account — with no `redirectTo`. It then calls `verifyOtp({ email, token, type: "recovery" })` and `updateUser({ password })`. One path serves the seeded owner, an invited user (GoTrue's recovery verification also confirms an unconfirmed invitee's address) and a forgotten password.
3. **No enumeration.** The screen says the same sentence ("If an account uses this address, a one-time code is on its way") whether or not the address has an account; GoTrue answers `/recover` with 200 either way. Rate-limit refusals (`over_email_send_rate_limit`, `over_request_rate_limit`, any 429) say "wait a minute"; every message is the catalogue's, never the provider's English (spec:2061).
4. **MFA is not weakened.** The recovery session is `aal1`, the level a password sign-in reaches. An account with no factor goes on to enrolment exactly as after a sign-in. An account with a verified TOTP factor must pass its challenge (to `aal2`) **before** the password changes: the screen asks for the six digits up front and does not rely on the provider for it; where GoTrue also refuses the change at `aal1` (`insufficient_aal`), the screen maps that refusal and asks for the factor. The e-mailed code proves the mailbox, never the second factor.
5. Backing out after the code step signs the recovery session out, so no half-finished session is left behind.
6. The API's invite path is unchanged: it still sends Supabase's invite e-mail, whose template the owner rewrites to point at this step (runbook below). Where the service-role key lives is not changed (OPS-01 is the owner's decision).
7. The dashboard settings this needs — e-mail provider and OTP length and expiry, custom SMTP, rate limits, the Reset Password template showing `{{ .Token }}`, the Invite template, the password policy — are go-live items in `docs/runbooks/supabase-provisioning.md` §7.

## Consequences

- Anyone with access to a user's mailbox can reach `aal1` for an account with **no** factor — the same power an invite link already gives, and the reason enrolment follows at once. For an enrolled account the mailbox alone gets nothing the API will answer (every route but `GET /v1/session` needs `aal2`, §4.2.3) and cannot change the password.
- GoTrue's per-address rate limit answers 429 for an address it holds and 200 for one it does not, which a determined caller could use to probe for accounts. That is the provider's behaviour, not this screen's; the screen adds no tell of its own.
- The code expires (runbook: 15 minutes) and is single-use; a new request replaces it.
- Verified locally against the e2e auth stub only (`tests/e2e/set-password.spec.ts`, keyboard-only, EN/LTR and AR/RTL) and against fakes in `apps/backoffice/test/set-password.test.tsx`. Real Supabase behaviour — that `/recover` reaches an unconfirmed invitee and that the template shows the code — is verified on staging (OD-19/OD-21), as the runbook's last step says.

## Owner questions

1. Approve the code-in-app path over a `dulja://` deep link?
2. Approve the recommended settings: 6-digit code, 15-minute expiry, 60-second per-address interval, 12-character minimum password?
