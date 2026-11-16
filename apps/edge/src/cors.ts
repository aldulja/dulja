/**
 * CORS for the back office (API-01, ADR 0092). `backoffice.exe` loads its renderer from the privileged
 * `dulja://` scheme (`APP_ORIGIN` in apps/desktop/src/window-options.ts), so every `/v1` call it makes is
 * cross-origin to the API's https host, and — carrying `Authorization`, plus `Idempotency-Key` on unsafe
 * methods — preflighted. Neither the API (§4.2.3's chain has no CORS) nor the JWT pre-check answers an
 * `OPTIONS` with a grant, so the edge does, before the pre-check.
 *
 * The allow-list is EXACT: one origin, compared as a string. Never `*`, never an echo of whatever `Origin`
 * arrived, never a pattern. No `Access-Control-Allow-Credentials`: the back office sends a bearer token, not a
 * cookie. A caller from any other origin gets no CORS header at all, so the browser blocks it; a non-browser
 * client never consults CORS and meets the same authentication as before. Adding an origin is a code change
 * reviewed against ADR 0092.
 *
 * `tests/e2e/support/boot.ts` runs these same functions with its own one-origin list (the harness serves the
 * built renderer from a loopback http origin), so the e2e suite exercises this code rather than its own CORS.
 */
export const BACKOFFICE_ORIGIN = "dulja://app";
export const EDGE_ALLOWED_ORIGINS: readonly string[] = [BACKOFFICE_ORIGIN];
export const CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE";
/** Exactly the request headers the back office sets (apps/backoffice/src/lib/admin-api.ts) plus traceparent. */
export const CORS_ALLOW_HEADERS = "authorization, content-type, idempotency-key, traceparent";
/** `toApiError` reads `x-request-id` off a response whose body is not a problem envelope. */
export const CORS_EXPOSE_HEADERS = "x-request-id";
/** Chromium caps this at 7200; ten minutes keeps a changed allow-list from lingering in a cache for long. */
export const CORS_MAX_AGE = "600";

/** The request's `Origin` when it is on the list, else null. */
export function allowedOrigin(
  request: Request,
  allowed: readonly string[] = EDGE_ALLOWED_ORIGINS,
): string | null {
  const origin = request.headers.get("Origin");
  return origin !== null && allowed.includes(origin) ? origin : null;
}

function vary(headers: Headers): void {
  const current = headers.get("Vary");
  if (current === null) headers.set("Vary", "Origin");
  else if (!/(^|,)\s*origin\s*(,|$)/i.test(current)) headers.set("Vary", `${current}, Origin`);
}

/**
 * A 204 answering a CORS preflight from an allowed origin; null for anything else — a request that is not a
 * preflight, or a preflight from an origin not on the list (which then takes the ordinary path and is refused
 * without a grant).
 */
export function preflightResponse(
  request: Request,
  allowed: readonly string[] = EDGE_ALLOWED_ORIGINS,
): Response | null {
  if (request.method !== "OPTIONS" || !request.headers.has("Access-Control-Request-Method"))
    return null;
  const origin = allowedOrigin(request, allowed);
  if (origin === null) return null;
  const headers = new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Max-Age": CORS_MAX_AGE,
  });
  vary(headers);
  return new Response(null, { status: 204, headers });
}

/** Adds the grant to an actual response for an allowed origin; any other origin's response is returned as is. */
export function withCors(
  response: Response,
  request: Request,
  allowed: readonly string[] = EDGE_ALLOWED_ORIGINS,
): Response {
  const origin = allowedOrigin(request, allowed);
  if (origin === null) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
  vary(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
