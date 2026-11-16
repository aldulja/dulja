import { isAuthRetryableFetchError, type SupabaseClient } from "@supabase/supabase-js";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createAdminApi, type AdminApiOptions } from "./admin-api";
import { MyCompaniesSchema } from "@dulja/contracts/admin/my-companies";
import { readEnv } from "./env";
import { useI18n } from "./i18n-provider";
import { isAalRefusal, isSessionRefusal, retryQuery } from "./problem";
import type { SessionStore } from "./session-storage";

/**
 * `loading` is not `anonymous`. The first `getSession()` is asynchronous, so without this every
 * consumer would read `accessToken === null` on the first tick and conclude "signed out" — a route
 * guard would bounce an authenticated operator to `/login`, and the login screen would flash the
 * credentials form at someone who is already signed in.
 */
export type SessionStatus = "loading" | "anonymous" | "authenticated";

/**
 * An auth failure that still carries the provider's error code, so the UI can put a *translated*
 * sentence on screen instead of Supabase's English developer-facing `message` (spec:2061). Named
 * `AuthFailure` rather than `AuthError` because `@supabase/supabase-js` exports that name.
 */
export interface AuthFailure extends Error {
  code?: string;
}

const authFailure = (error: { message: string; code?: string | undefined }): AuthFailure =>
  Object.assign(new Error(error.message), error.code === undefined ? {} : { code: error.code });

/** The part of a session this provider reads. `Session` and the MFA verify response both fit. */
interface SessionFields {
  access_token: string;
  user?: { id?: string | null | undefined; email?: string | null | undefined } | null | undefined;
}

/**
 * Who is signed in, as a stable identity: the Supabase user id, never the access token. A token changes
 * about hourly when Supabase refreshes it; the principal changes only when someone else signs in (UI-01).
 */
const principalOf = (session: SessionFields | null): string | null =>
  session === null ? null : (session.user?.id ?? session.user?.email ?? "");

/** One of the operator's TOTP factors, reduced to the two facts the enrolment screen branches on. */
export interface TotpFactor {
  id: string;
  verified: boolean;
}

export interface TotpEnrolment {
  factorId: string;
  qrCode: string | null;
  secret: string | null;
}

