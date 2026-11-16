import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupabaseClient } from "@supabase/supabase-js";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { AppShell } from "../src/components/app-shell";
import { I18nProvider, type LocaleStore } from "../src/lib/i18n-provider";
import { SessionProvider, useCompanyId } from "../src/lib/session";
import {
  browserSessionStore,
  electronSessionStore,
  memorySessionStore,
  pickSessionStore,
  type AuthSetResult,
  type SessionStore,
} from "../src/lib/session-storage";
import { createSupabase } from "../src/lib/supabase";
import { createAppRouter } from "../src/router";
import { LoginRoute } from "../src/routes/login";
import { MfaEnrolRoute } from "../src/routes/mfa-enrol";
import { RouterAround } from "./support/router";

/** The value that must never reach disk in plain text (DoD 0.13, spec:2323). */
const SECRET = "refresh-token-1f0e5c9a";
const SESSION = { access_token: "jwt", user: { email: "owner@example.test" } };

/**
 * The brief casts the fake `as never` and then asserts on `client.auth.*`. That does not typecheck:
 * `never` has no properties. Typed as the real client intersected with the mocks instead, so the
 * fake is still assignable to `SupabaseClient` and the assertions still see `Mock`.
 */
type FakeClient = SupabaseClient & {
  auth: SupabaseClient["auth"] & {
    getSession: Mock;
    signInWithPassword: Mock;
    // Typed as the mock it is, so a test can make the sign-out itself fail.
    signOut: Mock;
    mfa: {
      listFactors: Mock;
      unenroll: Mock;
      enroll: Mock;
      challengeAndVerify: Mock;
      getAuthenticatorAssuranceLevel: Mock;
    };
  };
};

interface FakeOptions {
  signedIn?: boolean;
  aal?: "aal1" | "aal2";
  /** The operator's existing TOTP factors, as `listFactors` would report them. */
  factors?: readonly { id: string; verified: boolean }[];
  signInError?: { message: string; code?: string };
  verifyError?: { message: string; code?: string };
  listFactorsRejects?: boolean;
}

const fakeClient = (options: FakeOptions = {}): FakeClient => {
  const level = options.aal ?? "aal1";
  const factors = (options.factors ?? []).map((factor) => ({
    id: factor.id,
    factor_type: "totp",
    status: factor.verified ? "verified" : "unverified",
  }));
  return {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: options.signedIn === true ? SESSION : null },
        error: null,
      })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signInWithPassword: vi.fn(async () =>
        options.signInError === undefined
          ? { data: { session: SESSION }, error: null }
          : { data: { session: null }, error: options.signInError },
      ),
      signOut: vi.fn(async () => ({ error: null })),
      mfa: {
        listFactors: vi.fn(async () => {
          if (options.listFactorsRejects === true) throw new TypeError("Failed to fetch");
          return {
            data: { all: factors, totp: factors.filter((f) => f.status === "verified") },
            error: null,
          };
        }),
        unenroll: vi.fn(async (params: { factorId: string }) => ({
          data: { id: params.factorId },
          error: null,
        })),
        enroll: vi.fn(async () => ({
          data: {
            id: "factor-1",
            totp: {
              qr_code: "data:image/svg+xml,<svg/>",
              secret: "JBSWY3DPEHPK3PXP",
              uri: "otpauth://totp/dulja",
            },
          },
          error: null,
        })),
        challengeAndVerify: vi.fn(async () =>
          options.verifyError === undefined
            ? {
                data: { access_token: "jwt-aal2", user: { email: "owner@example.test" } },
                error: null,
              }
            : { data: null, error: options.verifyError },
        ),
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: level, nextLevel: "aal2" },
          error: null,
        })),
      },
    },
  } as unknown as FakeClient;
};

/**
 * A `LocaleStore` that touches nothing outside itself. `browserLocaleStore` would write
 * `dulja.locale` into the real `localStorage`, which is exactly the storage the refusal tests below
 * assert is empty.
 */
const fakeLocaleStore = (): LocaleStore => ({
  read: () => null,
  write: () => {},
});

/**
 * `/login` exactly as the router mounts it: inside `I18nProvider`, **outside** `AppShell`. The
 * brief renders it inside the shell and with no `I18nProvider` at all; both are wrong against what
 * Task 5 shipped — `AppShell` now calls `useI18n()` (so that tree throws), and `shell.test.tsx`'s
 * "no shell chrome" case pins that a signed-out visitor is shown no header and no nav link.
 */
const renderLogin = (client: SupabaseClient, store: SessionStore = browserSessionStore) =>
  render(
    <I18nProvider store={fakeLocaleStore()}>
      <SessionProvider client={client} store={store}>
        <RouterAround>
          <LoginRoute />
        </RouterAround>
      </SessionProvider>
    </I18nProvider>,
  );

/**
 * `/mfa` is reached by someone already signed in at `aal1`, so it wears the shell. `<StrictMode>`
 * is deliberate: it double-mounts, which is the only way a test can see the enrol effect firing
 * twice and minting a second orphan factor.
 */
