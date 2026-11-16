import type { RateLimitBinding } from "./env";

export interface RateLimitOutcome {
  readonly allowed: boolean;
  readonly headers: Record<string, string>;
}
export const DEFAULT_POLICY = { limit: 600, windowSeconds: 60 } as const;

/**
 * The bucket every request without a network origin shares. Named, because the choice is the point:
 * see `networkOriginKey`.
 */
export const SHARED_ORIGIN_KEY = "no-connecting-ip";

/**
 * The only limiter key the edge is entitled to. Cloudflare sets `CF-Connecting-IP` on ingress and
 * overwrites whatever the client sent, so it is the one property of a request a caller cannot choose.
 *
 * Nothing from the token may be used. No code at the edge verifies a JWT signature — `precheckJwt`
 * reads `exp` and `iss` out of an unverified payload and the API container is what actually verifies —
 * so `sub` is attacker-chosen both before and after the pre-check. Keying on it let one caller mint a
 * fresh bucket per request with a random `sub`, and burn a named victim's budget by claiming theirs.
 * The honest position: the edge cannot key on identity at all, only on network origin.
 *
 * No header means local `wrangler dev` or a test, never production. Those requests fail CLOSED onto one
 * shared bucket — deliberately, because the only other fallback (something unique per request) is an
 * unlimited one, which is the defect this replaced.
 */
export function networkOriginKey(request: Request): string {
  const origin = request.headers.get("CF-Connecting-IP");
  if (!origin) return SHARED_ORIGIN_KEY;
  return origin.includes(":") ? ipv6Prefix64(origin) : origin;
}

/**
 * An IPv6 client controls (at least) a /64, so keying on the full address would hand it a fresh bucket per
 * request — the unlimited limiter this whole module replaced. The key is the first four hextets, which is
 * the network the provider actually assigned.
 */
export function ipv6Prefix64(address: string): string {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  const [head = "", tail = ""] = bare.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === "" ? [] : tail.split(":");
  const zeros = Math.max(0, 8 - front.length - back.length);
  const hextets = [...front, ...Array<string>(zeros).fill("0"), ...back];
  return `${hextets
    .slice(0, 4)
    .map((h) => (h === "" ? "0" : h.toLowerCase().replace(/^0+(?=\w)/, "")))
    .join(":")}::/64`;
}
export async function applyRateLimit(
  binding: RateLimitBinding,
  key: string,
  policy: { limit: number; windowSeconds: number } = DEFAULT_POLICY,
): Promise<RateLimitOutcome> {
  const { success } = await binding.limit({ key });
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(policy.limit),
    "RateLimit-Remaining": success ? "1" : "0",
    "RateLimit-Reset": String(policy.windowSeconds),
  };
  if (!success) headers["Retry-After"] = String(policy.windowSeconds);
  return { allowed: success, headers };
}
