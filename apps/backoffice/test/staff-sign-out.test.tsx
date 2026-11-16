import type { SupabaseClient } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StaffContextPicker } from "../src/components/staff-context";
import { StaffFailure } from "../src/components/staff-failure";
import { I18nProvider } from "../src/lib/i18n-provider";
import { ApiError } from "../src/lib/problem";
import { SessionProvider } from "../src/lib/session";
import { memorySessionStore } from "../src/lib/session-storage";
import { RouterAround } from "./support/router";

/**
 * A refused token on a staff screen must end the local session before `/login`, as `useCompanyId` does: landing
 * on `/login` with a client that still believes it is signed in offers a link straight back to the refused screen.
 */
function signedInClient() {
  const signOut = vi.fn(async () => ({ error: null }));
  const client = {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "jwt", user: { email: "staff@example.test" } } },
        error: null,
      })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut,
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal2", nextLevel: "aal2" },
          error: null,
        })),
      },
    },
  } as unknown as SupabaseClient;
  return { client, signOut };
}
const unauthorized = new ApiError({
  type: "urn:dulja:error:ERR_AUTH_TOKEN_INVALID",
  title: "Unauthorized",
  status: 401,
  code: "ERR_AUTH_TOKEN_INVALID",
  detail: "token expired",
  instance: "/v1/staff-context",
  remedy: "Sign in again.",
  requestId: "req-1",
});
function mount(client: SupabaseClient, ui: React.ReactNode) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider client={client} store={memorySessionStore()}>
        <I18nProvider store={{ read: () => "en", write: () => undefined }}>
          <RouterAround>{ui}</RouterAround>
        </I18nProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}
describe("staff screens sign out on a refused token", () => {
  it("StaffFailure ends the session before routing to /login", async () => {
    const { client, signOut } = signedInClient();
    mount(client, <StaffFailure cause={unauthorized} />);
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });
  it("StaffContextPicker ends the session when the staff context answers 401", async () => {
    const { client, signOut } = signedInClient();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            type: "urn:dulja:error:ERR_AUTH_TOKEN_INVALID",
            title: "Unauthorized",
            status: 401,
            code: "ERR_AUTH_TOKEN_INVALID",
            detail: "token expired",
            instance: "/v1/staff-context",
          }),
          { status: 401, headers: { "content-type": "application/problem+json" } },
        ),
    );
    mount(
      client,
      <StaffContextPicker
        api={{ baseUrl: "https://example.test", accessToken: () => "jwt", fetchImpl }}
      >
        {() => null}
      </StaffContextPicker>,
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });
});
