import type { TranslationKey } from "@dulja/i18n";
import { Button, TextField } from "@dulja/ui";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useState, type FormEvent } from "react";
import { useShell } from "../components/app-shell";
import { useSession } from "../lib/session";
import type { Translate } from "../lib/translate";

/**
 * A first password, or a forgotten one, set by a one-time code the identity provider e-mails
 * (ADR 0096; PRD-01, OPS-08).
 *
 * The seeded owner is created without a password and `/admin/users` invites with none, so this is
 * the only way anyone gets one. It is a code typed into the app rather than a link because a link
 * opens a browser at Supabase's site URL, and `backoffice.exe` lives at `dulja://app`, which no
 * e-mailed link reaches (ADR 0096 records why a deep link was not chosen).
 *
 * The flow is Supabase's own recovery: `resetPasswordForEmail` (never `signInWithOtp`, so a request
 * can never create an account), `verifyOtp({ type: "recovery" })`, then `updateUser({ password })`.
 * The recovery session is `aal1`, the same level a password sign-in reaches, so nothing past the
 * password is weakened: a first-time user goes on to enrol a factor exactly as after a sign-in, and
 * an account that already has a verified factor must pass its TOTP challenge before the password is
 * changed. The screen asks for the six digits up front rather than relying on the provider, and
 * maps GoTrue's own `insufficient_aal` refusal where it gives one.
 */

type Step = "request" | "verify" | "password";

interface ProviderFailure {
  code?: unknown;
  status?: unknown;
}

const KEY_BY_CODE: Readonly<Record<string, TranslationKey>> = {
  over_email_send_rate_limit: "auth.reset.rateLimited",
  over_request_rate_limit: "auth.reset.rateLimited",
  otp_expired: "auth.reset.codeFailed",
  weak_password: "auth.reset.weak",
  same_password: "auth.reset.samePassword",
  insufficient_aal: "auth.mfa.required",
  mfa_verification_failed: "auth.mfa.failed",
  mfa_verification_rejected: "auth.mfa.failed",
  mfa_challenge_expired: "auth.mfa.failed",
};

/**
 * The catalogue's sentence for a failure, never the provider's English (spec:2061). A code this map
 * does not know falls back by status: a 4xx is the step's own refusal (`clientFault`), anything
 * else — a dropped connection has no status at all — is "could not be done just now", so a network
 * failure is never reported as a wrong code.
 */
export function resetMessage(cause: unknown, t: Translate, clientFault: TranslationKey): string {
  const { code, status } = (
    typeof cause === "object" && cause !== null ? cause : {}
  ) as ProviderFailure;
  const mapped = typeof code === "string" ? KEY_BY_CODE[code] : undefined;
  if (mapped !== undefined) return t(mapped);
  if (status === 429) return t("auth.reset.rateLimited");
  if (typeof status === "number" && status >= 400 && status < 500) return t(clientFault);
  return t("auth.reset.unavailable");
}

/** Spaces and dashes are how a code gets copied out of an e-mail; the provider wants digits only. */
const normaliseCode = (typed: string): string => typed.replace(/[\s-]/g, "");

export interface SetPasswordFlowProps {
  client: SupabaseClient;
  /** Whatever the operator had already typed into the sign-in form, so it is not typed twice. */
  initialEmail: string;
  /** The password is saved; the session is the provider's, applied through the session provider. */
  onDone(): void;
  /** Back to the sign-in form, with no session left behind. */
  onCancel(): void;
}

