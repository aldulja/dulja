import { createRemoteJWKSet, jwtVerify, type JWSAlgorithm, type JWTVerifyGetKey } from "jose";
import { AppError } from "@dulja/contracts";
import type { JwtVerifier } from "./ports";
/**
 * Asymmetric only. `createRemoteJWKSet` resolves a key whose type jose matches against the header's `alg`,
 * so `alg: none` and an HS256 token signed with the published public key are already refused before this
 * list is consulted; naming it keeps that true for a key set supplied any other way, where no such
 * resolution happens. The four are the ones a Supabase JWKS can present for its asymmetric signing keys.
 */
const ALGORITHMS: readonly JWSAlgorithm[] = ["RS256", "ES256", "EdDSA", "Ed25519"];
export function createJwtVerifierWithKeys(options: {
  keys: JWTVerifyGetKey;
  issuer: string;
  audience: string;
}): JwtVerifier {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, options.keys, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: [...ALGORITHMS],
        // jose checks `exp` only when the claim is there, so a token minted without one never expires.
        // `iss` and `aud` need no such naming: jose requires a claim it was given an expected value for.
        requiredClaims: ["exp"],
      });
      if (typeof payload.sub !== "string") throw new Error();
      return { sub: payload.sub, aal: payload.aal === "aal2" ? "aal2" : "aal1" };
    } catch {
      throw new AppError("ERR_AUTH_TOKEN_INVALID", "the access token could not be verified");
    }
  };
}
export function createJwtVerifier(options: {
  jwksUrl: string;
  issuer: string;
  audience: string;
}): JwtVerifier {
  return createJwtVerifierWithKeys({
    keys: createRemoteJWKSet(new URL(options.jwksUrl)),
    issuer: options.issuer,
    audience: options.audience,
  });
}
