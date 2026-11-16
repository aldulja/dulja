import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLocalJWKSet, exportJWK, type JSONWebKeySet } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthAdmin, StubAuthAdmin, SupabaseAuthAdmin } from "../src/auth-admin";
import { ConfigError, readConfig, type ApiConfig } from "../src/config";
import { createJwtVerifierWithKeys } from "../src/verifier";

const b64 = (value: object): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const now = (): number => Math.floor(Date.now() / 1000);

const required = {
  DATABASE_URL: "postgres://app_rw:secret@localhost:5432/dulja",
  TERMINAL_JWT_SIGNING_KEY: "dulja-test-terminal-signing-key-0123456789abcdef",
  SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
  SUPABASE_JWT_ISSUER: "https://project.supabase.co/auth/v1",
};

describe("API configuration and identity provider adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates required configuration, enums, and the listening port", () => {
    expect(readConfig(required)).toMatchObject({ appEnv: "dev", logLevel: "info", port: 8080 });
    expect(() => readConfig({ ...required, APP_ENV: "live" })).toThrow(ConfigError);
    expect(() => readConfig({ ...required, PORT: "0" })).toThrow(ConfigError);
    expect(() => readConfig({ ...required, DATABASE_URL: "" })).toThrow(ConfigError);
    expect(() => readConfig({ ...required, TERMINAL_JWT_SIGNING_KEY: "" })).toThrow(ConfigError);
    expect(() => readConfig({ ...required, TERMINAL_JWT_SIGNING_KEY: "too-short" })).toThrow(
      ConfigError,
    );
    // Each refusal names its cause and its fix, so a container that exits 2 is diagnosable from one line.
    const { TERMINAL_JWT_SIGNING_KEY: _key, ...withoutKey } = required;
    expect(() => readConfig(withoutKey)).toThrow(
      /^TERMINAL_JWT_SIGNING_KEY is not set .*deploy\.md/,
    );
    expect(() => readConfig({ ...required, TERMINAL_JWT_SIGNING_KEY: "too-short" })).toThrow(
      /^TERMINAL_JWT_SIGNING_KEY must be at least 32 characters/,
    );
  });

  // PR 12 review, R15: Phase 6 made TERMINAL_JWT_SIGNING_KEY required in every APP_ENV, and the deploy runbook
  // never bound it, so the image crashed at boot exactly as PR 11's did. The deployed container's environment is
  // the wrangler `vars` (APP_ENV, LOG_LEVEL) plus what the runbook's "Secrets" block binds; this boots
  // readConfig() on exactly that, and apps/edge/test/containers.test.ts proves the edge forwards every name.
  it("boots on exactly the secrets docs/runbooks/deploy.md binds, in staging and in production", () => {
    const runbook = readFileSync(
      new URL("../../../docs/runbooks/deploy.md", import.meta.url),
      "utf8",
    );
    const block =
      /The container's secrets are set once per environment[\s\S]*?```bash\n([\s\S]*?)```/.exec(
        runbook,
      )?.[1];
    expect(block, "the runbook's container-secrets block").toBeDefined();
    const looped = /for name in ([\s\S]*?); do/.exec(block!)?.[1]?.split(/[\s\\]+/) ?? [];
    const single = [...block!.matchAll(/wrangler secret put ([A-Z0-9_]+)/g)].map((m) => m[1]!);
    const names = [...looped, ...single].filter((name) => /^[A-Z0-9_]+$/.test(name));
    expect(names).toContain("TERMINAL_JWT_SIGNING_KEY");
    // `openssl rand -base64 48`, the runbook's generator, is 64 characters; any bound value is at least that.
    // 8A's HR key is the exception: readConfig() decodes it, so it is bound as `openssl rand -base64 32` binds it.
    const hrKey = Buffer.alloc(32, 7).toString("base64");
    expect(names).toContain("HR_FIELD_ENCRYPTION_KEY");
    const bound = Object.fromEntries(
      names.map((name) => [
        name,
        name.startsWith("HR_FIELD_ENCRYPTION_KEY") ? hrKey : `bound-${name}-`.padEnd(64, "x"),
      ]),
    );
    for (const appEnv of ["staging", "production"])
      expect(readConfig({ ...bound, APP_ENV: appEnv, LOG_LEVEL: "info" })).toMatchObject({
        appEnv,
      });
  });

  it("defaults the token audience and leaves the provider credentials optional", () => {
    // Neither name is required, and both for the same reason: apps/edge/src/container-env.ts passes the
    // container a fixed list and neither is on it, so requiring either would fail boot on a decision this
    // workspace does not own.
    expect(readConfig(required)).toMatchObject({
      supabaseJwtAudience: "authenticated",
      supabaseUrl: null,
      supabaseServiceRoleKey: null,
    });
    expect(readConfig({ ...required, SUPABASE_JWT_AUDIENCE: "dulja" })).toMatchObject({
      supabaseJwtAudience: "dulja",
    });
    expect(
      readConfig({ ...required, SUPABASE_URL: "https://project.supabase.co" }).supabaseUrl,
    ).toBe("https://project.supabase.co");
  });

  it("calls the configured Supabase admin invite endpoint and trusts only its returned subject", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "provider-subject", email: "ignored@example.test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const admin = new SupabaseAuthAdmin({
      url: "https://project.supabase.co",
      serviceRoleKey: "test-service-role",
      invitePath: "/auth/v1/invite",
      createPath: "/auth/v1/admin/users",
    });
    await expect(admin.inviteUser("person@example.test")).resolves.toEqual({
      sub: "provider-subject",
      email: "person@example.test",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://project.supabase.co/auth/v1/invite"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "person@example.test" }),
      }),
    );
  });

  it("maps the provider's 409/422 to ERR_CONFLICT_UNIQUE and bounds the call", async () => {
    const admin = new SupabaseAuthAdmin({
      url: "https://project.supabase.co",
      serviceRoleKey: "test-service-role",
      invitePath: "/auth/v1/invite",
      createPath: "/auth/v1/admin/users",
    });
    const fetchMock = vi.fn(async () => new Response("already registered", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(admin.inviteUser("held@example.test")).rejects.toMatchObject({
      code: "ERR_CONFLICT_UNIQUE",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(SupabaseAuthAdmin.TIMEOUT_MS).toBe(10_000);
  });

  it("maps provider failures and malformed responses to safe internal errors", async () => {
    const admin = new SupabaseAuthAdmin({
      url: "https://project.supabase.co",
      serviceRoleKey: "test-service-role",
      invitePath: "/auth/v1/invite",
      createPath: "/auth/v1/admin/users",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );
    await expect(admin.inviteUser("person@example.test")).rejects.toMatchObject({
      code: "ERR_INTERNAL",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    await expect(admin.inviteUser("person@example.test")).rejects.toMatchObject({
      code: "ERR_INTERNAL",
    });
  });
});

/** The four names 2C Task 2 makes required outside development. Declared ONCE at describe scope: a fifth
 *  required name added by a later slice moves in one place, not two. */
const objectStore = {
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_ATTACHMENTS_BUCKET: "bucket",
} as const;

describe("readConfig — the object store is required outside development (2C Task 2)", () => {
  // This is the rule that kept the createAuthAdmin cases below red for two phases without anyone noticing,
  // because those cases only ever tripped it by accident. It now has its own case, so loosening the
  // requirement — or misspelling one of the four names in config.ts — is red here rather than silently green.
  it("refuses staging and production without each of the four R2 names, naming the one missing", () => {
    for (const appEnv of ["staging", "production"]) {
      for (const name of Object.keys(objectStore) as (keyof typeof objectStore)[]) {
        const env = { ...required, ...objectStore, APP_ENV: appEnv, [name]: undefined };
        expect(() => readConfig(env)).toThrow(ConfigError);
        expect(() => readConfig(env)).toThrow(
          new RegExp(`^${name} is required when APP_ENV=${appEnv}`),
        );
      }
    }
  });
  it("does not require them in dev", () => {
    expect(() => readConfig({ ...required, APP_ENV: "dev" })).not.toThrow();
  });
});

/** 8A — the HR field-encryption key, base64 of exactly 32 bytes (contracts round 16, A8). Required outside dev
 *  like the R2 names, and checked after them. */
const hrKey = { HR_FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") } as const;

describe("readConfig — the HR field-encryption key (8A amendment A8, ADR 0071)", () => {
  it("defaults to the all-zero dev key in dev only", () => {
    expect(readConfig({ ...required, APP_ENV: "dev" })).toMatchObject({
      hrFieldEncryptionKey: Buffer.alloc(32).toString("base64"),
      hrFieldEncryptionKeyPrevious: null,
    });
    for (const appEnv of ["staging", "production"]) {
      const env = { ...required, ...objectStore, APP_ENV: appEnv };
      expect(() => readConfig(env)).toThrow(ConfigError);
      expect(() => readConfig(env)).toThrow(
        new RegExp(`^HR_FIELD_ENCRYPTION_KEY is required when APP_ENV=${appEnv}`),
      );
      expect(readConfig({ ...env, ...hrKey })).toMatchObject({
        hrFieldEncryptionKey: hrKey.HR_FIELD_ENCRYPTION_KEY,
      });
    }
  });
  it("refuses a key that is not base64 of exactly 32 bytes, naming the variable", () => {
    const short = Buffer.alloc(16).toString("base64");
    expect(() => readConfig({ ...required, HR_FIELD_ENCRYPTION_KEY: short })).toThrow(ConfigError);
    expect(() => readConfig({ ...required, HR_FIELD_ENCRYPTION_KEY: short })).toThrow(
      /^HR_FIELD_ENCRYPTION_KEY decodes to 16 bytes; exactly 32/,
    );
    expect(() =>
      readConfig({ ...required, ...hrKey, HR_FIELD_ENCRYPTION_KEY_PREVIOUS: "not base64!" }),
    ).toThrow(/^HR_FIELD_ENCRYPTION_KEY_PREVIOUS is not valid base64/);
    expect(
      readConfig({
        ...required,
        ...hrKey,
        HR_FIELD_ENCRYPTION_KEY_PREVIOUS: hrKey.HR_FIELD_ENCRYPTION_KEY,
        // 8D A1: a previous key lives at the current version minus one, so it needs a current version above 1.
        HR_FIELD_ENCRYPTION_KEY_VERSION: "2",
      }),
    ).toMatchObject({ hrFieldEncryptionKeyPrevious: hrKey.HR_FIELD_ENCRYPTION_KEY });
  });
});

describe("readConfig — HR_FIELD_ENCRYPTION_KEY_VERSION (8D A1, ADR 0080)", () => {
  it("is optional and defaults to 1, the value 8A's literal held — no existing environment changes", () => {
    expect(readConfig({ ...required, ...hrKey })).toMatchObject({ hrFieldEncryptionKeyVersion: 1 });
    expect(
      readConfig({ ...required, ...hrKey, HR_FIELD_ENCRYPTION_KEY_VERSION: "" }),
    ).toMatchObject({ hrFieldEncryptionKeyVersion: 1 });
  });
  it("reads a rotated version and pairs it with the previous key", () => {
    expect(
      readConfig({
        ...required,
        ...hrKey,
        HR_FIELD_ENCRYPTION_KEY_VERSION: "3",
        HR_FIELD_ENCRYPTION_KEY_PREVIOUS: hrKey.HR_FIELD_ENCRYPTION_KEY,
      }),
    ).toMatchObject({
      hrFieldEncryptionKeyVersion: 3,
      hrFieldEncryptionKeyPrevious: hrKey.HR_FIELD_ENCRYPTION_KEY,
    });
  });
  it("refuses anything but an integer from 1 to 255 (one envelope byte), naming the variable", () => {
    for (const bad of ["0", "-1", "1.5", "1e0", " 2", "256", "two", "01"]) {
      expect(
        () => readConfig({ ...required, ...hrKey, HR_FIELD_ENCRYPTION_KEY_VERSION: bad }),
        bad,
      ).toThrow(/^HR_FIELD_ENCRYPTION_KEY_VERSION must be an integer between 1 and 255/);
    }
  });
  it("refuses a previous key bound beside version 1 — it would have no version to live at", () => {
    expect(() =>
      readConfig({
        ...required,
        ...hrKey,
        HR_FIELD_ENCRYPTION_KEY_PREVIOUS: hrKey.HR_FIELD_ENCRYPTION_KEY,
      }),
    ).toThrow(
      /^HR_FIELD_ENCRYPTION_KEY_PREVIOUS is bound but HR_FIELD_ENCRYPTION_KEY_VERSION is 1/,
    );
  });
});

describe("createAuthAdmin — the stub is a development-only adapter", () => {
  // The HR key rides along for staging and production for the same reason the object-store names do below.
  const config = (env: NodeJS.ProcessEnv): ApiConfig =>
    readConfig({ ...required, ...hrKey, ...env });

  it("gives dev the stub when the identity provider is not configured", () => {
    expect(createAuthAdmin(config({}))).toBeInstanceOf(StubAuthAdmin);
  });

  it("refuses to start staging or production on the stub, naming what is missing", () => {
    // The seed CLI warns and carries on here (packages/db/src/cli.ts:65, OWNER GATE OD-21) because an
    // operator is watching it. The same warning at API boot scrolls past, and every later invitation
    // answers 201 while writing a principal nobody can sign in as and app_rw cannot delete.
    // R2_ACCOUNT_ID and its three siblings are supplied because 2C Task 2 made the object store
    // required outside development, and `readConfig` validates it BEFORE the identity provider. Without
    // them this case has been red since 2C: `config({ APP_ENV: "staging" })` threw
    // "R2_ACCOUNT_ID is required when APP_ENV is staging" and never reached createAuthAdmin, so the
    // assertion below tested nothing. Supplying them is what restores the case's own subject — the
    // identity provider — rather than weakening the regex to match whichever error came first.
    for (const appEnv of ["staging", "production"]) {
      expect(() => createAuthAdmin(config({ APP_ENV: appEnv, ...objectStore }))).toThrow(
        ConfigError,
      );
      expect(() => createAuthAdmin(config({ APP_ENV: appEnv, ...objectStore }))).toThrow(
        /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not set/,
      );
      expect(() =>
        createAuthAdmin(
          config({ APP_ENV: appEnv, ...objectStore, SUPABASE_URL: "https://p.supabase.co" }),
        ),
      ).toThrow(/^SUPABASE_SERVICE_ROLE_KEY not set/);
    }
  });

  it("takes the real adapter the moment both names are supplied, in any environment", () => {
    // The object-store names ride along for staging and production for the reason given above: 2C makes
    // them required there, and readConfig checks them before it reaches the identity provider.
    for (const appEnv of ["dev", "staging", "production"])
      expect(
        createAuthAdmin(
          config({
            APP_ENV: appEnv,
            ...objectStore,
            SUPABASE_URL: "https://p.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
          }),
        ),
      ).toBeInstanceOf(SupabaseAuthAdmin);
  });
});

describe("JWT verification — issuer, audience, expiry, subject", () => {
  const ISSUER = "https://project.supabase.co/auth/v1";
  const AUDIENCE = "authenticated";
  let privateKey: KeyObject;
  let verify: ReturnType<typeof createJwtVerifierWithKeys>;

  const sign = (claims: Record<string, unknown>): string => {
    const input = `${b64({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${b64(claims)}`;
    const signature = createSign("RSA-SHA256")
      .update(input)
      .end()
      .sign(privateKey)
      .toString("base64url");
    return `${input}.${signature}`;
  };
  const valid = (): Record<string, unknown> => ({
    sub: "9f1d0f9a-0000-7000-8000-000000000000",
    aal: "aal2",
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now(),
    exp: now() + 600,
  });
  const refused = async (claims: Record<string, unknown>): Promise<void> => {
    await expect(verify(sign(claims))).rejects.toMatchObject({ code: "ERR_AUTH_TOKEN_INVALID" });
  };

  beforeAll(async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKey = pair.privateKey;
    const jwks: JSONWebKeySet = {
      keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" }],
    };
    verify = createJwtVerifierWithKeys({
      keys: createLocalJWKSet(jwks),
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  });

  it("accepts a token that carries every checked claim", async () => {
    await expect(verify(sign(valid()))).resolves.toEqual({
      sub: "9f1d0f9a-0000-7000-8000-000000000000",
      aal: "aal2",
    });
  });

  it("refuses a token minted for another audience, and one minted for none", async () => {
    // Nothing checked `aud`, so any token the same issuer minted — for another service of the project,
    // or by a flow that is not an end-user sign-in — was a valid access token for this API.
    const { aud: _aud, ...noAudience } = valid();
    await refused({ ...valid(), aud: "service" });
    await refused(noAudience);
  });

  it("refuses a token with no exp at all, not only an expired one", async () => {
    // jose compares `exp` when it is present and says nothing when it is absent, so a token minted
    // without one never expired. `requiredClaims` is what makes the absence a verification failure.
    const { exp: _exp, ...noExpiry } = valid();
    await refused(noExpiry);
    await refused({ ...valid(), exp: now() - 60 });
  });

  it("still refuses another issuer and a token whose subject is not a string", async () => {
    await refused({ ...valid(), iss: "https://other.invalid/auth/v1" });
    await refused({ ...valid(), sub: 42 });
  });
});
