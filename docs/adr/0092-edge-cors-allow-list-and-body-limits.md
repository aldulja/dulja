# ADR 0092 — The edge's CORS allow-list and request-body ceilings

**Status:** Proposed — 2026-11-15. Both decisions are security settings (spec:95), implemented ahead of approval as the review's fix for API-01 and API-11.
**Date:** 2026-11-15
**Deciders:** owner (pending)
**Branch:** `claude/fix-edge-cors-and-deploy` — not a slice; a fix from the 2026-11-15 full review (findings API-01, API-11; the same PR fixes OPS-02 = API-04, which needs no ADR). **Number allocated by the review's orchestrator.** **Migrations:** none.

## Context

`backoffice.exe` loads its renderer from the privileged `dulja://` scheme (`APP_ORIGIN = "dulja://app"`, `apps/desktop/src/window-options.ts`) and calls the API at a separate https host (`VITE_API_BASE_URL`). Every `/v1` call carries `Authorization`, and unsafe calls carry `Idempotency-Key`, so Chromium preflights every one. Nothing answered the preflight: the edge refused the `OPTIONS` 401 at its JWT pre-check (a preflight never carries a token), and the API has no CORS middleware (§4.2.3's chain is fixed and contains none, on the assumption that the back office is same-origin with the API — it is not). Every screen of the packaged back office failed. The e2e harness hid this by adding its own `cors()` in front of the API (API-01).

Separately, nothing bounded a request body. The rate limiter counts requests, not bytes; the API runs one instance whose idempotency layer reads and hashes every unsafe body; and `POST /v1/sync/enrol` is public. One caller could starve every tenant with large bodies (API-11).

## Decision

1. **The edge answers CORS, from an exact allow-list** (`apps/edge/src/cors.ts`). The list is one origin, `dulja://app`, compared as a string. Never `*`, never an echo of the request's `Origin`, never a pattern. Adding an origin is a code change reviewed against this ADR; no environment variable widens it.
2. **A preflight from that origin is answered first**, before the limiter and the JWT pre-check: `204`, `Access-Control-Allow-Origin: dulja://app`, `Allow-Methods: GET, POST, PUT, PATCH, DELETE`, `Allow-Headers: authorization, content-type, idempotency-key, traceparent` (exactly what the back office sends, plus the trace header), `Max-Age: 600`, `Vary: Origin`. It touches no container and no R2 and has no body, so it does not spend the caller's rate-limit bucket.
3. **Every response to that origin carries the grant** — forwarded responses and the edge's own 401/413/429 problems alike, so a screen can read the problem body — with `Access-Control-Expose-Headers: x-request-id` (`toApiError` reads it).
4. **No credentials mode.** `Access-Control-Allow-Credentials` is never sent: the back office authenticates with a bearer token, not a cookie.
5. **Any other origin gets no CORS header at all.** Its preflight takes the ordinary path (and is refused 401 by the pre-check), so the browser blocks it. A non-browser client never consults CORS and meets the same authentication as before; CORS is not an access control here, and the allow-list grants nothing the token does not.
6. **The API stays CORS-free.** The edge is the only ingress (the containers have no public route), so §4.2.3's chain is unchanged.
7. **The e2e harness runs the edge's `preflightResponse` and `withCors`** with its own one-origin list (the loopback page), not a CORS layer of its own, so a header the back office starts sending that the edge does not allow fails the e2e suite.
8. **Request bodies are bounded at the edge and again in the API**, per path:

   | Path | Ceiling | Why |
   |---|---|---|
   | every other `/v1` route | 1 MiB | JSON documents and lists |
   | `POST /v1/companies/{id}/attachments` | 27 MiB | `MAX_ATTACHMENT_BYTES` (25 MiB) plus multipart framing |
   | `POST /v1/companies/{id}/bank-statements` | 16 MiB | a `csv` of up to 4,000,000 characters, JSON-escaped and UTF-8 |
   | `/v1/sync/*` | 8 MiB | a push of up to 200 tickets (`SYNC_BATCH_SYNC_LIMIT`) |

   A declared `Content-Length` over the ceiling is refused without reading; a chunked body is counted as it streams. The refusal is a `413` problem with the new code `ERR_PAYLOAD_TOO_LARGE`. The edge table is `apps/edge/src/body-limit.ts`; the API's (`apps/api/src/middleware/body-limit.ts`, mounted on `/v1/*` before authentication and idempotency) is a copy kept equal by hand, each pinned by its own test. Applications may not import each other, and the API's copy is defence in depth only.

## Consequences

- The packaged back office can reach the API. Nothing else changes for the till: `pos.exe` calls the API from its main process, which is not subject to CORS.
- A developer running the back office from a Vite dev server against a deployed edge is refused by the browser; that is intended (decision 1).
- A new request header in the back office must be added to `CORS_ALLOW_HEADERS` in the same change, or every call that sends it fails in the packaged app and in e2e.
- The two body-limit tables can drift; a change to one must change the other. The ceilings do not replace `.max()` bounds on contract arrays (`lines`, sync batches), which the review also recommended and which belong to the contracts' owners.

## Owner questions

1. Is one origin (`dulja://app`) right for every environment, including staging, or should staging also admit a developer origin?
2. Are the four ceilings acceptable — in particular 1 MiB for every JSON route and 8 MiB for a sync push?
