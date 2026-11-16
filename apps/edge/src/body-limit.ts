/**
 * Request-body ceilings (API-11, ADR 0092). The rate limiter counts requests, not bytes, and the API runs one
 * instance (`max_instances: 1`) whose idempotency layer reads and hashes every unsafe body in full — so one
 * caller, unauthenticated on the public `POST /v1/sync/enrol`, could starve every tenant with ~100 MB bodies.
 * The edge is the only ingress (the containers have no public route), so the ceiling is enforced here; the API
 * holds the same table as defence in depth (apps/api/src/middleware/body-limit.ts).
 *
 * The default covers every JSON route. Three paths carry more by contract:
 * - the attachment upload: `MAX_ATTACHMENT_BYTES` (packages/db/src/attachment, 25 MiB) plus multipart framing;
 * - the bank-statement import: `csv` is up to 4,000,000 characters (packages/contracts accounting/bank.ts),
 *   which JSON-escaped and UTF-8-encoded stays inside 16 MiB for any real statement;
 * - the till's sync surface: a push carries up to 200 tickets (`SYNC_BATCH_SYNC_LIMIT`).
 */
const MIB = 1024 * 1024;
export const DEFAULT_BODY_LIMIT = MIB;
export const ROUTE_BODY_LIMITS: readonly (readonly [RegExp, number])[] = [
  [/^\/v1\/companies\/[^/]+\/attachments$/, 27 * MIB],
  [/^\/v1\/companies\/[^/]+\/bank-statements$/, 16 * MIB],
  [/^\/v1\/sync\//, 8 * MIB],
];

export function bodyLimitFor(pathname: string): number {
  return ROUTE_BODY_LIMITS.find(([pattern]) => pattern.test(pathname))?.[1] ?? DEFAULT_BODY_LIMIT;
}

/** The declared `Content-Length`, or null when it is absent or not a plain decimal. */
export function declaredLength(request: Request): number | null {
  const value = request.headers.get("Content-Length");
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

/**
 * A body with no usable `Content-Length` (chunked) is counted as it streams: past `limit` the stream errors, the
 * container's read fails, and `exceeded()` tells the router to answer 413 rather than whatever the failure was.
 */
export function limitStream(
  body: ReadableStream<Uint8Array>,
  limit: number,
): { readonly body: ReadableStream<Uint8Array>; exceeded(): boolean } {
  let seen = 0;
  let tripped = false;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        tripped = true;
        controller.error(new Error(`request body exceeds ${limit} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return { body: body.pipeThrough(counter), exceeded: () => tripped };
}