const renderMfa = (client: SupabaseClient) =>
  render(
    <StrictMode>
      <I18nProvider store={fakeLocaleStore()}>
        <SessionProvider client={client} store={browserSessionStore}>
          <RouterAround>
            <AppShell>
              <MfaEnrolRoute />
            </AppShell>
          </RouterAround>
        </SessionProvider>
      </I18nProvider>
    </StrictMode>,
  );

/**
 * The whole application, real routes and real guards, driven by a memory history.
 *
 * The `QueryClientProvider` mirrors `main.tsx`'s composition — outside `SessionProvider`, which is
 * itself a consumer (`useCompanyId`), and outside the router, every route of which may be one. Task
 * 8's `/admin/users` is the first screen to read `/v1`, so without it the two tests below that land
 * on that path meet "No QueryClient set" instead of the tree they came to exercise. A fresh client
 * per render, with retries off, keeps one test's cache and one test's failed request out of the next.
 */
const renderApp = (
  client: SupabaseClient,
  path: string,
  store: SessionStore = browserSessionStore,
) => {
  const router = createAppRouter(client, createMemoryHistory({ initialEntries: [path] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider client={client} store={store}>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return router;
};

/** A promise this test settles by hand, so "still loading" is an observable state. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value) => settle?.(value) };
}

/** Everything a plain-text reader could find in this page's web storage, as one string. */
const webStorageDump = (): string => {
  const entries: string[] = [];
  for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      entries.push(`${key}=${key === null ? "" : storage.getItem(key)}`);
    }
  }
  entries.push(`cookie=${globalThis.document.cookie}`);
  return entries.join("\n");
};

/** A bridge whose OS keyring is missing: `set` RESOLVES with a refusal rather than rejecting. */
const refusingBridge = () => ({
  get: vi.fn(async (_key: string): Promise<string | null> => null),
  set: vi.fn(async (_key: string, _value: string): Promise<AuthSetResult> => ({
    ok: false,
    reason: "encryption-unavailable",
  })),
  remove: vi.fn(async (_key: string): Promise<void> => undefined),
});

/** A bridge whose IPC channel is gone: `set` rejects outright. */
const rejectingBridge = () => ({
  get: vi.fn(async (_key: string): Promise<string | null> => null),
  set: vi.fn(async (_key: string, _value: string): Promise<AuthSetResult> => {
    throw new Error("Error invoking remote method 'dulja:auth:set': channel closed");
  }),
  remove: vi.fn(async (_key: string): Promise<void> => undefined),
});

const acceptingBridge = () => {
  const keyring = new Map<string, string>();
  return {
    keyring,
    get: vi.fn(async (key: string): Promise<string | null> => keyring.get(key) ?? null),
    set: vi.fn(async (key: string, value: string): Promise<AuthSetResult> => {
      keyring.set(key, value);
      return { ok: true };
    }),
    remove: vi.fn(async (key: string): Promise<void> => {
      keyring.delete(key);
    }),
  };
};

beforeEach(() => {
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("session store selection", () => {
  it("uses localStorage in a plain browser", () => {
    expect(pickSessionStore({} as Window)).toBe(browserSessionStore);
  });

  it("uses the Electron bridge when window.dulja.auth exists", () => {
    const store = pickSessionStore({ dulja: { auth: acceptingBridge() } } as never);
    expect(store).not.toBe(browserSessionStore);
    expect(typeof store.getItem).toBe("function");
  });

  it("round-trips a value through the bridge store", async () => {
    // The brief's fake resolved `set` with `undefined`; the shipped bridge resolves it with
    // `AuthSetResult` (`apps/desktop/src/bridge-types.ts`), and reading `.ok` off `undefined`
    // throws. The shipped contract wins.
    const bridge = acceptingBridge();
    const store = electronSessionStore(bridge);
    await store.setItem("sb-token", "abc");
    await expect(store.getItem("sb-token")).resolves.toBe("abc");
    // Really through the bridge, not held in the adapter's own memory.
    expect(bridge.keyring.get("sb-token")).toBe("abc");
    await store.removeItem("sb-token");
    await expect(store.getItem("sb-token")).resolves.toBeNull();
  });

  it("reports durable storage while the keyring accepts", async () => {
    const store = electronSessionStore(acceptingBridge());
    const changed = vi.fn();
    store.persistence?.subscribe(changed);
    await store.setItem("sb-token", "abc");
    expect(store.persistence?.durable()).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });

  it("refuses the browser store inside Electron when the preload never loaded", async () => {
    // The bridge is the only route to `safeStorage`. If the preload failed, `window.dulja` is
    // simply absent — and picking `localStorage` there would put the refresh token in Chromium's
    // LevelDB in plain text on a machine nobody is watching, which is DoD 0.13's exact failure.
    const webWrite = vi.spyOn(Storage.prototype, "setItem");
    const store = pickSessionStore({
      navigator: { userAgent: "Mozilla/5.0 Electron/38.0.0 Safari/537.36" },
    } as never);
    expect(store).not.toBe(browserSessionStore);
    await store.setItem("sb-project-auth-token", SECRET);
    expect(webWrite).not.toHaveBeenCalled();
    expect(webStorageDump()).not.toContain(SECRET);
    expect(store.persistence?.durable()).toBe(false);
    // The session still works for this run, so the operator is not locked out by the backstop.
    await expect(store.getItem("sb-project-auth-token")).resolves.toBe(SECRET);
  });

  it("recognises the packaged app by its own scheme as well as its user agent", () => {
    expect(pickSessionStore({ location: { protocol: "dulja:" } } as never)).not.toBe(
      browserSessionStore,
    );
  });

  it("memorySessionStore is never durable, from the first moment", () => {
    expect(memorySessionStore().persistence?.durable()).toBe(false);
  });
});

describe("a keyring that refuses (ADR 0019 rule 4, DoD 0.13)", () => {
  it("writes the token to no web storage at all, and keeps it in memory for the run", async () => {
    // `localStorage` and `sessionStorage` are both `Storage` instances, so one prototype spy covers
    // every write either of them could receive — including one made through a reference the adapter
    // captured rather than through the globals this test clears.
    const webWrite = vi.spyOn(Storage.prototype, "setItem");
    const bridge = refusingBridge();
    const store = electronSessionStore(bridge);

    await store.setItem("sb-project-auth-token", SECRET);

    expect(bridge.set).toHaveBeenCalledWith("sb-project-auth-token", SECRET);
    expect(webWrite).not.toHaveBeenCalled();
    expect(globalThis.localStorage.length).toBe(0);
    expect(globalThis.sessionStorage.length).toBe(0);
    // Enumerated rather than inferred from the spy: proves the bytes are absent, not merely that
    // one code path declined to write them.
    expect(webStorageDump()).not.toContain(SECRET);

    // The one permitted fallback: this run, in memory, and nowhere else.
    await expect(store.getItem("sb-project-auth-token")).resolves.toBe(SECRET);
    expect(bridge.get).not.toHaveBeenCalled();
    expect(store.persistence?.durable()).toBe(false);

    // And only this run — the next launch reads the keyring, which holds nothing.
    await expect(electronSessionStore(bridge).getItem("sb-project-auth-token")).resolves.toBeNull();
  });

  it("treats a bridge that rejects exactly like one that refuses", async () => {
    // `set` resolves on a refusal, but the call can still reject — IPC torn down at shutdown, main
    // process gone. Left bare that rejection surfaces as raw IPC text where the sign-in error goes.
    const webWrite = vi.spyOn(Storage.prototype, "setItem");
    const store = electronSessionStore(rejectingBridge());
    await expect(store.setItem("sb-project-auth-token", SECRET)).resolves.toBeUndefined();
    expect(webWrite).not.toHaveBeenCalled();
    expect(webStorageDump()).not.toContain(SECRET);
    expect(store.persistence?.durable()).toBe(false);
    await expect(store.getItem("sb-project-auth-token")).resolves.toBe(SECRET);
  });

  it("tells the app, so the refusal is surfaced rather than swallowed", async () => {
    const store = electronSessionStore(refusingBridge());
    const changed = vi.fn();
    const unsubscribe = store.persistence?.subscribe(changed);
    await store.setItem("sb-project-auth-token", SECRET);
    expect(changed).toHaveBeenCalledTimes(1);
    // Latching: a second refusal is not a second piece of news.
    await store.setItem("sb-project-auth-token", `${SECRET}-2`);
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe?.();
    await store.setItem("sb-project-auth-token", `${SECRET}-3`);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("keeps supabase-js itself out of web storage, not just this adapter", async () => {
    // The adapter can only honour DoD 0.13 if supabase-js actually routes through it. Without this,
    // a `storage` option the client ignored would leave the refresh token in `localStorage` while
    // every assertion above still passed.
    const webWrite = vi.spyOn(Storage.prototype, "setItem");
    const bridge = refusingBridge();
    const store = electronSessionStore(bridge);
    const client = createSupabase(
      {
        apiBaseUrl: "https://api.example.test",
        supabaseUrl: "https://project.supabase.co",
        supabaseAnonKey: "anon-key",
        appEnv: "dev",
      },
      store,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "jwt-aal1",
              token_type: "bearer",
              expires_in: 3600,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              refresh_token: SECRET,
              user: {
                id: "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000",
                aud: "authenticated",
                email: "owner@example.test",
                app_metadata: {},
                user_metadata: {},
                created_at: new Date().toISOString(),
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: "owner@example.test",
        password: "correct horse battery staple",
      });
      expect(error).toBeNull();
      expect(data.session?.refresh_token).toBe(SECRET);
      // supabase-js tried to persist, and the only door it had was the refusing bridge.
      expect(bridge.set).toHaveBeenCalled();
      expect(bridge.set.mock.calls.some((call) => String(call[1]).includes(SECRET))).toBe(true);
      expect(webWrite).not.toHaveBeenCalled();
      expect(webStorageDump()).not.toContain(SECRET);
    } finally {
      await client.auth.stopAutoRefresh();
    }
  });
});

describe("route guards", () => {
  it("bounces an anonymous visitor off /admin/users to the login screen", async () => {
    renderApp(fakeClient(), "/admin/users");
    expect(await screen.findByLabelText("E-mail")).toBeInTheDocument();
    // No chrome on the way: the guard redirected before the shell rendered.
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("bounces an aal1 visitor off /admin/users to enrolment, not to the login screen", async () => {
    // The API admits `aal1` only on `GET /v1/session` (§4.2.3); every request the users screen
    // makes would answer `ERR_AUTH_AAL_INSUFFICIENT`.
    renderApp(fakeClient({ signedIn: true, aal: "aal1" }), "/admin/users");
    expect(await screen.findByLabelText("Six-digit code")).toBeInTheDocument();
    expect(screen.queryByLabelText("E-mail")).not.toBeInTheDocument();
  });

  it("lets an aal2 visitor through to /admin/users", async () => {
    const router = renderApp(
      fakeClient({ signedIn: true, aal: "aal2", factors: [{ id: "factor-1", verified: true }] }),
      "/admin/users",
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/users"));
    // Genuinely through, with the chrome — not merely "not redirected yet".
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("keeps /mfa reachable at aal1, which is the level the API admits there", async () => {
    const router = renderApp(fakeClient({ signedIn: true, aal: "aal1" }), "/mfa");
    await waitFor(() => expect(router.state.location.pathname).toBe("/mfa"));
  });

  it("sends the root to the login screen when there is no session", async () => {
    const router = renderApp(fakeClient(), "/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("sends the root to the back office when there is one", async () => {
    const router = renderApp(
      fakeClient({ signedIn: true, aal: "aal2", factors: [{ id: "factor-1", verified: true }] }),
      "/",
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/users"));
  });
});

describe("LoginRoute", () => {
  it("signs in with e-mail and password using only the keyboard", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderLogin(client);
    // The e-mail field carries `autoFocus`, so the operator lands ready to type: no Tab is needed to
    // reach it, and counting shell-chrome tab stops here would couple this test to AppShell's DOM
    // order. The *real* tab order is proved where it is meaningful, in `tests/e2e/rtl-parity.spec.ts`.
    await waitFor(() => expect(screen.getByLabelText("E-mail")).toHaveFocus());
    await user.keyboard("owner@example.test");
    await user.tab(); // → password
    expect(screen.getByLabelText("Password")).toHaveFocus();
    await user.keyboard("correct horse battery staple");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
        email: "owner@example.test",
        password: "correct horse battery staple",
      }),
    );
  });

  it("does not flash the credentials form while the stored session is still being read", async () => {
    // `getSession()` is asynchronous. Without a `loading` status distinct from `anonymous`, an
    // operator who is already signed in sees the form for a frame and every guard misfires.
    const gate = deferred<{ data: { session: typeof SESSION }; error: null }>();
    const client = fakeClient({ signedIn: true });
    client.auth.getSession.mockImplementation(() => gate.promise);
    renderLogin(client);
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByLabelText("E-mail")).not.toBeInTheDocument();
    gate.resolve({ data: { session: SESSION }, error: null });
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("E-mail")).not.toBeInTheDocument();
  });

  it("stops loading and offers the form when the session cannot be read at all", async () => {
    const client = fakeClient();
    client.auth.getSession.mockRejectedValue(new TypeError("Failed to fetch"));
    renderLogin(client);
    // Not stuck on "Loading…" for ever with the reason only in the console.
    expect(await screen.findByLabelText("E-mail")).toBeInTheDocument();
  });

  it("sends a signed-in owner to enrolment, and moves focus so the change is announced", async () => {
    const user = userEvent.setup();
    renderLogin(fakeClient());
    await waitFor(() => expect(screen.getByLabelText("E-mail")).toBeInTheDocument());
    await user.type(screen.getByLabelText("E-mail"), "owner@example.test");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const next = await screen.findByRole("link", { name: "Set up two-factor authentication" });
    expect(next).toHaveAttribute("href", "/mfa");
    // The form is gone, and focus followed the content instead of falling to <body>.
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign in" })).toHaveFocus();
    // Still no chrome — signing in does not put this screen inside the shell (the router does).
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });

  it("sends an already-enrolled owner to the back office instead", async () => {
    const user = userEvent.setup();
    renderLogin(fakeClient({ aal: "aal2" }));
    await waitFor(() => expect(screen.getByLabelText("E-mail")).toBeInTheDocument());
    await user.type(screen.getByLabelText("E-mail"), "owner@example.test");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const next = await screen.findByRole("link", { name: "Users and roles" });
    expect(next).toHaveAttribute("href", "/admin/users");
  });

  it("translates a failed sign-in instead of quoting the server's English", async () => {
    // spec:2061. The brief asserted the raw `"Invalid login credentials"` on screen; that is the
    // defect, not the contract — an Arabic operator can never be shown an English sentence no
    // catalogue owns. The review's I2 supersedes the brief here.
    const user = userEvent.setup();
    renderLogin(
      fakeClient({
        signInError: { message: "Invalid login credentials", code: "invalid_credentials" },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("E-mail")).toBeInTheDocument());
    await user.type(screen.getByLabelText("E-mail"), "owner@example.test");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That e-mail and password did not match an account.");
    expect(alert).not.toHaveTextContent("Invalid login credentials");
  });

  it("falls back to the catalogue's generic sentence for a code it does not map", async () => {
    const user = userEvent.setup();
    renderLogin(fakeClient({ signInError: { message: "Database error granting user" } }));
    await waitFor(() => expect(screen.getByLabelText("E-mail")).toBeInTheDocument());
    await user.type(screen.getByLabelText("E-mail"), "owner@example.test");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That e-mail and password did not match an account.");
    expect(alert).not.toHaveTextContent("Database error");
  });

  it("warns the operator when the sign-in could not be stored securely", async () => {
    // The visible half of the refusal. Without it the token silently lives for one run and the
    // operator discovers it at the next launch, signed out with no explanation.
    const store = electronSessionStore(refusingBridge());
    renderLogin(fakeClient(), store);
    await waitFor(() => expect(screen.getByLabelText("E-mail")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The refusal happens when supabase-js persists the session; simulated here because this
    // test's client is a fake that never touches the store.
    await store.setItem("sb-project-auth-token", SECRET);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This computer cannot store your sign-in securely",
      ),
    );
  });
});

describe("the next-step link survives the click (concern 1)", () => {
  it("moves to enrolment without a document navigation", async () => {
    // A plain `<a href>` is a full document navigation: the renderer reloads and the JS heap goes
    // with it — and where the keyring refused, that heap holds the only copy of the session. The
    // operator would be signed out by the one click they are told to make. A TanStack `<Link>`
    // transitions in place, which is what this proves: the MFA screen renders at all.
    const user = userEvent.setup();
    const store = electronSessionStore(refusingBridge());
    await store.setItem("sb-project-auth-token", SECRET);
    const router = renderApp(fakeClient({ signedIn: true, aal: "aal1" }), "/login", store);
    await user.click(await screen.findByRole("link", { name: "Set up two-factor authentication" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/mfa"));
    expect(await screen.findByLabelText("Six-digit code")).toBeInTheDocument();
    // The session the keyring refused is still here, because nothing was torn down.
    await expect(store.getItem("sb-project-auth-token")).resolves.toBe(SECRET);
  });
});

describe("MfaEnrolRoute", () => {
  it("enrols a TOTP factor at aal1 and verifies the six digits (spec:2317)", async () => {
    const user = userEvent.setup();
    const client = fakeClient({ signedIn: true, aal: "aal1" });
    renderMfa(client);
    await waitFor(() =>
      expect(client.auth.mfa.enroll).toHaveBeenCalledWith({ factorType: "totp" }),
    );
    expect(screen.getByAltText("QR code for your authenticator app")).toBeInTheDocument();
    // spec:2252 — the secret is what makes enrolment possible without sight, or without a second
    // device to photograph the screen with.
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Six-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
        factorId: "factor-1",
        code: "123456",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Two-factor authentication is on.");
    expect(screen.queryByLabelText("Six-digit code")).not.toBeInTheDocument();
  });

  it("enrols exactly once under StrictMode, so no orphan factor is minted per mount", async () => {
    const client = fakeClient({ signedIn: true, aal: "aal1" });
    renderMfa(client);
    await waitFor(() => expect(client.auth.mfa.enroll).toHaveBeenCalled());
    expect(client.auth.mfa.enroll).toHaveBeenCalledTimes(1);
    expect(client.auth.mfa.listFactors).toHaveBeenCalledTimes(1);
  });

  it("challenges a returning owner who already has a verified factor, never re-enrols", async () => {
    // Every session after the first arrives here at `aal1` with a factor already verified. Enrolling
    // again would show a fresh QR the operator must re-scan just to get in, and would leave another
    // unverified factor on the server every visit.
    const user = userEvent.setup();
    const client = fakeClient({
      signedIn: true,
      aal: "aal1",
      factors: [{ id: "factor-existing", verified: true }],
    });
    renderMfa(client);
    expect(await screen.findByLabelText("Six-digit code")).toBeInTheDocument();
    expect(client.auth.mfa.enroll).not.toHaveBeenCalled();
    expect(screen.queryByAltText("QR code for your authenticator app")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Two-factor authentication" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Six-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
        factorId: "factor-existing",
        code: "123456",
      }),
    );
  });

  it("clears abandoned unverified factors before enrolling a fresh one", async () => {
    const client = fakeClient({
      signedIn: true,
      aal: "aal1",
      factors: [
        { id: "orphan-1", verified: false },
        { id: "orphan-2", verified: false },
      ],
    });
    renderMfa(client);
    await waitFor(() => expect(client.auth.mfa.enroll).toHaveBeenCalled());
    expect(client.auth.mfa.unenroll.mock.calls.map((call) => call[0])).toEqual([
      { factorId: "orphan-1" },
      { factorId: "orphan-2" },
    ]);
  });

  it("translates a rejected code instead of quoting the server's English", async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      signedIn: true,
      aal: "aal1",
      verifyError: { message: "Invalid TOTP code entered", code: "mfa_verification_failed" },
    });
    renderMfa(client);
    await waitFor(() => expect(client.auth.mfa.enroll).toHaveBeenCalled());
    await user.type(screen.getByLabelText("Six-digit code"), "000000");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That code did not match.");
    expect(alert).not.toHaveTextContent("Invalid TOTP code entered");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Six-digit code")).toBeInTheDocument();
  });

  it("reports a dead network as a transport failure, never as a wrong code", async () => {
    // `auth.mfa.failed` says "That code did not match" — telling an operator their code is wrong
    // before they have typed one. A boot-path failure gets its own sentence.
    const client = fakeClient({ signedIn: true, aal: "aal1", listFactorsRejects: true });
    renderMfa(client);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Two-factor authentication could not be set up just now.");
    expect(alert).not.toHaveTextContent("That code did not match");
  });

  it("never shows challenge copy to a first-time enroller while the branch is unknown", async () => {
    // `enrolling` used to start false, so between mount and `listFactors` answering, someone
    // enrolling for the first time was asked for six digits they could not possibly have.
    const gate = deferred<{ data: { all: never[]; totp: never[] }; error: null }>();
    const client = fakeClient({ signedIn: true, aal: "aal1" });
    client.auth.mfa.listFactors.mockImplementation(() => gate.promise);
    renderMfa(client);

    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(
      screen.queryByText("Enter the six digits your authenticator app is showing."),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "Two-factor authentication" })).toBeNull();
    expect(screen.queryByLabelText("Six-digit code")).toBeNull();

    gate.resolve({ data: { all: [], totp: [] }, error: null });
    // …and once the branch is known it is the setup copy, not the challenge copy.
    expect(await screen.findByAltText("QR code for your authenticator app")).toBeInTheDocument();
    expect(
      screen.queryByText("Enter the six digits your authenticator app is showing."),
    ).toBeNull();
  });

  it("offers a retry after a boot failure, without leaving the route", async () => {
    // The StrictMode latch would otherwise hold for the life of the route: an operator who hit a
    // flat network had to navigate away and back.
    const user = userEvent.setup();
    const client = fakeClient({ signedIn: true, aal: "aal1" });
    client.auth.mfa.listFactors.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderMfa(client);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Two-factor authentication could not be set up just now.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByAltText("QR code for your authenticator app")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a connection that drops mid-submit as unavailable, not as a wrong code", async () => {
    // The same defect as the boot path, on the other side of the screen. auth-js builds
    // `AuthRetryableFetchError` with its `code` argument `undefined` (`lib/errors.js`), so a
    // transport failure has no code to map — unlike a real rejection, which carries
    // `mfa_verification_failed`. That is the discriminator, and it is why the fallback may differ.
    const user = userEvent.setup();
    const client = fakeClient({ signedIn: true, aal: "aal1" });
    client.auth.mfa.challengeAndVerify.mockRejectedValue(new TypeError("Failed to fetch"));
    renderMfa(client);
    await screen.findByLabelText("Six-digit code");
    await user.type(screen.getByLabelText("Six-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Two-factor authentication could not be set up just now.");
    expect(alert).not.toHaveTextContent("That code did not match");
  });

  it("reports a codeless error return the same way, since that is the shape auth-js returns", async () => {
    // supabase-js hands transport failures back as an `error` value rather than throwing, so the
    // resolved-with-a-codeless-error shape is the one production actually takes.
    const user = userEvent.setup();
    const client = fakeClient({ signedIn: true, aal: "aal1" });
    client.auth.mfa.challengeAndVerify.mockResolvedValue({
      data: null,
      error: { message: "Failed to fetch" },
    });
    renderMfa(client);
    await screen.findByLabelText("Six-digit code");
    await user.type(screen.getByLabelText("Six-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Two-factor authentication could not be set up just now.");
    expect(alert).not.toHaveTextContent("That code did not match");
  });

  it("surfaces a refused unenroll instead of enrolling beside a live factor", async () => {
    // The case that matters: a factor verified on another device between the list and the unenroll
    // is refused server-side (a verified factor needs `aal2`; an enroller has `aal1`). Carrying on
    // would mint a second factor beside one the operator is already using.
    const client = fakeClient({
      signedIn: true,
      aal: "aal1",
      factors: [{ id: "orphan-1", verified: false }],
    });
    client.auth.mfa.unenroll.mockResolvedValue({
      data: null,
      error: { message: "AAL2 required to unenroll a verified factor", code: "insufficient_aal" },
    });
    renderMfa(client);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Two-factor authentication could not be set up just now.",
    );
    expect(client.auth.mfa.enroll).not.toHaveBeenCalled();
  });

  it("re-lists on retry, so a factor verified elsewhere lands on the challenge branch", async () => {
    // The self-healing half of the refusal above: the retry is not a blind repeat, it asks again.
    const user = userEvent.setup();
    const client = fakeClient({
      signedIn: true,
      aal: "aal1",
      factors: [{ id: "factor-existing", verified: true }],
    });
    client.auth.mfa.listFactors.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderMfa(client);
    await screen.findByRole("button", { name: "Try again" });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Six-digit code")).toBeInTheDocument();
    expect(client.auth.mfa.enroll).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Two-factor authentication" })).toBeInTheDocument();
  });
});

const emptyList = () =>
  new Response(JSON.stringify({ items: [], next_cursor: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const refusal = (code: string, status: number) =>
  new Response(
    JSON.stringify({
      type: `urn:dulja:error:${code}`,
      title: "Refused",
      status,
      detail: "detail",
      instance: "/v1/me/companies",
      code,
      remedy: "remedy",
      requestId: "req-1",
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );

/** Only `GET /v1/me/companies` misbehaves, so what the screen does is `useCompanyId`'s doing alone. */
const stubFetch = (companies: Response) => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      // `endsWith`, not `includes`: `/v1/companies/{companyId}/role-assignments` is a different
      // endpoint that happens to begin with this one's path.
      if (path.endsWith("/v1/me/companies")) return companies.clone();
      if (path.includes("/v1/admin/")) return emptyList();
      throw new Error(`unexpected fetch: ${path}`);
    }),
  );
};

const signedInAtAal2 = () =>
  fakeClient({ signedIn: true, aal: "aal2", factors: [{ id: "factor-1", verified: true }] });

/** Enough of 0B's real shapes for the screen to render a row and a role, as `UserList`/`RoleList`
 *  and `CompanyList` accept them — v7 UUIDs included, since `UuidSchema` rejects anything else. */
const COMPANY_ID = "0192cccc-0001-7000-8000-000000000001";
const PRINCIPAL_ID = "0192aaaa-0001-7000-8000-000000000001";
const ROLE_ID = "0192bbbb-0001-7000-8000-000000000001";

const listed = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const ONE_COMPANY = {
  companies: [{ id: COMPANY_ID, code: "ACME", name: "Acme", branches: [] }],
};
const ONE_USER = {
  items: [
    {
      id: PRINCIPAL_ID,
      displayName: "Aisha",
      email: "aisha@example.test",
      kind: "human",
      createdAt: "2026-01-15T02:00:00Z",
      activeAssignments: 1,
    },
  ],
  next_cursor: null,
};
const ONE_ROLE = {
  items: [
    {
      id: ROLE_ID,
      code: "accountant",
      nameEn: "Accountant",
      nameAr: "محاسب",
      description: null,
      isSystem: true,
      permissions: ["admin.audit_log.read"],
      createdAt: "2026-01-01T00:00:00Z",
    },
  ],
  next_cursor: null,
};

/** A probe for `useCompanyId` alone, with no screen around it. */
function CompanyProbe() {
  return <p>company:{useCompanyId()}</p>;
}

describe("the users screen's live wiring", () => {
  // The only tests that drive `UsersScreen` and `useCompanyId` as the app actually builds them:
  // no injected `fetchImpl`, so the screen's three `/v1` requests go through the global `fetch`.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the company for an accountant who lacks admin.company.manage (UI-03, ADR 0089)", async () => {
    // The seeded accountant and auditor are refused `GET /v1/companies`; the membership-scoped lookup answers them.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v1/companies") return refusal("ERR_RBAC_FORBIDDEN", 403);
        if (path === "/v1/me/companies")
          return listed({
            companies: [{ id: COMPANY_ID, code: "ACME", name: "Acme", branches: [] }],
          });
        throw new Error(`unexpected fetch: ${path}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionProvider client={signedInAtAal2()} store={browserSessionStore}>
          <RouterAround>
            <CompanyProbe />
          </RouterAround>
        </SessionProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(`company:${COMPANY_ID}`)).toBeInTheDocument();
  });

  it("routes to enrolment when the company lookup is refused for assurance", async () => {
    // `useCompanyId` used to destructure `data` alone, so this answered "the company is not known"
    // — true about the screen, and nothing true about the operator's session.
    stubFetch(refusal("ERR_AUTH_AAL_INSUFFICIENT", 401));
    const router = renderApp(signedInAtAal2(), "/admin/users");
    await waitFor(() => expect(router.state.location.pathname).toBe("/mfa"));
  });

  it("asks for nothing until the provider has a token, so a cold boot cannot sign anyone out", async () => {
    // The route guard's `getSession()` and the provider's are two independent reads of the same
    // client, so this hook can render while `accessToken` is still null. That request would go out
    // unauthenticated, be answered 401, and — since a refused token is answered by signing out —
    // eject the operator in the middle of their own boot.
    const gate = deferred<{ data: { session: typeof SESSION }; error: null }>();
    const client = fakeClient({ signedIn: true, aal: "aal2" });
    client.auth.getSession.mockImplementation(() => gate.promise);
    const fetchSpy = vi.fn<typeof fetch>(async () => listed(ONE_COMPANY));
    vi.stubGlobal("fetch", fetchSpy);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionProvider client={client} store={browserSessionStore}>
          <RouterAround>
            <CompanyProbe />
          </RouterAround>
        </SessionProvider>
      </QueryClientProvider>,
    );
    // A turn of the event loop: long enough for an ungated query to have gone out.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).not.toHaveBeenCalled();

    gate.resolve({ data: { session: SESSION }, error: null });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer jwt",
    });
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("signs out when the token dies after the company lookup has already succeeded", async () => {
    // The reason this decision lives with the lookup rather than in the screen: a screen that
    // navigated on its own would cover only refusals that arrive while it is mounting. Here the
    // lookup has long since succeeded — the screen is rendered and usable — and the token dies
    // afterwards. The screen surfaces the refusal and re-runs the lookup, which is refused too, and
    // the owner answers once.
    const user = userEvent.setup();
    let tokenAlive = true;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        const path = String(url);
        // Ordered before the lookup, and matched exactly there: the assignment endpoint is
        // `/v1/companies/{companyId}/role-assignments`, so a loose `includes("/v1/companies")`
        // answers the POST with a company list.
        if (path.includes("/role-assignments")) {
          tokenAlive = false; // the token expires between the lookup and this submit
          return refusal("ERR_AUTH_TOKEN_INVALID", 401);
        }
        if (path.endsWith("/v1/me/companies"))
          return tokenAlive ? listed(ONE_COMPANY) : refusal("ERR_AUTH_TOKEN_INVALID", 401);
        if (path.includes("/v1/admin/users")) return listed(ONE_USER);
        if (path.includes("/v1/admin/roles")) return listed(ONE_ROLE);
        throw new Error(`unexpected fetch: ${path}`);
      }),
    );
    const client = signedInAtAal2();
    const router = renderApp(client, "/admin/users");

    // The lookup succeeded: the screen is rendered, and assignment is available rather than
    // disabled for an unknown company.
    expect(await screen.findByText("aisha@example.test")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Assigning a role is unavailable until the company for this account is known.",
      ),
    ).not.toBeInTheDocument();
    expect(client.auth.signOut).not.toHaveBeenCalled();

    await user.click(screen.getByText("aisha@example.test"));
    await user.keyboard("{Enter}");
    await user.selectOptions(screen.getByLabelText("Assign role"), ROLE_ID);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(client.auth.signOut).toHaveBeenCalled());
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("signs out whichever request discovers the dead token first", async () => {
    // All three requests carry the same token and go out together, so which answers first is
    // effectively random. When the user list answered first, the screen used to navigate to
    // `/login` itself: that unmounted the one place holding the session, aborted the company
    // lookup through its `signal`, and the operator landed on `/login` still signed in, looking at
    // a link straight back to the screen that had just refused them — and the guard on that link
    // asks the local Supabase session, not `/v1`, so it leads back to the same 401.
    let releaseCompanies: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseCompanies = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        const path = String(url);
        if (path.endsWith("/v1/me/companies")) {
          await held; // the list wins the race
          return refusal("ERR_AUTH_TOKEN_INVALID", 401);
        }
        if (path.includes("/v1/admin/")) return refusal("ERR_AUTH_TOKEN_INVALID", 401);
        throw new Error(`unexpected fetch: ${path}`);
      }),
    );
    const client = signedInAtAal2();
    const router = renderApp(client, "/admin/users");

    // The screen surfaces the refusal and stays where it is…
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/admin/users");
    expect(client.auth.signOut).not.toHaveBeenCalled();

    // …so the company lookup is still alive to be refused, and the owner answers once.
    releaseCompanies?.();
    await waitFor(() => expect(client.auth.signOut).toHaveBeenCalled());
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("reaches sign-in even when the sign-out itself fails, and handles the rejection", async () => {
    // A rejected sign-out is not a reason to strand the operator on a screen where every request is
    // refused — and an unhandled rejection is not a way to report one. `.finally` alone would still
    // navigate, so the second half is what the node-level listener below is here to catch.
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      stubFetch(refusal("ERR_AUTH_TOKEN_INVALID", 401));
      const client = signedInAtAal2();
      client.auth.signOut.mockRejectedValue(new TypeError("the sign-out request failed"));
      const router = renderApp(client, "/admin/users");
      await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
      // Node flags a rejection as unhandled once the microtask queue has drained; the waits above
      // have drained it many times over, so an empty list here is a real answer.
      expect(
        unhandled.filter((reason) => String(reason).includes("the sign-out request failed")),
      ).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("signs out and routes to sign-in when the company lookup is refused for the token", async () => {
    // Landing on `/login` with a client that still believes it is signed in would show the operator
    // a link straight back to the screen that just refused them.
    stubFetch(refusal("ERR_AUTH_TOKEN_INVALID", 401));
    const client = signedInAtAal2();
    const router = renderApp(client, "/admin/users");
    await waitFor(() => expect(client.auth.signOut).toHaveBeenCalled());
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("stays on the screen when the company lookup is merely forbidden", async () => {
    // `admin.company.manage` is a different gate from `admin.user.manage`: an operator who holds
    // only the latter still gets the list, and the screen says why assignment is unavailable.
    stubFetch(refusal("ERR_RBAC_FORBIDDEN", 403));
    const client = signedInAtAal2();
    const router = renderApp(client, "/admin/users");
    expect(
      await screen.findByText(
        "Assigning a role is unavailable until the company for this account is known.",
      ),
    ).toBeInTheDocument();
    // The strongest signal, and an immediate one: the owner calls `signOut` the moment it decides,
    // so this fails before any navigation would have had time to land.
    expect(client.auth.signOut).not.toHaveBeenCalled();
    // And a turn of the event loop for a navigation that must not be in flight either.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.state.location.pathname).toBe("/admin/users");
  });
});

describe("cold boot", () => {
  it("shows a loading state rather than a blank document while a guard resolves", async () => {
    const gate = deferred<{ data: { session: typeof SESSION }; error: null }>();
    const client = fakeClient({ signedIn: true, aal: "aal2" });
    client.auth.getSession.mockImplementation(() => gate.promise);
    renderApp(client, "/admin/users");
    // The router waits `defaultPendingMs` before showing this, so it is awaited rather than read.
    expect(await screen.findByText("Loading…", {}, { timeout: 2000 })).toBeInTheDocument();
    gate.resolve({ data: { session: SESSION }, error: null });
    expect(await screen.findByRole("navigation")).toBeInTheDocument();
  });
});
