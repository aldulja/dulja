import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SessionProvider } from "../src/lib/session";
import { browserSessionStore } from "../src/lib/session-storage";
import { createAppRouter } from "../src/router";

/**
 * PRD-01 / OPS-08 (ADR 0096). A seeded owner has no password and an invited user is sent no
 * password either, so the sign-in screen must let them set one — by a one-time code e-mailed to
 * them and typed into the app, because no e-mailed link can open `dulja://app`.
 */

const EMAIL = "invitee@example.test";
const CODE = "482913";
const PASSWORD = "a long and unguessable passphrase";

type Listener = (event: string, session: unknown) => void;

type FakeClient = SupabaseClient & {
  auth: SupabaseClient["auth"] & {
    resetPasswordForEmail: Mock;
    verifyOtp: Mock;
    updateUser: Mock;
    signInWithOtp: Mock;
    signOut: Mock;
    mfa: { listFactors: Mock; challengeAndVerify: Mock };
  };
};

interface FakeOptions {
  /** The account already has a verified TOTP factor: a forgotten password, not a first one. */
  enrolled?: boolean;
  resetError?: { message: string; code?: string; status?: number };
  verifyError?: { message: string; code?: string; status?: number };
  updateError?: { message: string; code?: string; status?: number };
}

const fakeClient = (options: FakeOptions = {}): FakeClient => {
  const listeners: Listener[] = [];
  let level: "aal1" | "aal2" = "aal1";
  let session: { access_token: string; user: { email: string } } | null = null;
  const emit = (event: string) => {
    for (const listener of listeners) listener(event, session);
  };
  const factors =
    options.enrolled === true ? [{ id: "factor-1", factor_type: "totp", status: "verified" }] : [];
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session }, error: null })),
      onAuthStateChange: vi.fn((listener: Listener) => {
        listeners.push(listener);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signInWithPassword: vi.fn(),
      signInWithOtp: vi.fn(),
      signOut: vi.fn(async () => {
        session = null;
        emit("SIGNED_OUT");
        return { error: null };
      }),
      resetPasswordForEmail: vi.fn(async () =>
        options.resetError === undefined
          ? { data: {}, error: null }
          : { data: null, error: options.resetError },
      ),
      verifyOtp: vi.fn(async () => {
        if (options.verifyError !== undefined)
          return { data: { session: null, user: null }, error: options.verifyError };
        session = { access_token: "jwt-recovery", user: { email: EMAIL } };
        // supabase-js announces a recovery session as PASSWORD_RECOVERY, not SIGNED_IN.
        emit("PASSWORD_RECOVERY");
        return { data: { session, user: session.user }, error: null };
      }),
      updateUser: vi.fn(async () =>
        options.updateError === undefined
          ? { data: { user: { email: EMAIL } }, error: null }
          : { data: { user: null }, error: options.updateError },
      ),
      mfa: {
        listFactors: vi.fn(async () => ({
          data: { all: factors, totp: factors },
          error: null,
        })),
        challengeAndVerify: vi.fn(async () => {
          level = "aal2";
          session = { access_token: "jwt-aal2", user: { email: EMAIL } };
          return { data: session, error: null };
        }),
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: level, nextLevel: "aal2" },
          error: null,
        })),
        enroll: vi.fn(),
        unenroll: vi.fn(),
      },
    },
  } as unknown as FakeClient;
};

