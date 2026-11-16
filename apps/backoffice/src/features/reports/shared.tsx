import type { Locale } from "@dulja/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../../lib/i18n-provider";
import { ApiError, isAalRefusal, isSessionRefusal, problemSegments } from "../../lib/problem";
import { COMPANY_QUERY_KEY } from "../../lib/session";

/**
 * The refusal flow every back-office screen shares (`tax-returns.tsx`): a refused token re-runs the company
 * lookup, which owns the one sign-out-then-`/login` decision (`useCompanyId`), and an assurance refusal goes to
 * enrolment. Nothing else is routed: a 403 is the server's settled answer and stays on screen with its remedy.
 */
export function useRefusalRedirect(error: unknown): void {
  const cache = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    if (isSessionRefusal(error)) void cache.invalidateQueries({ queryKey: COMPANY_QUERY_KEY });
    else if (isAalRefusal(error)) void navigate({ to: "/mfa" });
  }, [error, cache, navigate]);
}

/**
 * A problem envelope as the operator reads it — title, the entity-naming detail, the remedy and the reference,
 * each in its own `<bdi>` (`problemSegments`, spec:2051, spec:2253). A 403 therefore shows the remedy the
 * server sent (7C T13 Step 2, test 36's branch-narrowed refusal) and never a stack trace.
 */
export function ProblemAlert({
  error,
  children,
  hidePaths = false,
}: {
  error: unknown;
  children?: ReactNode;
  /** When the caller shows each `errors[]` entry beside its own field, the summary does not repeat them. */
  hidePaths?: boolean;
}) {
  const { t } = useI18n();
  const local = contractIssues(error);
  const segments =
    error instanceof ApiError
      ? problemSegments(error.problem, t)
      : [
          {
            key: "title" as const,
            text: t(local === null ? "app.error.title" : "problem.ERR_VALIDATION_FAILED.title"),
          },
        ];
  const listed =
    error instanceof ApiError && !hidePaths ? (error.problem.errors ?? []) : (local ?? []);
  return (
    <div role="alert" className="flex flex-col gap-2 text-start text-danger">
      {segments.map((segment) => (
        <p key={segment.key}>
          <bdi>{segment.text}</bdi>
        </p>
      ))}
      {listed.length > 0 ? (
        <ul className="list-disc ps-6">
          {listed.map((entry) => (
            <li key={`${entry.path}:${entry.message}`}>
              <bdi dir="ltr">{entry.path}</bdi> <bdi>{entry.message}</bdi>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </div>
  );
}

/**
 * UI-10: a body the screen's own contract refused before sending (`Schema.parse` in a `lib/*-api.ts` wrapper) throws
 * a `ZodError`, not an `ApiError`. Its issues are read here as the server's `errors[]` would be — a JSON Pointer
 * into the request and the contract's message — so the operator sees the field and the reason, not "Something
 * went wrong". Read by shape, not `instanceof`, so a second copy of zod in the bundle still matches.
 */
export function contractIssues(error: unknown): { path: string; message: string }[] | null {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { name?: unknown }).name !== "ZodError" ||
    !Array.isArray((error as { issues?: unknown }).issues)
  )
    return null;
  return (error as { issues: { path: PropertyKey[]; message: string }[] }).issues.map((issue) => ({
    path: `/${issue.path.map(String).join("/")}`,
    message: issue.message,
  }));
}

/** `errors[]` (JSON Pointers into the request — `/parameters/fiscalPeriodId`, `/columns/2/width`), by path. */
export function pointerErrors(error: unknown): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!(error instanceof ApiError)) return out;
  for (const entry of error.problem.errors ?? []) {
    const known = out.get(entry.path);
    out.set(entry.path, known === undefined ? entry.message : `${known}; ${entry.message}`);
  }
  return out;
}

/** Answers that are not the server's recorded verdict on this key: a gateway or proxy said them, or none came. */
const UNSETTLED_STATUSES: ReadonlySet<number> = new Set([0, 408, 429, 502, 503, 504]);

/**
 * Whether a failed attempt must keep its idempotency key (§4.2.9). It must when the outcome is unknown — no
 * reply (status 0, or a thrown abort), a timeout, a rate limit, a gateway that never reached the API — and
 * when the server says the first attempt is still running (409 `ERR_IDEMPOTENCY_IN_FLIGHT`, UI-09): a retry
 * with a fresh key there would run the work twice. Any other answer, a 5xx included, is the verdict the server
 * recorded under the key for 24 hours (UI-12), so a corrected retry needs a fresh key or it is only replayed.
 */
export const keepsAttemptKey = (cause: unknown): boolean => {
  if (!(cause instanceof ApiError)) return true;
  const { status, code } = cause.problem;
  return UNSETTLED_STATUSES.has(status) || code === "ERR_IDEMPOTENCY_IN_FLIGHT";
};

/**
 * §4.2.9's idempotency keys, one per gesture: a retry of the same gesture after an ambiguous failure reuses its
 * key so the server replays a reply it may already have committed, and a definite answer starts afresh
 * (`keepsAttemptKey`) — the rule the tax-return and users screens apply too.
 */
export function useAttemptKeys() {
  const attempts = useRef(new Map<string, string>());
  return {
    key(gesture: string): string {
      const known = attempts.current.get(gesture);
      if (known !== undefined) return known;
      const fresh = crypto.randomUUID();
      attempts.current.set(gesture, fresh);
      return fresh;
    },
    settle(gesture: string, cause?: unknown): void {
      if (cause === undefined || !keepsAttemptKey(cause)) attempts.current.delete(gesture);
    },
  };
}

/** Whether the component is still mounted, for work that resolves after an unmount. */
export function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

/** A row's name in the operator's language. An Arabic name is optional on most masters; English stands in. */
export function localName(
  row: { nameEn: string; nameAr: string | null | undefined },
  locale: Locale,
): string {
  return locale === "ar" && row.nameAr ? row.nameAr : row.nameEn;
}

/** True when the key event's target is a place the operator is typing, where a bare key is a character. */
export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))
  );
}

/** A labelled checkbox — `packages/ui` has no checkbox primitive, so this is the native control, labelled. */
export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-start text-text">
      <input
        type="checkbox"
        className="size-4"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
