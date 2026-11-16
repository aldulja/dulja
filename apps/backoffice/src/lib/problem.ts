import { ERRORS, ProblemSchema } from "@dulja/contracts";
import type { Problem } from "@dulja/contracts";
import { CATALOGUES, type TranslationKey } from "@dulja/i18n";
import type { Translate } from "./translate";

/** Every non-2xx response, and every failure before one arrives, becomes one of these. The UI never
 *  reads `res.status` directly and never sees a raw `TypeError` or `ZodError`. */
export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(`${problem.code}: ${problem.detail}`);
    this.name = "ApiError";
  }
}

export interface InternalProblemInput {
  /** The request path, which is also the envelope's `instance`. */
  instance: string;
  /**
   * A machine-shaped trace of what went wrong — an HTTP status, an error class name, never prose.
   * The sentence a human reads comes from `problem.ERR_INTERNAL.*` in the catalogue by way of
   * `problemSegments`, so this line reads identically in English and in Arabic.
   */
  diagnostic: string;
  status: number;
  /** Empty when there is none to quote: a failure this side of a reply has no server request id, and
   *  "Reference unknown" is a line of English prose no catalogue can translate. */
  requestId: string;
  /** Structured causes (a `ZodError`'s issues). Diagnostic only — `problemSegments` never renders them. */
  issues?: { path: string; message: string }[];
}

/**
 * The envelope this client synthesises when the server's own never arrived or could not be trusted.
 * `title` and `remedy` come from 0B's registry rather than being re-spelled here: a registered name
 * never gets a second spelling, and nothing in this file is left holding untranslatable English.
 */
export function internalProblem(input: InternalProblemInput): Problem {
  return {
    type: "urn:dulja:error:ERR_INTERNAL",
    title: ERRORS.ERR_INTERNAL.title,
    status: input.status,
    detail: `${input.instance} — ${input.diagnostic}`,
    instance: input.instance,
    code: "ERR_INTERNAL",
    remedy: ERRORS.ERR_INTERNAL.remedy,
    requestId: input.requestId,
    ...(input.issues === undefined ? {} : { errors: input.issues }),
  };
}

export async function toApiError(response: Response, instance: string): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  // `ProblemSchema` types `code`/`type` as plain strings; `Problem` narrows both to the registered
  // `ErrCode` union. The assertion is that narrowing, and is trusting `/v1` to send a code it owns.
  const parsed = ProblemSchema.safeParse(body);
  if (parsed.success) return new ApiError(parsed.data as Problem);
  // A response that is not a problem envelope is still an error the user must see, with the request id we have.
  return new ApiError(
    internalProblem({
      instance,
      diagnostic: `HTTP ${response.status}`,
      status: response.status,
      requestId: response.headers.get("x-request-id") ?? "",
    }),
  );
}

/**
 * 0B answers `ERR_AUTH_AAL_INSUFFICIENT` on every route but `GET /v1/session` until a second factor
 * is verified (§4.2.3). The session is fine and the assurance level is not, so neither a raw error
 * nor a sign-out is the right answer: the operator belongs on the one screen that level admits.
 *
 * It lives here, beside `ApiError` and `retryQuery`, because it is not one screen's rule: every
 * consumer of `/v1` can be told this, and `useCompanyId` — the third one — silently turned it into
 * "the company is not known" while this predicate was private to the users screen.
 */
export const isAalRefusal = (cause: unknown): boolean =>
  cause instanceof ApiError && cause.problem.code === "ERR_AUTH_AAL_INSUFFICIENT";

/**
 * A 401 that is **not** an assurance problem — `ERR_AUTH_TOKEN_INVALID` and anything else 0B answers
 * at that status. The token itself is not usable, so no amount of staying on the screen helps and
 * the destination is `/login`, not an alert the operator can only read.
 */
export const isSessionRefusal = (cause: unknown): boolean =>
  cause instanceof ApiError && cause.problem.status === 401 && !isAalRefusal(cause);