export interface SessionValue {
  status: SessionStatus;
  accessToken: string | null;
  /** The signed-in principal (UI-01, UI-07): what a screen's identity and the query cache are keyed on. */
  principal: string | null;
  /** The current access token, read at call time. Stable across refreshes, so holding it remounts nothing. */
  getAccessToken(): string | null;
  /**
   * UI-08: refresh the session once (concurrent callers share one refresh) and answer the new access token.
   * A refresh Supabase refuses ends this device's session; a network failure answers `null` and ends nothing.
   */
  refreshAccessToken(): Promise<string | null>;
  aal: "aal1" | "aal2" | null;
  email: string | null;
  /**
   * `false` once the session store had to keep the token in memory for this run alone — the OS
   * keyring refused (ADR 0019 rule 4) and Dulja does not fall back to plaintext web storage. The
   * operator has to be told, because the consequence is visible: signing out at the next launch.
   */
  tokenPersisted: boolean;
  signIn(email: string, password: string): Promise<void>;
  /** Ends this device's session only (`scope: "local"`) and clears the query cache (UI-04, UI-07, UI-08). */
  signOut(): Promise<void>;
  /**
   * The MFA surface, as three named operations rather than the raw client. Handing components a
   * `SupabaseClient` would be an open invitation to read tables through it, which spec:1112 forbids
   * ("used as a database and auth provider, **not** as a backend" — every read goes to `/v1`).
   */
  listTotpFactors(): Promise<TotpFactor[]>;
  /**
   * Enrols a fresh TOTP factor, first unenrolling the abandoned unverified ones in `replacing` —
   * which the caller has already listed, so this does not fetch them a second time.
   */
  enrolTotp(replacing?: readonly TotpFactor[]): Promise<TotpEnrolment>;
  verifyTotp(factorId: string, code: string): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

/** The session, or `null` outside a provider — for chrome that also renders in session-less trees. */
export function useOptionalSession(): SessionValue | null {
  return useContext(SessionContext);
}

/**
 * The API options every screen is given. The object is keyed on the principal, not the token (UI-01): a
 * refresh changes nothing a screen holds, the token is read at call time, and a 401 refreshes and retries
 * once (UI-08). A different principal is a different object, so nothing built for one user serves another.
 */
export function useApiOptions(): AdminApiOptions {
  const { principal, getAccessToken, refreshAccessToken } = useSession();
  const { apiBaseUrl } = readEnv();
  return useMemo(
    () => ({ baseUrl: apiBaseUrl, accessToken: getAccessToken, refreshAccessToken }),
    // `principal` is a deliberate dependency: the getters are stable, and the object must still change when
    // the signed-in identity does — including null → signed in, which enables the screens' queries.
    [apiBaseUrl, getAccessToken, refreshAccessToken, principal],
  );
}

/**
 * Shared so the screen can ask this query to run again without naming it twice. A screen that is
 * refused for its token cannot act on that itself (it holds no session); re-running the lookup that
 * does is how it tells the owner below.
 */
export const COMPANY_QUERY_KEY = ["companies"] as const;

/**
 * The company every company-scoped request is made against: the first company in which the caller
 * holds a live role, from the membership-scoped `GET /v1/me/companies` (ADR 0089; review UI-03 — the
 * admin route `GET /v1/companies` refused the seeded accountant and auditor).
 *
 * `""` means "not known yet" — while the request is in flight, when it failed, and for a caller with
 * no live role anywhere. Callers must treat `""` as "do not build a URL out of this"; `UsersRoute`
 * disables its assignment controls and says why.
 */
export function useCompanyId(): string {
  const { accessToken, signOut } = useSession();
  const navigate = useNavigate();
  const options = useApiOptions();
  const api = useMemo(() => createAdminApi(options), [options]);
  const { data, error } = useQuery({
    queryKey: COMPANY_QUERY_KEY,
    queryFn: ({ signal }) => api.get("/v1/me/companies", MyCompaniesSchema, { signal }),
    // A refusal here is settled; retrying it three times only delays the screen's own honest
    // "the company is not known" (see `retryQuery`).
    retry: retryQuery,
    /*
     * Nothing is asked before there is a token to ask with. The provider's first `getSession()` is
     * asynchronous and separate from the route guard's, so this hook can render while `accessToken`
     * is still null; that request would go out unauthenticated, come back 401, and — because the
     * effect below answers a refused token by signing out — eject the operator mid-boot. The window
     * is small and the consequence is total, which is exactly the shape of bug that survives review.
     */
    enabled: accessToken !== null,
  });

  /**
   * **The one owner of the `/login` decision.** A refused token has to be answered by signing out
   * and only then routing: landing on `/login` with a client that still believes it is signed in
   * shows the operator a link straight back to the screen that just refused them, and following it
   * passes the route guard, which asks the local Supabase session rather than `/v1`.
   *
   * It lives here because this is the half of the app that holds the session *and* calls `/v1` with
   * the same token every screen uses. Screens do not get a second copy of this decision: when one is
   * refused for its token it re-runs this query (`COMPANY_QUERY_KEY`) instead of routing itself, so
   * whichever request learns first, the answer is made once, here. Were a screen to navigate on its
   * own, it would unmount this hook mid-flight, abort the query through its `signal`, and this
   * effect would never see the refusal at all.
   *
   * An assurance refusal is different and stays a plain redirect: the session is fine, so there is
   * nothing to sign out of.
   */
  useEffect(() => {
    if (isAalRefusal(error)) {
      void navigate({ to: "/mfa" });
      return;
    }
    if (!isSessionRefusal(error)) return;
    void signOut()
      // A sign-out that fails is still not a reason to strand the operator on a screen where every
      // request is refused, so `/login` happens either way — and a rejection that reached no handler
      // would be an unhandled one. The cost is that a local session can outlive the server's answer;
      // the operator then meets the signed-in view rather than the form, which is visible to them
      // rather than silent.
      .catch(() => {})
      .finally(() => void navigate({ to: "/login" }));
  }, [error, navigate, signOut]);

  return data?.companies[0]?.id ?? "";
}

/**
 * The visible half of a refused keyring write. Rendered by both `AppShell` and the login screen, so
 * it is on screen wherever the operator happens to be. Reads the context directly and renders
 * nothing outside a provider, so `AppShell` stays usable in trees that have no session at all
 * (`shell.test.tsx` renders it bare).
 */
export function TokenPersistenceAlert() {
  const session = useContext(SessionContext);
  const { t } = useI18n();
  if (session === null || session.tokenPersisted) return null;
  return (
    <p role="alert" className="text-start text-danger">
      {t("auth.session.memoryOnly")}
    </p>
  );
}

/** A store with no `persistence` member cannot degrade, so it is durable and never changes. */
const NO_PERSISTENCE_CHANGES = (): (() => void) => () => {};
const ALWAYS_DURABLE = (): boolean => true;

export interface SessionProviderProps {
  client: SupabaseClient;
  children: ReactNode;
  /** The same store `createSupabase` was given, so the UI can report a refused write. */
  store?: SessionStore;
}

export function SessionProvider({ client, children, store }: SessionProviderProps) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [principal, setPrincipal] = useState<string | null>(null);
  // The token as of the last `apply`, for call-time reads that must not re-render or remount anything.
  const tokenRef = useRef<string | null>(null);
  const principalRef = useRef<string | null>(null);
  const refreshing = useRef<Promise<string | null> | null>(null);
  // Read optionally: the login and enrolment screens' tests render a provider with no query client.
  const queryClient = useContext(QueryClientContext);
  const [email, setEmail] = useState<string | null>(null);
  const [aal, setAal] = useState<"aal1" | "aal2" | null>(null);

