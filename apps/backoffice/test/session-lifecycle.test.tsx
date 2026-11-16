import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { AppShell } from "../src/components/app-shell";
import { useAttemptKeys } from "../src/features/reports/shared";
import { createAdminApi } from "../src/lib/admin-api";
import { I18nProvider } from "../src/lib/i18n-provider";
import { ApiError, internalProblem } from "../src/lib/problem";
import { SessionProvider } from "../src/lib/session";
import { UsersRoute } from "../src/routes/admin/users";
import { createAppRouter } from "../src/router";
import { RouterAround } from "./support/router";

/**
 * The 2026-11-15 review's back-office session findings (UI-01, UI-04, UI-07, UI-08, UI-09, UI-12, UI-13,
 * UI-21), each driven through the real route tree and the real `SessionProvider` where it can be.
 */

const COMPANY = "0192cccc-0001-7000-8000-000000000001";
const BRANCH = "0192aaaa-0001-7000-8000-000000000001";
const session = (token: string, userId = "user-a") => ({
  access_token: token,
  user: { id: userId, email: `${userId}@example.test` },
});

type AuthListener = (event: string, value: ReturnType<typeof session> | null) => void;

interface FakeAuth {
  client: SupabaseClient;
  emit: AuthListener;
  signOut: Mock;
  refreshSession: Mock;
}

const ignoreAuthEvent: AuthListener = () => {};

function fakeAuth(): FakeAuth {
  let listener: AuthListener = ignoreAuthEvent;
  const signOut = vi.fn(async () => {
    listener("SIGNED_OUT", null);
    return { error: null };
  });
  const refreshSession = vi.fn(async () => ({
    data: { session: null },
    error: { message: "Invalid Refresh Token", code: "refresh_token_not_found", status: 400 },
  }));
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: session("jwt-1") }, error: null })),
      onAuthStateChange: vi.fn((callback: AuthListener) => {
        listener = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signOut,
      refreshSession,
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal2", nextLevel: "aal2" },
          error: null,
        })),
      },
    },
  } as unknown as SupabaseClient;
  return { client, emit: (event, value) => listener(event, value), signOut, refreshSession };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const problem = (code: string, status: number) =>
  new Response(
    JSON.stringify({
      type: `urn:dulja:error:${code}`,
      title: "Refused",
      status,
      detail: "refused",
      instance: "/v1",
      code,
      remedy: "Retry.",
      requestId: "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000",
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );

const STAFF_CONTEXT = {
  companies: [
    {
      id: COMPANY,
      code: "MY",
      name: "Company",
      baseCurrency: "MYR",
      branches: [{ id: BRANCH, code: "HQ", nameEn: "Head office", nameAr: "المقر الرئيسي" }],
    },
  ],
};
const POLICY = {
  id: BRANCH,
  branchId: BRANCH,
  maxLineDiscountPct: "0.150000",
  maxTicketDiscountPct: "0.100000",
  maxVoidAmount: "100.0000",
  maxPriceOverridePct: "0.050000",
  blindReturnAllowed: false,
  maxBlindReturnAmount: "50.0000",
  maxCashInDrawer: null,
  requireCustomerOver: "1000.0000",
  roundingIncrement: "0.0500",
  paidOutAllowed: false,
  maxPaidOutAmount: "0.0000",
  revision: "9007199254740993",
};

function renderApp(auth: FakeAuth, path: string, queryClient = new QueryClient()) {
  const router = createAppRouter(auth.client, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider client={auth.client}>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

const bearer = (init: RequestInit | undefined) =>
  ((init?.headers ?? {}) as Record<string, string>)["authorization"];

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UI-01 — a token refresh does not remount the open screen", () => {
  it("keeps a half-typed branch limit and does not refetch when Supabase refreshes the token", async () => {
    const auth = fakeAuth();
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/staff-context")) return json(STAFF_CONTEXT);
      return json({ items: [POLICY], next_cursor: null });
    });
    vi.stubGlobal("fetch", fetchSpy);
    renderApp(auth, "/pos/branch-limits");
    const user = userEvent.setup();
    const line = await screen.findByLabelText("Maximum line discount (%)");
    await user.clear(line);
    await user.type(line, "12.3456");
    const before = fetchSpy.mock.calls.length;

    act(() => auth.emit("TOKEN_REFRESHED", session("jwt-2")));

    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = screen.getByLabelText("Maximum line discount (%)");
    expect(after).toBe(line);
    expect(after).toHaveValue("12.3456");
    expect(fetchSpy.mock.calls.length).toBe(before);
  });

  it("sends the refreshed token on the next request without remounting", async () => {
    const auth = fakeAuth();
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/staff-context")) return json(STAFF_CONTEXT);
      if (url.includes("/pos-policies") || url.includes("policies"))
        return json({ items: [POLICY], next_cursor: null });
      return json({ items: [], next_cursor: null });
    });
    vi.stubGlobal("fetch", fetchSpy);
    renderApp(auth, "/pos/branch-limits");
    await screen.findByLabelText("Maximum line discount (%)");
    act(() => auth.emit("TOKEN_REFRESHED", session("jwt-2")));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true),
    );
    const put = fetchSpy.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(bearer(put[1])).toBe("Bearer jwt-2");
  });
});

