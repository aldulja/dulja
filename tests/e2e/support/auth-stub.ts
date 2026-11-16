import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { E2E_INVITEE_EMAIL, E2E_RECOVERY_CODE, E2E_THROTTLED_EMAIL, E2E_TOTP_CODE } from "./people";

/** The origin the built back office is served from (`boot.ts`'s `WEB_PORT`). */
export const WEB_ORIGIN = "http://127.0.0.1:4173";

/**
 * Seconds. Must match the lifetime `startApi()`'s `tokenFor` puts in the JWT's `exp` (600), or
 * supabase-js believes a session the API has already stopped accepting is still good, and the
 * screen meets a 401 with no explanation instead of refreshing.
 */
const SESSION_SECONDS = 600;

export interface AuthStub {
  url: string;
  stop(): Promise<void>;
}

export type MintToken = (principalId: string, aal?: "aal1" | "aal2") => string;

/** A principal id for the invitee, who has never signed in and so has no factor. The token it is
 *  minted into never reaches `/v1` — the set-password spec stops at the hand-off to enrolment. */
const INVITEE_ID = "00000000-0000-4000-8000-0000000000a1";

/** GoTrue's error envelope, as `@supabase/auth-js`'s `handleError` reads it (`error_code`). */
const refusal = (code: string, msg: string) => ({ error_code: code, msg });

/**
 * Supabase Auth, reduced to what the login form and `@supabase/supabase-js` actually call. The
 * access token is minted by 0B's own test issuer (`startApi().tokenFor`) — one issuer and one key
 * pair for the stub and the API — so a session obtained here is a session the real API honours.
 * Nothing here mimics Supabase beyond these four responses: no password is checked, because the
 * thing under test is the screen, not the identity provider (OD-19/OD-21 are open).
 *
 * ADR 0096 adds the recovery-code path the set-password step drives: `POST /recover`, `POST /verify`
 * (`type: "recovery"`), `PUT /user`, and the TOTP challenge and verify an enrolled account must pass
 * before its password changes. Those keep just enough state to be honest about the order: a code is
 * accepted only for an address that asked for one, and a password change on an enrolled account is
 * refused `insufficient_aal` until the session is `aal2`, as GoTrue refuses it.
 */