const renderApp = (client: SupabaseClient) => {
  const router = createAppRouter(client, createMemoryHistory({ initialEntries: ["/login"] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider client={client} store={browserSessionStore}>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return router;
};

const START = "First time here, or forgot your password?";

/** From the sign-in screen to the code step, by keyboard only. */
const requestCode = async (user: ReturnType<typeof userEvent.setup>) => {
  await waitFor(() => expect(screen.getByLabelText("E-mail")).toHaveFocus());
  screen.getByRole("button", { name: START }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByLabelText("E-mail")).toHaveFocus());
  await user.keyboard(EMAIL);
  await user.keyboard("{Enter}");
};

beforeEach(() => {
  localStorage.clear();
});

describe("setting a first or forgotten password by e-mailed code (PRD-01, ADR 0096)", () => {
  it("offers the step on the sign-in screen", async () => {
    renderApp(fakeClient());
    expect(await screen.findByRole("button", { name: START })).toBeVisible();
  });

  it("takes an invited user from e-mail to a password and on to enrolment, keyboard only", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderApp(client);
    await requestCode(user);

    // A recovery code, never a sign-up: the request must not create an account for a stranger.
    await waitFor(() => expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith(EMAIL));
    expect(client.auth.signInWithOtp).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "If an account uses this address, a one-time code is on its way. Type it below.",
      ),
    ).toBeVisible();

    await waitFor(() =>
      expect(screen.getByLabelText("One-time code from the e-mail")).toHaveFocus(),
    );
    await user.keyboard(` ${CODE} `);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(client.auth.verifyOtp).toHaveBeenCalledWith({
        email: EMAIL,
        token: CODE,
        type: "recovery",
      }),
    );

    await waitFor(() => expect(screen.getByLabelText("New password")).toHaveFocus());
    // No authenticator field for someone who has never enrolled one.
    expect(screen.queryByLabelText("Six-digit code")).toBeNull();
    await user.keyboard(PASSWORD);
    await user.tab();
    expect(screen.getByLabelText("Type the new password again")).toHaveFocus();
    await user.keyboard(PASSWORD);
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(client.auth.updateUser).toHaveBeenCalledWith({ password: PASSWORD }),
    );
    expect(await screen.findByText("Your password is saved.")).toBeVisible();
    // aal1 with no factor: the next step is enrolment, exactly as after a password sign-in.
    expect(
      await screen.findByRole("link", { name: "Set up two-factor authentication" }),
    ).toBeVisible();
    expect(client.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
  });

  it("asks an enrolled user for their authenticator code before the password changes", async () => {
    const user = userEvent.setup();
    const client = fakeClient({ enrolled: true });
    renderApp(client);
    await requestCode(user);
    await waitFor(() =>
      expect(screen.getByLabelText("One-time code from the e-mail")).toHaveFocus(),
    );
    await user.keyboard(CODE);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.getByLabelText("New password")).toHaveFocus());
    await user.keyboard(PASSWORD);
    await user.tab();
    await user.keyboard(PASSWORD);
    await user.tab();
    expect(screen.getByLabelText("Six-digit code")).toHaveFocus();
    await user.keyboard("123456");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(client.auth.updateUser).toHaveBeenCalled());
    expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: "factor-1",
      code: "123456",
    });
    // The e-mailed code alone never changes an enrolled account's password.
    expect(client.auth.mfa.challengeAndVerify.mock.invocationCallOrder[0]).toBeLessThan(
      client.auth.updateUser.mock.invocationCallOrder[0] ?? 0,
    );
    expect(await screen.findByRole("link", { name: "Users and roles" })).toBeVisible();
  });

  it("says the same thing whether or not the address has an account", async () => {
    const user = userEvent.setup();
    // GoTrue answers 200 for an unknown address; the screen must not add a tell of its own.
    renderApp(fakeClient());
    await requestCode(user);
    expect(
      await screen.findByText(
        "If an account uses this address, a one-time code is on its way. Type it below.",
      ),
    ).toBeVisible();
  });

  it("tells the operator to wait when the provider rate-limits the e-mail", async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      resetError: {
        message: "For security purposes, you can only request this after 52 seconds.",
        code: "over_email_send_rate_limit",
        status: 429,
      },
    });
    renderApp(client);
    await requestCode(user);
    expect(
      await screen.findByText("Too many requests. Wait a minute, then try again."),
    ).toBeVisible();
    expect(screen.queryByLabelText("One-time code from the e-mail")).toBeNull();
  });

  it("refuses a wrong or expired code in the catalogue's words", async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      verifyError: { message: "Token has expired or is invalid", code: "otp_expired", status: 403 },
    });
    renderApp(client);
    await requestCode(user);
    await waitFor(() =>
      expect(screen.getByLabelText("One-time code from the e-mail")).toHaveFocus(),
    );
    await user.keyboard(CODE);
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText(
        "That code is wrong or has expired. Check the latest e-mail or send a new code.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Token has expired or is invalid")).toBeNull();
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("refuses two passwords that differ without calling the provider", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderApp(client);
    await requestCode(user);
    await waitFor(() =>
      expect(screen.getByLabelText("One-time code from the e-mail")).toHaveFocus(),
    );
    await user.keyboard(CODE);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByLabelText("New password")).toHaveFocus());
    await user.keyboard(PASSWORD);
    await user.tab();
    await user.keyboard(`${PASSWORD}!`);
    await user.keyboard("{Enter}");
    expect(await screen.findByText("The two passwords are not the same.")).toBeVisible();
    expect(client.auth.updateUser).not.toHaveBeenCalled();
  });

  it("translates a weak-password refusal", async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      updateError: { message: "Password is too weak", code: "weak_password", status: 422 },
    });
    renderApp(client);
    await requestCode(user);
    await waitFor(() =>
      expect(screen.getByLabelText("One-time code from the e-mail")).toHaveFocus(),
    );
    await user.keyboard(CODE);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByLabelText("New password")).toHaveFocus());
    await user.keyboard("short");
    await user.tab();
    await user.keyboard("short");
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText(
        "That password is too weak. Choose a longer one that is harder to guess.",
      ),
    ).toBeVisible();
  });

  it("signs the recovery session out when the operator backs out before saving", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderApp(client);
    await requestCode(user);
    await waitFor(() =>
      expect(screen.getByLabelText("One-time code from the e-mail")).toHaveFocus(),
    );
    await user.keyboard(CODE);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByLabelText("New password")).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Back to sign in" }));
    await waitFor(() => expect(client.auth.signOut).toHaveBeenCalled());
    expect(await screen.findByLabelText("Password")).toBeVisible();
  });
});