describe("UI-04 — the shell offers a way to sign out", () => {
  it.each([
    ["en", "Sign out"],
    ["ar", "تسجيل الخروج"],
  ] as const)("renders a keyboard-reachable sign-out button in %s", async (locale, label) => {
    const auth = fakeAuth();
    render(
      <I18nProvider store={{ read: () => locale, write: () => undefined }}>
        <SessionProvider client={auth.client}>
          <RouterAround>
            <AppShell>
              <p>content</p>
            </AppShell>
          </RouterAround>
        </SessionProvider>
      </I18nProvider>,
    );
    const button = await screen.findByRole("button", { name: label });
    button.focus();
    expect(button).toHaveFocus();
  });

  it("signs out of this device only, clears the cache and lands on /login", async () => {
    const auth = fakeAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) =>
        String(input).endsWith("/v1/staff-context")
          ? json(STAFF_CONTEXT)
          : json({ items: [POLICY], next_cursor: null }),
      ),
    );
    const { router, queryClient } = renderApp(auth, "/pos/branch-limits");
    await screen.findByLabelText("Maximum line discount (%)");
    expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .filter((q) => q.state.data !== undefined),
    ).toEqual([]);
  });
});

function mountProvider(auth: FakeAuth) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["users"], { items: ["user A's list"] });
  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider client={auth.client}>
        <p>app</p>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("UI-07 — the query cache does not survive a change of user", () => {
  it("keeps the cache across a token refresh for the same principal", async () => {
    const auth = fakeAuth();
    const queryClient = mountProvider(auth);
    await waitFor(() => expect(auth.client.auth.getSession).toHaveBeenCalled());
    act(() => auth.emit("SIGNED_IN", session("jwt-1")));
    queryClient.setQueryData(["users"], { items: ["user A's list"] });
    act(() => auth.emit("TOKEN_REFRESHED", session("jwt-2")));
    expect(queryClient.getQueryData(["users"])).toEqual({ items: ["user A's list"] });
  });

  it("clears the cache when another principal signs in", async () => {
    const auth = fakeAuth();
    const queryClient = mountProvider(auth);
    await waitFor(() => expect(auth.client.auth.getSession).toHaveBeenCalled());
    act(() => auth.emit("SIGNED_IN", session("jwt-1")));
    queryClient.setQueryData(["users"], { items: ["user A's list"] });
    act(() => auth.emit("SIGNED_IN", session("jwt-b", "user-b")));
    expect(queryClient.getQueryData(["users"])).toBeUndefined();
  });

  it("clears the cache on sign-out", async () => {
    const auth = fakeAuth();
    const queryClient = mountProvider(auth);
    await waitFor(() => expect(auth.client.auth.getSession).toHaveBeenCalled());
    act(() => auth.emit("SIGNED_IN", session("jwt-1")));
    queryClient.setQueryData(["users"], { items: ["user A's list"] });
    act(() => auth.emit("SIGNED_OUT", null));
    expect(queryClient.getQueryData(["users"])).toBeUndefined();
  });
});

