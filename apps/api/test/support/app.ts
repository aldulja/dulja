import { registerDefaultTransmitters, resetTransmitters } from "@dulja/db";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createLocalJWKSet, exportJWK, type JSONWebKeySet } from "jose";
import { v7 as newUuidV7 } from "uuid";
import { createLogger } from "@dulja/contracts";
import {
  createDb,
  createHrKeyRing,
  DEV_HR_KEY,
  MemoryObjectStore,
  type JobClient,
} from "@dulja/db";
import { startDb, type Db } from "@dulja/db/test";
import { createApp } from "../../src/app";
import { pgDebugTracer } from "../../src/otel";
import { StubAuthAdmin } from "../../src/auth-admin";
import type { AppEnv } from "../../src/context";
import type { AuthAdmin, InvitedUser } from "../../src/ports";
import { createJwtVerifierWithKeys } from "../../src/verifier";

export const TEST_ISSUER = "https://test.dulja.invalid/auth/v1";
/** What Supabase stamps on every access token, and so what `readConfig` defaults SUPABASE_JWT_AUDIENCE to. */
export const TEST_AUDIENCE = "authenticated";

/**
 * The stub, plus a tally. An invitation is the one thing this API does that leaves the process and cannot
 * be undone — mail to a third party — so "was the provider asked at all?" has to be observable.
 */
class CountingAuthAdmin implements AuthAdmin {
  readonly #inner = new StubAuthAdmin();
  count = 0;
  createUser(email: string): Promise<InvitedUser> {
    return this.#inner.createUser(email);
  }
  inviteUser(email: string): Promise<InvitedUser> {
    this.count += 1;
    return this.#inner.inviteUser(email);
  }
}

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function signRs256(key: KeyObject, payload: object): string {
  const input = `${base64url({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${base64url(payload)}`;
  const signature = createSign("RSA-SHA256").update(input).end().sign(key).toString("base64url");
  return `${input}.${signature}`;
}

export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  form?: FormData;
  as?: string;
  aal?: "aal1" | "aal2";
  idempotencyKey?: string | null;
  headers?: Record<string, string>;
}

export interface StartedApi {
  db: Db;
  app: OpenAPIHono<AppEnv>;
  /** Every line the API logged, newest last, as emitted JSON. Cleared by `takeLogs()`. */
  takeLogs(): { level: string; msg: string; [field: string]: unknown }[];
  tokenFor(principalId: string, aal?: "aal1" | "aal2"): string;
  signToken(claims: Record<string, unknown>): string;
  /** How many times the identity provider has been asked to invite somebody since this API started. */
  invitesSent(): number;
  loadPrincipals(): Promise<void>;
  request(input: ApiRequest): Promise<Response>;
  stop(): Promise<void>;
  /** 2C — contracts §4.2.12's registered member: the in-process store the app was built with. */
  objectStore: MemoryObjectStore;
}

/** `jobs` replaces the stub job client below, for a suite that drives a real pg-boss (it installs one on
 *  `api.db` once the API has started, so the client it passes delegates to it). */
export async function startApi(
  opts: { authAdmin?: AuthAdmin; jobs?: JobClient } = {},
): Promise<StartedApi> {
  const db = await startDb();
  const rw = createDb(db.url("app_rw"), { debug: pgDebugTracer() });
  const lines: string[] = [];
  const authAdmin = new CountingAuthAdmin();
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  const jwks: JSONWebKeySet = {
    keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }],
  };
  const objectStore = new MemoryObjectStore();
  resetTransmitters();
  registerDefaultTransmitters("dev");
  const app = createApp({
    terminalJwtSigningKey: new TextEncoder().encode(
      "dulja-test-terminal-signing-key-0123456789abcdef",
    ),
    db: rw,
    objectStore,
    // 8A (amendment A8) — a deterministic dev ring, so a route test's sealed fields open under the same key.
    hrKeys: createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 }),
    jobs: opts.jobs ?? {
      // 4B Task 4: postDocument's step 14 enqueues accounting.projection.rebuild for EVERY document with a
      // party or with movements (contracts §4.3.2, 4B amendment 2), so a route test that posts one reaches
      // this client on the posting transaction. That job is accepted and dropped — no route test asserts a
      // projection, and packages/db and apps/worker prove the enqueue against a real pg-boss. Every other job
      // still throws, so a back-dated route post still cannot silently skip its cost replay.
      enqueue: async (_tx, name) => {
        if (name === "accounting.projection.rebuild")
          return "route-test:accounting.projection.rebuild";
        if (
          name === "accounting.tax.submit" ||
          name === "pos.sync.apply" ||
          name === "admin.export.run"
        )
          return newUuidV7();
        throw new Error("no job client in route tests — slice 0D wires pg-boss");
      },
    },
    logger: createLogger({ sink: (line) => lines.push(line) }),
    authAdmin: opts.authAdmin ?? authAdmin,
    verifier: createJwtVerifierWithKeys({
      keys: createLocalJWKSet(jwks),
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    }),
  });
  const subjects = new Map<string, string>();
  const loadPrincipals = async (): Promise<void> => {
    const rows = await db.admin<{ id: string; auth_subject: string }[]>`
      select id, auth_subject from app.principal`;
    for (const row of rows) subjects.set(row.id, row.auth_subject);
  };
  const tokenFor = (principalId: string, aal: "aal1" | "aal2" = "aal2"): string => {
    const now = Math.floor(Date.now() / 1000);
    return signRs256(privateKey, {
      sub: subjects.get(principalId) ?? principalId,
      aal,
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      iat: now,
      exp: now + 600,
    });
  };
  // `aud` is defaulted rather than left to the caller: every existing use of this helper varies one claim
  // to prove that claim is checked, and a token that also silently lost its audience would prove less.
  const signToken = (claims: Record<string, unknown>): string =>
    signRs256(privateKey, { aud: TEST_AUDIENCE, ...claims });
  return {
    db,
    app,
    takeLogs: () =>
      lines.splice(0).map((line) => JSON.parse(line) as { level: string; msg: string }),
    tokenFor,
    signToken,
    invitesSent: () => authAdmin.count,
    loadPrincipals,
    objectStore,
    async request(input) {
      if (input.as && !subjects.has(input.as)) await loadPrincipals();
      const headers: Record<string, string> = {};
      if (input.as) headers.Authorization = `Bearer ${tokenFor(input.as, input.aal ?? "aal2")}`;
      if (input.body !== undefined) headers["content-type"] = "application/json";
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(input.method) &&
        input.idempotencyKey !== null
      )
        headers["Idempotency-Key"] = input.idempotencyKey ?? newUuidV7();
      Object.assign(headers, input.headers ?? {});
      const body =
        input.form ?? (input.body === undefined ? undefined : JSON.stringify(input.body));
      return app.request(
        input.path,
        body === undefined
          ? { method: input.method, headers }
          : { method: input.method, headers, body },
      );
    },
    async stop() {
      await rw.end();
      await db.stop();
    },
  };
}
