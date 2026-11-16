import type { PrecheckResult } from "./env";
export type { PrecheckResult } from "./env";

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function precheckJwt(
  authorization: string | null,
  issuer: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): PrecheckResult {
  if (!authorization?.startsWith("Bearer ")) return { ok: false, reason: "missing" };
  const parts = authorization.slice(7).split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return { ok: false, reason: "malformed" };
  const header = decodeSegment(parts[0]!);
  const payload = decodeSegment(parts[1]!);
  if (!header || !payload) return { ok: false, reason: "malformed" };
  const expiry = payload["exp"];
  if (typeof expiry !== "number" || expiry <= nowSeconds) return { ok: false, reason: "expired" };
  if (payload["iss"] !== issuer) return { ok: false, reason: "issuer" };
  return { ok: true };
}

// This module deliberately exports no way to read `sub`. It used to, and the rate limiter keyed on it —
// a claim out of a payload nothing here verifies, so a caller could mint a bucket per request or spend a
// named victim's. Nothing at the edge may key on a claim; see `networkOriginKey` in rate-limit.ts.
