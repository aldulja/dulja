// apps/api/src/middleware/terminal-auth.ts
import { createHash, verify as edVerify, createPublicKey } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";
import { claimSignedRequest, SyncError, terminalContext, withTenant } from "@dulja/db";
import { canonicalSyncRequest } from "@dulja/sync";
import type { AppEnv } from "../context";

export interface TerminalIdentity {
  readonly terminalId: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
  readonly principalId: string;
  readonly code: string | null;
}

/** ±5 minutes. Wide enough for an unsynchronised shop PC; the refusal names the skew so a shop with a wrong
 *  clock is diagnosable in one line. Inside the window a captured request is NOT stale — each signed message
 *  is spent once, against `app.terminal_request_guard` (PR 12 review, extra finding E1). */
export const TERMINAL_SKEW_SECONDS = 300;
/** 15 minutes (§4.10.3). Short because revocation is re-checked per request anyway — the TTL bounds the
 *  window in which a stolen token works against a terminal that has not yet been revoked. */
export const TERMINAL_JWT_TTL_SECONDS = 900;
export const TERMINAL_TOKEN_HEADER = "X-Terminal-Token";
const TERMINAL_JWT_ISSUER = "urn:dulja:terminal";

/** The ONE canonical string lives in `@dulja/sync`, beside the till's signer, so signer and verifier cannot
 *  drift (SAH-046). Re-exported, never re-spelt: a second copy here is the drift that sentence forbids. */
export { canonicalSyncRequest };

function bad(detail: string): never {
  throw new AppError("ERR_TERMINAL_SIGNATURE_INVALID", detail);
}

