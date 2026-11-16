# ADR-0005 — Verified JWT identity chain

**Status:** accepted · **Date:** 2026-09-14 · **Slice:** 0B

The API verifies signature, issuer, expiry, subject and AAL using `jose`, then resolves the subject through the restricted `app.resolve_principal` function. Tenant and actor headers are ignored. Only `/v1/session` accepts `aal1`; all other `/v1` routes require `aal2`. The complete JWKS URL and issuer are deployment configuration, not assembled in source.

The hosted Supabase defaults verified on 2026-09-14 are:

- issuer: `https://<project-ref>.supabase.co/auth/v1`;
- JWKS: `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`;
- admin invite: `POST /auth/v1/invite`, with the invited user's returned `id` used as the principal subject.

References: [Supabase JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys), [Supabase JWT fields](https://supabase.com/docs/guides/auth/jwts), and the [GoTrue invite endpoint source](https://github.com/supabase/auth/blob/master/internal/api/invite.go).

The application depends on an `AuthAdmin` port. Tests and local development use the deterministic stub. `SupabaseAuthAdmin` is available for deployment, but whether a service-role credential is injected into the API container remains the Phase 0C topology decision in ADR-0011.