  const persistence = store?.persistence;
  const tokenPersisted = useSyncExternalStore(
    persistence?.subscribe ?? NO_PERSISTENCE_CHANGES,
    persistence?.durable ?? ALWAYS_DURABLE,
  );

  const apply = useCallback(
    (session: SessionFields | null) => {
      tokenRef.current = session?.access_token ?? null;
      const next = principalOf(session);
      /*
       * UI-07: a cache filled for one principal must never be read by the next. It is cleared whenever the
       * signed-in identity changes — sign-in, sign-out, a different user — and kept across a token refresh,
       * which is the same principal (UI-01: a refresh must not send every grid back to "Loading…").
       */
      if (next !== principalRef.current) {
        principalRef.current = next;
        queryClient?.clear();
      }
      setPrincipal(next);
      setAccessToken(session?.access_token ?? null);
      setEmail(session?.user?.email ?? null);
      setStatus(session ? "authenticated" : "anonymous");
    },
    [queryClient],
  );

  const getAccessToken = useCallback(() => tokenRef.current, []);

  useEffect(() => {
    void client.auth
      .getSession()
      .then(({ data }) => apply(data.session))
      // A transport failure must not leave the app in `loading` for ever with the reason only in the
      // console. Unknown means not signed in: the API is the authority either way.
      .catch(() => setStatus("anonymous"));
    const { data } = client.auth.onAuthStateChange((_event, session) => apply(session));
    return () => data.subscription.unsubscribe();
  }, [apply, client]);

  /**
   * The `aal` claim decides which routes the API will answer at all: 0B admits `aal1` only on
   * `GET /v1/session`, and answers `ERR_AUTH_AAL_INSUFFICIENT` everywhere else until a second
   * factor is enrolled and verified (§4.2.3). It is read from the client, never asserted by it.
   */
  useEffect(() => {
    if (accessToken === null) {
      setAal(null);
      return;
    }
    void client.auth.mfa
      .getAuthenticatorAssuranceLevel()
      .then(({ data }) => setAal(data?.currentLevel === "aal2" ? "aal2" : "aal1"))
      // Least privilege: a level we could not read is not a level we may assume. `aal1` sends the
      // operator to enrolment, which is the one thing the API admits at that level.
      .catch(() => setAal("aal1"));
  }, [accessToken, client]);

  const signIn = useCallback(
    async (emailAddress: string, password: string) => {
      const { data, error } = await client.auth.signInWithPassword({
        email: emailAddress,
        password,
      });
      if (error) throw authFailure(error);
      // Applied here as well as through `onAuthStateChange`: the subscription is the only other
      // path to this state, so a client that does not emit `SIGNED_IN` would leave the screen
      // showing the form it just submitted. Both paths set the same values from the same session,
      // so running both is idempotent.
      apply(data.session);
    },
    [apply, client],
  );

