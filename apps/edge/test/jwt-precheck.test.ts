import { describe, expect, it } from "vitest";
import * as jwtPrecheck from "../src/jwt-precheck";
import { precheckJwt } from "../src/jwt-precheck";

const ISSUER = "https://proj.supabase.co/auth/v1";
/** `btoa`, not `Buffer`: `types: ["@cloudflare/workers-types"]` suppresses @types/node, and the Workers lib
 *  declares btoa. The payloads here are ASCII JSON, so btoa is exact. */
const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = (payload: Record<string, unknown>) =>
  `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;
const NOW = 1_800_000_000;

describe("apps/edge/src/jwt-precheck — a pre-filter, never a trust boundary (spec:1150)", () => {
  it("accepts a structurally sound, unexpired token from the configured issuer", () => {
    expect(precheckJwt(`Bearer ${token({ iss: ISSUER, exp: NOW + 60 })}`, ISSUER, NOW)).toEqual({
      ok: true,
    });
  });

  it("rejects a missing header without touching the container", () => {
    expect(precheckJwt(null, ISSUER, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(precheckJwt("Basic abc", ISSUER, NOW)).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a token that is not three decodable segments", () => {
    expect(precheckJwt("Bearer not.a.jwt", ISSUER, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(precheckJwt("Bearer onlyonesegment", ISSUER, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects an expired token and a foreign issuer", () => {
    expect(precheckJwt(`Bearer ${token({ iss: ISSUER, exp: NOW - 1 })}`, ISSUER, NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(
      precheckJwt(`Bearer ${token({ iss: "https://evil.example", exp: NOW + 60 })}`, ISSUER, NOW),
    ).toEqual({ ok: false, reason: "issuer" });
  });

  it("does NOT judge aal — the container owns the aal2 gate (spec:2004); an aal1 token passes the pre-check", () => {
    expect(
      precheckJwt(`Bearer ${token({ iss: ISSUER, exp: NOW + 60, aal: "aal1" })}`, ISSUER, NOW),
    ).toEqual({ ok: true });
  });

  it("exposes nothing that reads a claim — `subjectHint` fed the rate limiter an unverified `sub`", () => {
    // A shape assertion on purpose: the surface is one function, and the next reader must not add a
    // second one that hands an unverified claim to a caller (the edge's limiter now keys on origin).
    // Filtered to functions so a transform's own namespace bookkeeping cannot fail this.
    const surface = Object.entries(jwtPrecheck)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(surface).toEqual(["precheckJwt"]);
  });

  it("a forged signature still passes the pre-check — which is why the container re-verifies (spec:1150)", () => {
    expect(
      precheckJwt(`Bearer ${token({ iss: ISSUER, exp: NOW + 60 })}.tampered`, ISSUER, NOW).ok,
    ).toBe(false);
    expect(
      precheckJwt(`${b64({ alg: "none" })}.${b64({ iss: ISSUER, exp: NOW + 60 })}.`, ISSUER, NOW),
    ).toEqual({ ok: false, reason: "missing" });
  });
});