export function startAuthStub(
  principalId: string,
  email: string,
  mintToken: MintToken,
  port = 8788,
): Promise<AuthStub> {
  const app = new Hono();
  const user = {
    id: principalId,
    aud: "authenticated",
    role: "authenticated",
    email,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    /** `mfa.getAuthenticatorAssuranceLevel()` reads this list; an enrolled TOTP factor is the
     *  state an `aal2` session is in, and the route guard `requireEnrolledFactor` asks for it. */
    factors: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        factor_type: "totp",
        status: "verified",
        friendly_name: "e2e",
      },
    ],
  };
  const invitee = { ...user, id: INVITEE_ID, email: E2E_INVITEE_EMAIL, factors: [] };
  type StubUser = typeof user | typeof invitee;
  /** Which user and level each access token this stub minted stands for. */
  const issued = new Map<string, { who: StubUser; aal: "aal1" | "aal2" }>();
  const mint = (who: StubUser, aal: "aal1" | "aal2") => {
    const accessToken = mintToken(who.id, aal);
    issued.set(accessToken, { who, aal });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: SESSION_SECONDS,
      expires_at: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
      refresh_token: "stub-refresh-token",
      user: who,
    };
  };
  const session = (aal: "aal1" | "aal2") => mint(user, aal);
  /** The bearer's user and level; a token this stub did not mint is the owner at `aal2`, which is
   *  what every pre-ADR-0096 caller of `/user` already assumed. */
  const caller = (header: string | undefined) =>
    issued.get((header ?? "").replace(/^Bearer /i, "")) ?? { who: user, aal: "aal2" as const };
  /** Addresses that asked for a recovery code, so `/verify` refuses one nobody requested. */
  const requested = new Set<string>();

  /**
   * The browser reaches this stub cross-origin — the page is on `:4173`, the stub on `:8788` — and
   * `supabase-js` sends `apikey`, `authorization`, `x-client-info` and `content-type`, every one of
   * which makes the request non-simple and triggers a preflight. Without this middleware the
   * `OPTIONS` gets no handler, no `Access-Control-Allow-*` comes back, and sign-in fails in the
   * browser with a CORS error rather than an HTTP one. `allowHeaders` is deliberately **omitted**:
   * Hono's `cors()` then echoes `Access-Control-Request-Headers` back verbatim, so a header
   * `supabase-js` adds in a future version cannot silently break this harness.
   */
  app.use(
    "*",
    cors({ origin: WEB_ORIGIN, allowMethods: ["GET", "POST", "PUT", "OPTIONS"], maxAge: 600 }),
  );

  app.post("/auth/v1/token", (context) => context.json(session("aal2")));
  app.get("/auth/v1/user", (context) =>
    context.json(caller(context.req.header("authorization")).who),
  );

  /** GoTrue answers 200 whether or not it holds the address (no enumeration). */
  app.post("/auth/v1/recover", async (context) => {
    const { email: asked } = await context.req.json<{ email?: string }>();
    if (asked === E2E_THROTTLED_EMAIL)
      return context.json(
        refusal(
          "over_email_send_rate_limit",
          "For security purposes, you can only request this after 60 seconds.",
        ),
        429,
      );
    if (typeof asked === "string") requested.add(asked.toLowerCase());
    return context.json({});
  });
  app.post("/auth/v1/verify", async (context) => {
    const body = await context.req.json<{ email?: string; token?: string; type?: string }>();
    const asked = (body.email ?? "").toLowerCase();
    if (body.type !== "recovery" || body.token !== E2E_RECOVERY_CODE || !requested.has(asked))
      return context.json(refusal("otp_expired", "Token has expired or is invalid"), 403);
    requested.delete(asked);
    const who = asked === email.toLowerCase() ? user : asked === E2E_INVITEE_EMAIL ? invitee : null;
    if (who === null)
      return context.json(refusal("otp_expired", "Token has expired or is invalid"), 403);
    return context.json(mint(who, "aal1"));
  });
  app.put("/auth/v1/user", async (context) => {
    const { who, aal } = caller(context.req.header("authorization"));
    const { password } = await context.req.json<{ password?: string }>();
    if (who.factors.length > 0 && aal !== "aal2")
      return context.json(
        refusal(
          "insufficient_aal",
          "AAL2 session is required to update email or password when MFA is enabled.",
        ),
        401,
      );
    if (typeof password !== "string" || password.length < 8)
      return context.json(
        refusal("weak_password", "Password should be at least 8 characters."),
        422,
      );
    return context.json(who);
  });
  app.post("/auth/v1/factors/:factorId/challenge", (context) =>
    context.json({
      id: "00000000-0000-4000-8000-0000000000c1",
      type: "totp",
      expires_at: Math.floor(Date.now() / 1000) + 300,
    }),
  );
  app.post("/auth/v1/factors/:factorId/verify", async (context) => {
    const { code } = await context.req.json<{ code?: string }>();
    if (code !== E2E_TOTP_CODE)
      return context.json(refusal("mfa_verification_failed", "Invalid TOTP code entered"), 422);
    return context.json(session("aal2"));
  });
  app.get("/auth/v1/factors", (context) => context.json(user.factors));
  app.post("/auth/v1/logout", (context) => context.body(null, 204));
  /** Anything else is a call this stub has not been taught; answering it with a plausible 200
   *  would hide the gap, so it answers the way Supabase answers an unknown route. */
  app.all("*", (context) => context.json({ error: "not_implemented" }, 404));

  return new Promise((done, fail) => {
    // `listening`/`error` rather than `serve`'s success callback: a port already held by something
    // else (a previous run's leftovers) would otherwise leave this promise pending for ever and the
    // whole suite would die on Playwright's global-setup timeout with nothing said about why.
    const server: ServerType = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
    server.on("error", fail);
    server.on("listening", () =>
      done({
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise<void>((closed) => server.close(() => closed())),
      }),
    );
  });
}