describe("UI-07 — a refused list does not keep showing the rows it showed before", () => {
  it("drops the cached user list once a refetch is refused", async () => {
    let refused = false;
    const users = {
      items: [
        {
          id: "0192aaaa-0001-7000-8000-000000000001",
          displayName: "Aisha",
          email: "aisha@example.test",
          kind: "human",
          createdAt: "2026-01-15T02:00:00Z",
          activeAssignments: 2,
        },
      ],
      next_cursor: null,
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("/v1/admin/roles")) return json({ items: [], next_cursor: null });
      return refused ? problem("ERR_RBAC_FORBIDDEN", 403) : json(users);
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = { baseUrl: "https://api.example.test", accessToken: () => "jwt", fetchImpl };
    render(
      <I18nProvider store={{ read: () => "en", write: () => undefined }}>
        <QueryClientProvider client={queryClient}>
          <RouterAround>
            <UsersRoute api={api} companyId={COMPANY} />
          </RouterAround>
        </QueryClientProvider>
      </I18nProvider>,
    );
    await screen.findByText("aisha@example.test");
    refused = true;
    await act(() => queryClient.refetchQueries({ queryKey: ["users"] }));
    await screen.findByRole("alert");
    expect(screen.queryByText("aisha@example.test")).not.toBeInTheDocument();
  });
});

describe("UI-08 — a 401 refreshes once and retries before anyone is signed out", () => {
  it("retries a refused request once with the refreshed token and the same idempotency key", async () => {
    const tokens = ["stale", "fresh"];
    let token = tokens[0]!;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(problem("ERR_AUTH_TOKEN_INVALID", 401))
      .mockResolvedValueOnce(json({ ok: true }, 201));
    const refreshAccessToken = vi.fn(async () => {
      token = tokens[1]!;
      return token;
    });
    const api = createAdminApi({
      baseUrl: "https://api.example.test",
      accessToken: () => token,
      refreshAccessToken,
      fetchImpl,
    });
    const { z } = await import("zod");
    await expect(
      api.send("POST", "/v1/x", { a: 1 }, z.object({ ok: z.boolean() }), {
        idempotencyKey: "k-1",
      }),
    ).resolves.toEqual({ ok: true });
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [first, second] = fetchImpl.mock.calls;
    expect(bearer(first![1])).toBe("Bearer stale");
    expect(bearer(second![1])).toBe("Bearer fresh");
    expect((second![1]!.headers as Record<string, string>)["idempotency-key"]).toBe("k-1");
  });

  it("does not refresh for an assurance refusal, and gives up after one failed refresh", async () => {
    const { z } = await import("zod");
    const refreshAccessToken = vi.fn(async () => null);
    const aal = createAdminApi({
      baseUrl: "https://api.example.test",
      accessToken: () => "t",
      refreshAccessToken,
      fetchImpl: vi.fn<typeof fetch>(async () => problem("ERR_AUTH_AAL_INSUFFICIENT", 401)),
    });
    await expect(aal.get("/v1/x", z.unknown())).rejects.toBeInstanceOf(ApiError);
    expect(refreshAccessToken).not.toHaveBeenCalled();

    const fetchImpl = vi.fn<typeof fetch>(async () => problem("ERR_AUTH_TOKEN_INVALID", 401));
    const dead = createAdminApi({
      baseUrl: "https://api.example.test",
      accessToken: () => "t",
      refreshAccessToken,
      fetchImpl,
    });
    await expect(dead.get("/v1/x", z.unknown())).rejects.toBeInstanceOf(ApiError);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the operator signed in when an expired token can be refreshed", async () => {
    const auth = fakeAuth();
    auth.refreshSession.mockImplementation(async () => {
      const fresh = session("jwt-2");
      auth.emit("TOKEN_REFRESHED", fresh);
      return { data: { session: fresh }, error: null };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (bearer(init) !== "Bearer jwt-2") return problem("ERR_AUTH_TOKEN_INVALID", 401);
        if (String(input).endsWith("/v1/staff-context")) return json(STAFF_CONTEXT);
        return json({ items: [POLICY], next_cursor: null });
      }),
    );
    const { router } = renderApp(auth, "/pos/branch-limits");
    await screen.findByLabelText("Maximum line discount (%)");
    expect(router.state.location.pathname).toBe("/pos/branch-limits");
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("signs out of this device only when the refresh itself is refused", async () => {
    const auth = fakeAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => problem("ERR_AUTH_TOKEN_INVALID", 401)),
    );
    const { router } = renderApp(auth, "/pos/branch-limits");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(auth.signOut).toHaveBeenCalled();
    for (const call of auth.signOut.mock.calls) expect(call[0]).toEqual({ scope: "local" });
  });
});