  /*
   * `scope: "local"` (UI-08): this device's session ends and its refresh token is revoked, but the operator's
   * sessions on other machines do not — a refused token here says nothing about them. The shell's own
   * sign-out button (UI-04) uses the same scope: on a shared workstation it is this seat that must end.
   */
  const signOut = useCallback(async () => {
    queryClient?.clear();
    const { error } = await client.auth.signOut({ scope: "local" });
    // Supabase emits SIGNED_OUT on success; applying here as well keeps a client that does not emit honest.
    if (!error) apply(null);
  }, [apply, client, queryClient]);

  const refreshAccessToken = useCallback((): Promise<string | null> => {
    refreshing.current ??= (async () => {
      try {
        const { data, error } = await client.auth.refreshSession();
        if (error === null && data.session !== null) {
          apply(data.session);
          return data.session.access_token;
        }
        // A refresh token Supabase refuses is a dead session; a refresh that could not reach Supabase is not.
        if (error !== null && !isAuthRetryableFetchError(error)) await signOut().catch(() => {});
        return null;
      } catch {
        return null;
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, [apply, client, signOut]);

  const listTotpFactors = useCallback(async (): Promise<TotpFactor[]> => {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) throw authFailure(error);
    return (data?.all ?? [])
      .filter((factor) => factor.factor_type === "totp")
      .map((factor) => ({ id: factor.id, verified: factor.status === "verified" }));
  }, [client]);

  const enrolTotp = useCallback(
    async (replacing: readonly TotpFactor[] = []): Promise<TotpEnrolment> => {
      // Every unverified TOTP factor is an orphan from an abandoned enrolment, and a fresh one is
      // minted on every visit to the screen. Clearing them keeps one factor per operator instead of
      // one per visit. `unenroll` needs `aal2` only for a *verified* factor, so this is allowed at
      // `aal1` — which is the only level the enrolling operator has, and is why verified factors are
      // filtered out here rather than trusted to be absent.
      for (const factor of replacing) {
        if (factor.verified) continue;
        const { error: refusal } = await client.auth.mfa.unenroll({ factorId: factor.id });
        /*
         * Discarding this would hide the one case that matters. A factor verified on another device
         * between the list above and this call is refused server-side — unenrolling a *verified*
         * factor needs `aal2` and an enroller has `aal1` — and carrying on would then mint a second
         * factor beside a live one the operator is already using, or fail later with
         * `mfa_verified_factor_exists` and no explanation.
         *
         * So the refusal is surfaced rather than swallowed, and the screen's retry re-lists — which
         * lands on the challenge branch when that is what happened. The cost is that a persistent
         * server-side refusal blocks enrolment instead of silently working around it; that is the
         * right way round, because the orphan's survival is then visible rather than assumed.
         */
        if (refusal) throw authFailure(refusal);
      }
      const { data, error } = await client.auth.mfa.enroll({ factorType: "totp" });
      if (error) throw authFailure(error);
      return {
        factorId: data.id,
        qrCode: data.totp?.qr_code ?? null,
        secret: data.totp?.secret ?? null,
      };
    },
    [client],
  );

  const verifyTotp = useCallback(
    async (factorId: string, code: string) => {
      const { data, error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
      if (error) throw authFailure(error);
      // A verify answers with a fresh, `aal2` session — a new access token, not the old one.
      // Applying it is what moves `aal` to `aal2` without waiting for an auth-state event.
      apply(data);
    },
    [apply, client],
  );

  const value = useMemo<SessionValue>(
    () => ({
      status,
      accessToken,
      principal,
      getAccessToken,
      refreshAccessToken,
      aal,
      email,
      tokenPersisted,
      signIn,
      signOut,
      listTotpFactors,
      enrolTotp,
      verifyTotp,
    }),
    [
      accessToken,
      aal,
      email,
      enrolTotp,
      getAccessToken,
      listTotpFactors,
      principal,
      refreshAccessToken,
      signIn,
      signOut,
      status,
      tokenPersisted,
      verifyTotp,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