/**
 * The retry policy every `/v1` query takes, because TanStack's default — three retries at 1s, 2s and
 * 4s — is right for a dropped connection and wrong for a refusal. A 4xx is the server's settled
 * answer: repeating it cannot change it, and it delays everything the screen does with the answer by
 * about seven seconds, during which the operator reads an empty grid. That includes the
 * `ERR_AUTH_AAL_INSUFFICIENT` redirect to enrolment, which is the case this exists for.
 *
 * `429` is deliberately inside that net: 0B answers it with a `RateLimit-Reset` window, and a blind
 * one-second retry ignores the window it was given. A failure this side of a reply carries
 * `status: 0` (see `internalProblem`) and so keeps the default retries, which is what a flaky
 * network wants.
 *
 * It lives here, next to `ApiError`, rather than on the `QueryClient` in `main.tsx`, so it travels
 * with the code that throws and can be asserted in a test.
 */
export const retryQuery = (failureCount: number, cause: unknown): boolean => {
  if (cause instanceof ApiError && cause.problem.status >= 400 && cause.problem.status < 500)
    return false;
  return failureCount < 3;
};

/** `en` is the key registry: the completeness checker and `tests/regression/sah-085.test.ts` hold
 *  `ar` to exactly the same key set, so a key present here is present in both. */
const isTranslationKey = (key: string): key is TranslationKey => Object.hasOwn(CATALOGUES.en, key);

/**
 * One piece of an error message, to be rendered in its own `<bdi>`.
 *
 * `key` is not decoration: it is the React key the renderer uses, so the list never falls back to an
 * array index, and it names which piece a test is looking at.
 */
export interface ProblemSegment {
  readonly key: "title" | "detail" | "remedy" | "reference";
  readonly text: string;
}

/**
 * spec:2051 — every error carries "a human message naming the specific entity, and a remedy".
 *
 * The title and the remedy come from the catalogue whenever this code has an entry there, so the
 * frame around an error is the operator's own language. `problem.detail` is always carried through
 * untouched: it is the half that names the specific entity, and inventing our own wording for it
 * would lose that. The server's envelope is English end to end today (`ERRORS` in
 * `packages/contracts`), so in Arabic that detail is still English — a cross-slice contracts issue
 * recorded by the controller, not something this file can fix.
 *
 * **Segments, not one joined string (spec:2253).** Even after contracts translates every title and
 * remedy, `detail` still carries entity names, paths and ids, and `requestId` is a bare UUID — Latin
 * and neutral runs inside what is, in `ar`, an RTL paragraph. Under UAX#9 those runs and the neutral
 * characters between them reorder relative to the order they were written in, so a joined string can
 * put the reference id somewhere other than after the word it follows. Returning the pieces lets the
 * one caller wrap each in `<bdi>` — the same isolation `packages/ui/src/data-grid.tsx` already gives
 * every cell — which fixes each segment's own direction and leaves the sequence in source order.
 * Joining here instead would leave the caller nothing to wrap, which is exactly how this was missed.
 */
export function problemSegments(problem: Problem, t: Translate): readonly ProblemSegment[] {
  const titleKey = `problem.${problem.code}.title`;
  const remedyKey = `problem.${problem.code}.remedy`;
  // Both looked up together, inside the guard, so the pair is either fully translated or fully the
  // server's — never an Arabic title above an English remedy.
  const translated =
    isTranslationKey(titleKey) && isTranslationKey(remedyKey)
      ? { title: t(titleKey), remedy: t(remedyKey) }
      : { title: t("app.error.title"), remedy: problem.remedy };
  return [
    { key: "title", text: translated.title },
    { key: "detail", text: problem.detail },
    { key: "remedy", text: t("problem.remedy", { remedy: translated.remedy }) },
    // Omitted rather than filled with a placeholder when there is no id to quote.
    ...(problem.requestId === ""
      ? []
      : [
          {
            key: "reference" as const,
            text: t("problem.reference", { requestId: problem.requestId }),
          },
        ]),
  ];
}
