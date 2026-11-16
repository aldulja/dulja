import { bodyLimitFor, declaredLength, limitStream } from "./body-limit";
import { preflightResponse, withCors } from "./cors";
import type { Env } from "./env";
import { precheckJwt } from "./jwt-precheck";
import { edgeLog } from "./log";
import { applyRateLimit, networkOriginKey } from "./rate-limit";
import { serveUpdate } from "./updates";

export interface RouterDeps {
  forward(request: Request): Promise<Response>;
  ping(): Promise<Response>;
}
const strippedHeaders = [
  "x-tenant-id",
  "x-actor-id",
  "x-principal-id",
  "x-forwarded-authorization",
];
/**
 * The till's surface (contracts §4.10.3), which carries no Supabase session: `POST /v1/sync/enrol` is public,
 * and every other `/v1/sync/*` call is Ed25519-signed with `X-Terminal-*` headers or carries a terminal JWT whose
 * issuer is `urn:dulja:terminal`. The Supabase pre-check below would refuse all three, so a deployed till could
 * neither enrol nor sync. The API's `terminalAuth` authenticates these calls in full; the edge still rate-limits
 * them, which is all §4.10.3 asks of it ("public; rate-limited at the edge"). The pre-check is a load filter, not
 * the control: a path that slips past it here still meets the API's own authentication (PR 12 review).
 */
const TERMINAL_SURFACE = "/v1/sync/";
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const ZERO_TRACE = /^00-(0{32}-[0-9a-f]{16}|[0-9a-f]{32}-0{16})-/;
const hex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const PROBLEM_TEXT: Record<number, { readonly title: string; readonly remedy: string }> = {
  401: { title: "Unauthorized", remedy: "Sign in again and retry with a current token." },
  413: {
    title: "Payload Too Large",
    remedy: "Send a smaller request body; the limit for this path is in the detail.",
  },
  429: { title: "Too Many Requests", remedy: "Wait for the RateLimit-Reset window and retry." },
};
function problem(
  status: 401 | 413 | 429,
  code: string,
  detail: string,
  instance: string,
  requestId: string,
  headers: Record<string, string>,
): Response {
  const { title, remedy } = PROBLEM_TEXT[status] ?? { title: "Error", remedy: "" };
  return Response.json(
    { type: `urn:dulja:error:${code}`, title, status, detail, instance, code, remedy, requestId },
    {
      status,
      headers: {
        ...headers,
        "Content-Type": "application/problem+json",
        "X-Request-Id": requestId,
      },
    },
  );
}

/**
 * Re-heads a response the limiter already gated with its `RateLimit-*` values. spec:2204 makes those headers
 * part of what a rate limit *is* here, and the two branches that answer without touching a container —
 * `/updates/*` and the 404 — now spend the bucket, so they owe the caller the same report the forwarded and
 * refused paths already give. `serveUpdate` sets `Cache-Control: public, max-age=60`, so a cached feed
 * response freezes these headers for a minute; tolerable only because `RateLimit-Remaining` is synthetic
 * ("1"/"0") rather than a live count — the binding reports no remainder to pass through.
 */
function withRateHeaders(response: Response, rate: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(rate)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The edge's entry point. A CORS preflight from the allow-listed back-office origin is answered first — before
 * the limiter and the JWT pre-check, which would otherwise refuse it 401 for carrying no token (a preflight
 * never does) — and every response to that origin carries the grant (API-01, ADR 0092; apps/edge/src/cors.ts).
 * The preflight answer is a constant 204 with no body that touches no container and no R2, so it does not
 * spend the caller's bucket.
 */
export async function handleFetch(request: Request, env: Env, deps: RouterDeps): Promise<Response> {
  return preflightResponse(request) ?? withCors(await route(request, env, deps), request);
}

async function route(request: Request, env: Env, deps: RouterDeps): Promise<Response> {
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();
  // A caller's traceparent continues its trace into the container and Postgres (spec:2245) only when it is a
  // well-formed W3C header with a non-zero trace id and parent id; anything else is replaced, so the value
  // the logs carry as `trace_id` is always a trace id and never free text.
  const offered = request.headers.get("traceparent");
  const traceparent =
    offered !== null && TRACEPARENT.test(offered) && !ZERO_TRACE.test(offered)
      ? offered
      : `00-${hex(16)}-${hex(8)}-01`;
  // Before every route branch, including `/updates/*`: the feed used to return above the limiter, which
  // left an unauthenticated R2 read with no ceiling — egress amplification for anyone who found the path.
  // The key is network origin only; `networkOriginKey` says why identity is not available here.
  const rate = await applyRateLimit(env.RATE_LIMIT, networkOriginKey(request));
  if (!rate.allowed)
    return problem(
      429,
      "ERR_RATE_LIMITED",
      "Too many requests from this client.",
      url.pathname,
      requestId,
      rate.headers,
    );

  if (url.pathname.startsWith("/updates/"))
    return withRateHeaders(await serveUpdate(env.UPDATE_FEED, url.pathname), rate.headers);
  const isApi = url.pathname.startsWith("/v1/");
  const isHealth = url.pathname === "/healthz";
  if (!isApi && !isHealth) return new Response("not found", { status: 404, headers: rate.headers });

  // API-11 — a body is bounded before anything reads it: a declared length over the path's ceiling is refused
  // here, and an undeclared (chunked) one is counted as it streams to the container (apps/edge/src/body-limit.ts).
  const bodyLimit = bodyLimitFor(url.pathname);
  const tooLarge = () =>
    problem(
      413,
      "ERR_PAYLOAD_TOO_LARGE",
      `The request body exceeds this path's limit of ${bodyLimit} bytes.`,
      url.pathname,
      requestId,
      rate.headers,
    );
  const declared = declaredLength(request);
  if (declared !== null && declared > bodyLimit) return tooLarge();

  if (isApi && !url.pathname.startsWith(TERMINAL_SURFACE)) {
    const authorization = request.headers.get("Authorization");
    const precheck = precheckJwt(authorization, env.SUPABASE_JWT_ISSUER);
    if (!precheck.ok) {
      edgeLog(
        {
          request_id: requestId,
          trace_id: traceparent.split("-")[1] ?? "",
          path: url.pathname,
          reason: precheck.reason,
        },
        "edge precheck refused",
      );
      return problem(
        401,
        "ERR_AUTH_TOKEN_INVALID",
        `The bearer token is ${precheck.reason}.`,
        url.pathname,
        requestId,
        rate.headers,
      );
    }
  }
  const headers = new Headers(request.headers);
  for (const header of strippedHeaders) headers.delete(header);
  headers.set("X-Request-Id", requestId);
  headers.set("traceparent", traceparent);
  const limited =
    request.body !== null && declared === null ? limitStream(request.body, bodyLimit) : null;
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body: limited?.body ?? request.body,
    redirect: request.redirect,
    // A stream body needs `duplex: "half"` under Node's fetch (the suite); a Worker ignores the member.
    ...(request.body === null ? {} : { duplex: "half" }),
  } as RequestInit);
  let response: Response;
  try {
    response = await deps.forward(forwarded);
  } catch (error) {
    if (limited?.exceeded()) return tooLarge();
    throw error;
  }
  if (limited?.exceeded()) return tooLarge();
  const responseHeaders = new Headers(response.headers);
  for (const [name, value] of Object.entries(rate.headers)) responseHeaders.set(name, value);
  responseHeaders.set("X-Request-Id", requestId);
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

export async function handleScheduled(_env: Env, deps: RouterDeps): Promise<void> {
  const response = await deps.ping();
  edgeLog({ status: response.status, container: "worker" }, "cron ping");
}
