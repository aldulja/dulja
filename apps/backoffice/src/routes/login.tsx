import { Button, TextField } from "@dulja/ui";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { LocaleSwitcher, useShell } from "../components/app-shell";
import { authMessage } from "../lib/auth-message";
import { TokenPersistenceAlert, useSession } from "../lib/session";
import type { RouterContext } from "../router";
import { SetPasswordFlow } from "./set-password";

/**
 * Unauthenticated, so it renders inside `<I18nProvider>` and outside `<AppShell>` — translation and
 * direction, but no header and no "Users and roles" link before anyone has signed in (Task 5, and
 * `shell.test.tsx`'s "no shell chrome" case). The locale switcher is the one piece of chrome that
 * comes along: without it an Arabic operator would meet an English form on a fresh machine with no
 * way to change it, and the shell's own switcher is not on this screen to do the job.
 */
function LoginLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex flex-col gap-4 p-4">
      <div className="flex justify-end">
        <LocaleSwitcher />
      </div>
      <TokenPersistenceAlert />
      {children}
    </main>
  );
}

export function LoginRoute() {
  const { t } = useShell();
  const { signIn, status, aal } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signedInHeading = useRef<HTMLHeadingElement>(null);
  /**
   * `reset` is the first-or-forgotten-password step (ADR 0096). It is held here rather than in a
   * route of its own because the recovery code signs the operator in at `aal1` half-way through,
   * and the session flipping to `authenticated` must not swap the half-finished form for the
   * signed-in view before the password is saved.
   */
  const [mode, setMode] = useState<"signin" | "reset">("signin");
  const [passwordSaved, setPasswordSaved] = useState(false);
  // The router's context carries the one Supabase client `main.tsx` built. Only a test harness
  // mounts this screen without it, and there the step is simply not offered.
  const client = (useRouter().options.context as Partial<RouterContext> | undefined)?.supabase;

  const authenticated = status === "authenticated";

  /**
   * Replacing the form drops focus on `<body>`, which leaves a keyboard or screen-reader user with
   * no idea the sign-in worked and nowhere to tab from. Moving focus to the new heading announces
   * the change and puts the caret one Tab away from the next step.
   */
  useEffect(() => {
    if (authenticated && mode === "signin") signedInHeading.current?.focus();
  }, [authenticated, mode]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (cause) {
      // The catalogue's sentence, never Supabase's English `message` — spec:2061.
      setError(authMessage(cause, t, "auth.login.failed"));
    } finally {
      setBusy(false);
    }
  };

  if (mode === "reset" && client !== undefined) {
    return (
      <LoginLayout>
        <SetPasswordFlow
          client={client}
          initialEmail={email}
          onDone={() => {
            setPasswordSaved(true);
            setMode("signin");
          }}
          onCancel={() => setMode("signin")}
        />
      </LoginLayout>
    );
  }

  // `loading` is not `anonymous`: showing the credentials form here would flash it at an operator
  // whose stored session is still being read.
  if (status === "loading") {
    return (
      <LoginLayout>
        <p className="text-start text-text-muted">{t("app.loading")}</p>
      </LoginLayout>
    );
  }

  if (authenticated) {
    // `aal1` is the API's dead end — every route but `GET /v1/session` answers
    // `ERR_AUTH_AAL_INSUFFICIENT` until a second factor is enrolled and verified (§4.2.3) — so the
    // only step offered there is enrolment. `aal` is null for as long as it is being read.
    const enrolled = aal === "aal2";
    return (
      <LoginLayout>
        <section className="flex max-w-sm flex-col gap-4">
          <h1 ref={signedInHeading} tabIndex={-1} className="text-start">
            {t("auth.login.title")}
          </h1>
          {passwordSaved ? (
            <p role="status" className="text-start">
              {t("auth.reset.saved")}
            </p>
          ) : null}
          {aal === null ? (
            <p className="text-start text-text-muted">{t("app.loading")}</p>
          ) : (
            // `Link`, not `<a href>`: an anchor is a full document navigation, which throws away
            // the JS heap — and with it a session the keyring refused to persist, on exactly the
            // machine where that is the only copy there is.
            <Link to={enrolled ? "/admin/users" : "/mfa"} className="text-start text-accent">
              {enrolled ? t("app.nav.users") : t("auth.mfa.title")}
            </Link>
          )}
        </section>
      </LoginLayout>
    );
  }

  return (
    <LoginLayout>
      <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-4">
        <h1 className="text-start">{t("auth.login.title")}</h1>
        <TextField
          label={t("auth.login.email")}
          // An e-mail address is Latin text in every locale, so it is typed left-to-right even when
          // the page is Arabic (spec:2441 — direction follows the content, not the chrome).
          dir="ltr"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
        <TextField
          label={t("auth.login.password")}
          dir="ltr"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        {error === null ? null : (
          <p role="alert" className="text-start text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {t("auth.login.submit")}
        </Button>
      </form>
      {/* After the form, so the sign-in tab order (e-mail → password → submit) is unchanged. */}
      {client === undefined ? null : (
        <div className="flex max-w-sm flex-col">
          <Button type="button" onClick={() => setMode("reset")}>
            {t("auth.reset.start")}
          </Button>
        </div>
      )}
    </LoginLayout>
  );
}
