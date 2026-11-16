import { AppError } from "@dulja/contracts";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../context";

/**
 * Request-body ceilings (API-11, ADR 0092) — defence in depth behind the edge, which is the only ingress and holds
 * the same table (apps/edge/src/body-limit.ts; the two are kept equal by hand and each is pinned by its own test).
 * Mounted before authentication and idempotency: the latter reads and hashes every unsafe body in full, and the
 * single API instance would otherwise parse whatever one caller sends. A declared `Content-Length` is checked
 * without reading; a chunked body is counted as it is buffered.
 *
 * - default 1 MiB, every JSON route;
 * - the attachment upload: `MAX_ATTACHMENT_BYTES` (25 MiB) plus multipart framing;
 * - the bank-statement import: a `csv` of up to 4,000,000 characters;
 * - the till's sync surface: a push of up to 200 tickets.
 */
const MIB = 1024 * 1024;
export const DEFAULT_BODY_LIMIT = MIB;
export const ROUTE_BODY_LIMITS: readonly (readonly [RegExp, number])[] = [
  [/^\/v1\/companies\/[^/]+\/attachments$/, 27 * MIB],
  [/^\/v1\/companies\/[^/]+\/bank-statements$/, 16 * MIB],
  [/^\/v1\/sync\//, 8 * MIB],
];

const limiter = (maxSize: number): MiddlewareHandler<AppEnv> =>
  bodyLimit({
    maxSize,
    onError: () => {
      throw new AppError(
        "ERR_PAYLOAD_TOO_LARGE",
        `the request body exceeds this path's limit of ${maxSize} bytes`,
      );
    },
  });
const limiters = new Map<number, MiddlewareHandler<AppEnv>>(
  [DEFAULT_BODY_LIMIT, ...ROUTE_BODY_LIMITS.map(([, bytes]) => bytes)].map((bytes) => [
    bytes,
    limiter(bytes),
  ]),
);

export function requestBodyLimit(): MiddlewareHandler<AppEnv> {
  return (c, next) => {
    const bytes =
      ROUTE_BODY_LIMITS.find(([pattern]) => pattern.test(c.req.path))?.[1] ?? DEFAULT_BODY_LIMIT;
    return (limiters.get(bytes) ?? limiter(bytes))(c, next);
  };
}