const failure = (status: number, code = "ERR_INTERNAL") =>
  new ApiError({
    ...internalProblem({ instance: "/v1/x", diagnostic: "x", status, requestId: "" }),
    code: code as never,
  });

describe("UI-09 and UI-12 — which answers keep an attempt's idempotency key", () => {
  it.each([
    ["a transport failure (status 0)", failure(0)],
    ["408", failure(408)],
    ["429", failure(429)],
    ["409 ERR_IDEMPOTENCY_IN_FLIGHT", failure(409, "ERR_IDEMPOTENCY_IN_FLIGHT")],
    ["a gateway 503", failure(503)],
  ])("keeps the key after %s", (_label, cause) => {
    const { result } = renderHook(() => useAttemptKeys());
    const first = result.current.key("g");
    result.current.settle("g", cause);
    expect(result.current.key("g")).toBe(first);
  });

  it.each([
    ["success", undefined],
    ["a recorded 409 refusal", failure(409, "ERR_IDEMPOTENCY_KEY_REUSED")],
    ["a recorded 422", failure(422, "ERR_VALIDATION")],
    ["a recorded 500", failure(500)],
  ])("releases the key after %s", (_label, cause) => {
    const { result } = renderHook(() => useAttemptKeys());
    const first = result.current.key("g");
    result.current.settle("g", cause);
    expect(result.current.key("g")).not.toBe(first);
  });
});

describe("UI-13 — the employee directory on a refusal", () => {
  it("routes a dead session to /login instead of showing an error beside an empty list", async () => {
    const auth = fakeAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) =>
        String(input).endsWith("/v1/staff-context")
          ? json(STAFF_CONTEXT)
          : problem("ERR_AUTH_TOKEN_INVALID", 401),
      ),
    );
    const { router } = renderApp(auth, "/hr/employees");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("shows a 403 alone, with a retry, and never 'No employees found' beside it", async () => {
    const auth = fakeAuth();
    let refused = true;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (String(input).endsWith("/v1/staff-context")) return json(STAFF_CONTEXT);
        return refused
          ? problem("ERR_RBAC_FORBIDDEN", 403)
          : json({ items: [], next_cursor: null });
      }),
    );
    renderApp(auth, "/hr/employees");
    await screen.findByRole("alert");
    expect(screen.queryByText("No employees found")).not.toBeInTheDocument();
    refused = false;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No employees found");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shift register: a dead session goes to /login", async () => {
    const auth = fakeAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) =>
        String(input).endsWith("/v1/staff-context")
          ? json(STAFF_CONTEXT)
          : problem("ERR_AUTH_TOKEN_INVALID", 401),
      ),
    );
    const { router } = renderApp(auth, "/pos/shifts");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });
});

describe("UI-21 — a session Supabase ends locally leaves the shell", () => {
  it("navigates to /login when the session ends under an open screen", async () => {
    const auth = fakeAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) =>
        String(input).endsWith("/v1/staff-context")
          ? json(STAFF_CONTEXT)
          : json({ items: [POLICY], next_cursor: null }),
      ),
    );
    const { router } = renderApp(auth, "/pos/branch-limits");
    await screen.findByLabelText("Maximum line discount (%)");
    act(() => auth.emit("SIGNED_OUT", null));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });
});