export function SetPasswordFlow({ client, initialEmail, onDone, onCancel }: SetPasswordFlowProps) {
  const { t } = useShell();
  const { listTotpFactors, verifyTotp, signOut } = useSession();
  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [totp, setTotp] = useState("");
  /** The verified TOTP factor that must be challenged before the change, or null when none. */
  const [factorId, setFactorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>, clientFault: TranslationKey) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(resetMessage(cause, t, clientFault));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () =>
    run(async () => {
      // No `redirectTo`: the e-mail's link is not the path, its `{{ .Token }}` is. GoTrue answers
      // 200 for an address it does not hold, and this screen says the same sentence either way.
      const { error: refusal } = await client.auth.resetPasswordForEmail(email.trim());
      if (refusal) throw refusal;
      setCode("");
      setStep("verify");
    }, "auth.reset.unavailable");

  const onRequest = (event: FormEvent) => {
    event.preventDefault();
    void sendCode();
  };

  const onVerify = (event: FormEvent) => {
    event.preventDefault();
    const token = normaliseCode(code);
    if (!/^\d{6,10}$/.test(token)) {
      setError(t("auth.reset.codeFailed"));
      return;
    }
    void run(async () => {
      const { error: refusal } = await client.auth.verifyOtp({
        email: email.trim(),
        token,
        type: "recovery",
      });
      if (refusal) throw refusal;
      const verified = (await listTotpFactors()).find((factor) => factor.verified);
      setFactorId(verified?.id ?? null);
      setStep("password");
    }, "auth.reset.codeFailed");
  };

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError(t("auth.reset.mismatch"));
      return;
    }
    void run(async () => {
      // An enrolled account steps up to aal2 first. The e-mailed code proves the mailbox, not the
      // person holding the second factor, and must never be enough on its own to take the account.
      if (factorId !== null) await verifyTotp(factorId, totp.trim());
      const { error: refusal } = await client.auth.updateUser({ password });
      if (refusal) {
        // A factor verified elsewhere since the list was read: ask for it rather than fail blind.
        if ((refusal as ProviderFailure).code === "insufficient_aal") {
          const verified = (await listTotpFactors()).find((factor) => factor.verified);
          setFactorId(verified?.id ?? null);
        }
        throw refusal;
      }
      onDone();
    }, "auth.reset.weak");
  };

  /** Past the code step the provider has issued a recovery session; backing out must end it. */
  const back = () => {
    if (step !== "password") {
      onCancel();
      return;
    }
    void signOut()
      .catch(() => undefined)
      .finally(onCancel);
  };

  const alert =
    error === null ? null : (
      <p role="alert" className="text-start text-danger">
        {error}
      </p>
    );

  const backButton = (
    <Button type="button" onClick={back} disabled={busy}>
      {t("auth.reset.back")}
    </Button>
  );

  if (step === "request") {
    return (
      <form onSubmit={onRequest} className="flex max-w-sm flex-col gap-4">
        <h1 className="text-start">{t("auth.reset.title")}</h1>
        <p className="text-start">{t("auth.reset.requestIntro")}</p>
        <TextField
          label={t("auth.login.email")}
          dir="ltr"
          type="email"
          autoComplete="username"
          autoFocus
          required
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
        {alert}
        <Button type="submit" variant="primary" disabled={busy}>
          {t("auth.reset.send")}
        </Button>
        {backButton}
      </form>
    );
  }

  if (step === "verify") {
    return (
      <form onSubmit={onVerify} className="flex max-w-sm flex-col gap-4">
        <h1 className="text-start">{t("auth.reset.title")}</h1>
        <p role="status" className="text-start">
          {t("auth.reset.sent")}
        </p>
        <TextField
          label={t("auth.reset.code")}
          // Digits are typed left-to-right in every locale, as the TOTP field's are.
          dir="ltr"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
          value={code}
          onChange={(e) => setCode(e.currentTarget.value)}
        />
        {alert}
        <Button type="submit" variant="primary" disabled={busy}>
          {t("auth.reset.verify")}
        </Button>
        <Button type="button" onClick={() => void sendCode()} disabled={busy}>
          {t("auth.reset.resend")}
        </Button>
        {backButton}
      </form>
    );
  }

  return (
    <form onSubmit={onSave} className="flex max-w-sm flex-col gap-4">
      <h1 className="text-start">{t("auth.reset.title")}</h1>
      <TextField
        label={t("auth.reset.newPassword")}
        dir="ltr"
        type="password"
        autoComplete="new-password"
        autoFocus
        required
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
      />
      <TextField
        label={t("auth.reset.confirmPassword")}
        dir="ltr"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.currentTarget.value)}
      />
      {factorId === null ? null : (
        <>
          <p className="text-start">{t("auth.reset.mfaIntro")}</p>
          <TextField
            label={t("auth.mfa.code")}
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={totp}
            onChange={(e) => setTotp(e.currentTarget.value)}
          />
        </>
      )}
      {alert}
      <Button type="submit" variant="primary" disabled={busy}>
        {t("auth.reset.save")}
      </Button>
      {backButton}
    </form>
  );
}
