import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ApiError, isAalRefusal, isSessionRefusal, problemSegments } from "../lib/problem";
import { useI18n } from "../lib/i18n-provider";
import { useOptionalSession } from "../lib/session";
import { contractIssues } from "../features/reports/shared";

/**
 * Auth expiry and assurance refusals, as `useCompanyId` answers them: a refused token signs this device out and
 * only then routes to `/login` — landing there still signed in offers a link straight back to the refused
 * screen. An assurance refusal goes to enrolment; the session is fine. Outside a provider (a screen's own
 * test) there is no session to end, so it only routes.
 */
export function useStaffRefusal(cause: unknown): void {
  const navigate = useNavigate();
  const session = useOptionalSession();
  const signOut = session?.signOut;
  useEffect(() => {
    if (isAalRefusal(cause)) {
      void navigate({ to: "/mfa" });
      return;
    }
    if (!isSessionRefusal(cause)) return;
    // A failed sign-out still must not strand the operator on a screen where every request is refused.
    void (signOut ? signOut() : Promise.resolve())
      .catch(() => {})
      .finally(() => void navigate({ to: "/login" }));
  }, [cause, navigate, signOut]);
}

/** A refusal on a staff screen: its segments on screen, and the session flow above. */
export function StaffFailure({ cause }: { cause: unknown }) {
  const { t } = useI18n();
  useStaffRefusal(cause);
  const local = contractIssues(cause);
  return (
    <div role="alert">
      {cause instanceof ApiError ? (
        problemSegments(cause.problem, t).map((segment) => <p key={segment.key}>{segment.text}</p>)
      ) : local !== null ? (
        <>
          <p>{t("problem.ERR_VALIDATION_FAILED.title")}</p>
          <ul className="list-disc ps-6">
            {local.map((entry) => (
              <li key={`${entry.path}:${entry.message}`}>
                <bdi dir="ltr">{entry.path}</bdi> <bdi>{entry.message}</bdi>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>{t("staff.saveFailed")}</p>
      )}
    </div>
  );
}