export function terminalAuth(deps: { db: Sql; signingKey: Uint8Array }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = c.get("requestId");
    const auth = c.req.header("Authorization");
    const bearer = auth?.startsWith("Bearer ") === true ? auth.slice(7) : null;
    let terminalId: string;
    let mintToken = false;
    // The signed path's message, spent once below. Ed25519 is deterministic, so the digest of the canonical
    // message names the request exactly; a replay of it inside the clock window is refused (finding E1).
    let spend: { digest: string; signedAt: string } | null = null;
    // The signed path must resolve the terminal to get its device key; the token path must resolve it to get a
    // context. Resolving it twice would double the round trips on every /v1/sync call, so whichever path ran
    // keeps its answer here and the shared block below reuses it.
    let resolved: Awaited<ReturnType<typeof terminalContext>> | null = null;

    if (bearer !== null) {
      // ── the token path ──────────────────────────────────────────────────────────────────────────────
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(bearer, deps.signingKey, {
          issuer: TERMINAL_JWT_ISSUER,
          algorithms: ["HS256"],
        }));
      } catch {
        // Every failure — wrong key, wrong issuer, expired, malformed — is ONE answer. A human's Supabase
        // token lands here too: it is signed by a different key and carries a different issuer.
        bad("terminal token is not valid");
      }
      const sub = typeof payload.sub === "string" ? payload.sub : "";
      if (!sub.startsWith("terminal:")) bad("terminal token is not valid");
      terminalId = sub.slice("terminal:".length);
    } else {
      // ── the signed path ─────────────────────────────────────────────────────────────────────────────
      const id = c.req.header("X-Terminal-Id");
      const timestamp = c.req.header("X-Terminal-Timestamp");
      const signature = c.req.header("X-Terminal-Signature");
      if (id === undefined || timestamp === undefined || signature === undefined) {
        bad(
          "a /v1/sync request needs X-Terminal-Id, X-Terminal-Timestamp and X-Terminal-Signature, or a terminal token",
        );
      }
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp))
        bad("X-Terminal-Timestamp is not an RFC 3339 instant");
      const at = Date.parse(timestamp);
      if (Number.isNaN(at)) bad("X-Terminal-Timestamp is not an RFC 3339 instant");
      const skew = Math.abs(Date.now() - at) / 1000;
      if (skew > TERMINAL_SKEW_SECONDS) {
        bad(
          `X-Terminal-Timestamp is ${Math.round(skew)}s outside this server's clock; the window is ${TERMINAL_SKEW_SECONDS}s`,
        );
      }

      // The body is read here and Hono caches it, so the handler's own c.req.json() re-uses this parse.
      const body = c.req.method === "GET" || c.req.method === "HEAD" ? "" : await c.req.text();
      const canonical = canonicalSyncRequest({
        method: c.req.method,
        // The PATH ONLY — never the query string. A cursor is not a secret and a till that retried with a
        // different `limit` would otherwise have to re-sign; what the signature protects is *which terminal
        // is asking which operation*, and the tenant scope comes from the terminal, not from the URL.
        path: new URL(c.req.url).pathname,
        timestamp,
        body: createHash("sha256").update(body, "utf8").digest("hex"),
      });

      resolved = await terminalContext(deps.db, id, requestId).catch((e: unknown) => {
        if (e instanceof SyncError) bad(e.detail);
        throw e;
      });
      let ok = false;
      try {
        ok = edVerify(
          null,
          Buffer.from(canonical, "utf8"),
          createPublicKey({ key: resolved.terminal.devicePublicKey, format: "der", type: "spki" }),
          Buffer.from(signature, "base64"),
        );
      } catch {
        ok = false;
      }
      if (!ok) bad("the request signature does not verify for that terminal");
      terminalId = id;
      mintToken = true;
      spend = {
        digest: createHash("sha256").update(canonical, "utf8").digest("hex"),
        signedAt: new Date(at).toISOString(),
      };
    }

    const { ctx, terminal } =
      resolved ??
      (await terminalContext(deps.db, terminalId, requestId).catch((e: unknown) => {
        if (e instanceof SyncError) bad(e.detail);
        throw e;
      }));
    // Re-checked on EVERY request, token path included: a JWT that outlived its terminal would be exactly the
    // "one variable disables every control" of SAH-027, moved into a signed envelope.
    if (terminal.revokedAt !== null)
      throw new AppError("ERR_TERMINAL_REVOKED", `terminal ${terminalId} was revoked`);
    // Only a message that verified is ever recorded, so nobody without the device key can spend a slot. Its own
    // short transaction, committed before the handler runs: a request that later fails is still spent, and the
    // till re-signs every attempt anyway (`signSyncHeaders` stamps a fresh timestamp per call).
    if (spend !== null) {
      const fresh = await withTenant(deps.db, ctx, (tx) =>
        claimSignedRequest(tx, {
          tenantId: terminal.tenantId,
          terminalId,
          ...spend,
          windowSeconds: TERMINAL_SKEW_SECONDS,
        }),
      );
      if (!fresh) bad("that signed request was already used; every request must be signed afresh");
    }

    const identity: TerminalIdentity = {
      terminalId,
      tenantId: terminal.tenantId,
      companyId: terminal.companyId,
      branchId: terminal.branchId,
      principalId: terminal.principalId,
      code: terminal.code,
    };
    c.set("terminal", identity);
    c.set("ctx", { ...ctx, principalKind: "terminal", aal: "aal2" });
    c.set("withTenant", <T>(fn: (tx: Sql) => Promise<T>) => withTenant(deps.db, ctx, fn));
    c.set(
      "logger",
      c.get("logger").child({ terminal_id: terminalId, tenant_id: terminal.tenantId }),
    );

    if (mintToken) {
      const token = await new SignJWT({
        tid: terminal.tenantId,
        cid: terminal.companyId,
        bid: terminal.branchId,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(TERMINAL_JWT_ISSUER)
        .setSubject(`terminal:${terminalId}`)
        .setIssuedAt()
        .setExpirationTime(`${TERMINAL_JWT_TTL_SECONDS}s`)
        .sign(deps.signingKey);
      c.header(TERMINAL_TOKEN_HEADER, token);
    }
    await next();
  };
}
