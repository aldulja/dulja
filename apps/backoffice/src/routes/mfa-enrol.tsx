import { Button, TextField } from "@dulja/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useShell } from "../components/app-shell";
import { authMessage } from "../lib/auth-message";
import { useSession } from "../lib/session";

/**
 * What this screen is for, which is not known until `listFactors` answers. `loading` is a state in
 * its own right, not a default: starting at `enrol` or `challenge` means a first-time enroller is
 * shown the wrong copy for a round trip — asked for six digits they cannot possibly have — before it
 * flips under them.
 */
type Mode = "loading" | "enrol" | "challenge" | "failed";

/**
 * The one route the API admits at `aal1` (§4.2.3 — "MFA-enrolment routes accept `aal1`, everything
 * else requires `aal2`"). It closes the 0.7b clause "the owner logs in, enrols MFA at `aal1`"
 * (spec:2317).
 *
 * It is not only an *enrolment* screen. Every session after the first arrives here at `aal1` with a
 * factor already verified, and that operator must be challenged, not enrolled again: enrolling
 * would show them a fresh QR they have to re-scan before they can get in, and would leave another
 * unverified factor behind on the server every single visit.
 */
export function MfaEnrolRoute() {
  const { t } = useShell();
  const { aal, listTotpFactors, enrolTotp, verifyTotp } = useSession();
  const [mode, setMode] = useState<Mode>("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  /** Bumped by "Try again"; the effect's dependency, and what makes the latch below per-attempt. */
  const [attempt, setAttempt] = useState(0);
  /**
   * `<StrictMode>` mounts, runs this effect, cleans up, and mounts again with refs preserved. A
   * `cancelled` flag would be the usual answer, but combined with a latch it deadlocks: pass one
   * fires the request and is then cancelled, pass two is latched out, and nothing ever renders. The
   * latch alone is correct — a `setState` after unmount is a no-op in React 19 — and it is what
   * stops a second enrolment (and a second orphan factor) being created on every mount. It records
   * *which attempt* it ran, so a retry is not latched out along with the double-mount.
   */
  const startedAttempt = useRef(-1);

  /**
   * Clearing the screen belongs here rather than at the top of the effect. If the effect reset the
   * mode to `loading`, the `useState` initialiser above would be dead code that no test could hold
   * honest — the effect would overwrite a wrong initial value before anything could observe it, and
   * a first-time enroller shown challenge copy for one paint would be invisible. The initial value
   * covers the first mount; this covers every later one.
   */
  const retry = () => {
    setError(null);
    setFactorId(null);
    setQr(null);
    setSecret(null);
    setMode("loading");
    setAttempt((previous) => previous + 1);
  };

  useEffect(() => {
    if (startedAttempt.current === attempt) return;
    startedAttempt.current = attempt;
    void (async () => {
      const factors = await listTotpFactors();
      const enrolled = factors.find((factor) => factor.verified);
      if (enrolled !== undefined) {
        // Challenge, not enrol. `listFactors` never returns a QR or a secret — those exist only in
        // an `enroll` response — so there is nothing to show but the code field, which is exactly
        // right for someone whose authenticator app is already set up.
        setFactorId(enrolled.id);
        setMode("challenge");
        return;
      }
      // The factors listed a moment ago are handed straight over, so enrolment does not fetch the
      // same list twice on the one path where the operator is waiting on it.
      const enrolment = await enrolTotp(factors);
      setFactorId(enrolment.factorId);
      setQr(enrolment.qrCode);
      setSecret(enrolment.secret);
      setMode("enrol");
    })().catch((cause: unknown) => {
      // `auth.mfa.failed` would be a lie here: it says the code did not match, and on this path the
      // operator has not typed one. A dead network must not be reported as a wrong code.
      setError(authMessage(cause, t, "auth.mfa.unavailable"));
      setMode("failed");
    });
  }, [attempt, enrolTotp, listTotpFactors, t]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (factorId === null) return;
    setBusy(true);
    setError(null);
    try {
      await verifyTotp(factorId, code);
      setVerified(true);
    } catch (cause) {
      /*
       * The fallback is `unavailable`, not `failed`, for the same reason as the boot path: a
       * connection that drops mid-submit must not accuse the operator of mistyping.
       *
       * The discrimination is real rather than assumed. A rejected code comes back with a code
       * auth-js names — `mfa_verification_failed`, `mfa_verification_rejected`,
       * `mfa_challenge_expired` — all three of which `auth-message.ts` maps to `auth.mfa.failed`. A
       * transport failure arrives as `AuthRetryableFetchError`, which auth-js constructs with its
       * `code` argument literally `undefined` (`lib/errors.js`), so it has no code to map and lands
       * here. The asymmetry is deliberate: an unrecognised failure is reported as "could not do this
       * just now, try again", which is unhelpful at worst, rather than as "your code is wrong",
       * which is false and sends the operator round the loop retyping a correct code.
       */
      setError(authMessage(cause, t, "auth.mfa.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  if (verified) {
    // No link of its own: this screen wears the shell, whose nav already carries "Users and roles",
    // and a second element with the same accessible name is a worse answer than a sentence.
    return (
      <section className="flex max-w-sm flex-col gap-4">
        <h1 className="text-start">{t("auth.mfa.title")}</h1>
        <p role="status" className="text-start">
          {t("auth.mfa.done")}
        </p>
      </section>
    );
  }

  if (mode === "loading" || mode === "failed") {
    // Without the retry the latch would hold for the life of the route, and an operator who hit a
    // flat network would have to navigate away and back to try again.
    return (
      <section className="flex max-w-sm flex-col gap-4">
        <h1 className="text-start">{t("auth.mfa.title")}</h1>
        {mode === "loading" ? (
          <p className="text-start text-text-muted">{t("app.loading")}</p>
        ) : (
          <>
            <p role="alert" className="text-start text-danger">
              {error}
            </p>
            <Button variant="primary" onClick={retry}>
              {t("app.error.retry")}
            </Button>
          </>
        )}
      </section>
    );
  }

  const enrolling = mode === "enrol";
  return (
    <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-4">
      <h1 className="text-start">
        {enrolling ? t("auth.mfa.title") : t("auth.mfa.challengeTitle")}
      </h1>
      {aal === "aal1" ? (
        <p className="text-start text-text-muted">{t("auth.mfa.required")}</p>
      ) : null}
      <p className="text-start">{enrolling ? t("auth.mfa.intro") : t("auth.mfa.challengeIntro")}</p>
      {qr === null ? null : <img src={qr} alt={t("auth.mfa.qrAlt")} width={200} height={200} />}
      {secret === null ? null : (
        // spec:2252 — a QR code alone is unusable without sight, and equally so on a machine whose
        // camera is the same machine showing the code. `enroll` returns the secret for exactly this
        // reason; discarding it would make enrolment sighted-only.
        <p className="flex flex-col gap-1 text-start">
          <span className="text-text-muted">{t("auth.mfa.secret")}</span>
          <code dir="ltr" className="select-all font-mono">
            {secret}
          </code>
        </p>
      )}
      <TextField
        label={t("auth.mfa.code")}
        // The code is Latin digits in every locale, so it is read and typed left-to-right even when
        // the page is Arabic (spec:2441 — direction follows the content, not the chrome).
        dir="ltr"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.currentTarget.value)}
      />
      {error === null ? null : (
        <p role="alert" className="text-start text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={busy}>
        {t("auth.mfa.verify")}
      </Button>
    </form>
  );
}
