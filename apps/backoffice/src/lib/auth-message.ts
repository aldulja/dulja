import type { TranslationKey } from "@dulja/i18n";
import type { Translate } from "./translate";

/**
 * Turns an auth failure into a sentence from the catalogue (spec:2061 — "a hard-coded string fails
 * CI", and both catalogues complete before merge).
 *
 * Supabase's `AuthError.message` is English prose aimed at whoever wrote the integration, not at the
 * operator: putting it on screen means an Arabic user reads "Invalid login credentials" in an
 * otherwise right-to-left Arabic UI, and no catalogue can ever fix it. `AuthError.code` is the
 * stable, machine-readable half of the same failure (`invalid_credentials`,
 * `mfa_verification_failed`, …), so that is what is mapped.
 *
 * The map is deliberately small. A code is listed only where the catalogue already has a sentence
 * that means the same thing; inventing a mapping would put a confidently wrong sentence on screen,
 * which is worse than the caller's honest fallback. `lib/problem.ts` does the equivalent job for
 * `/v1`'s problem envelopes, which are a different shape and are not routed through here.
 */
const KEY_BY_CODE: Readonly<Record<string, TranslationKey>> = {
  invalid_credentials: "auth.login.failed",
  mfa_verification_failed: "auth.mfa.failed",
  mfa_verification_rejected: "auth.mfa.failed",
  mfa_challenge_expired: "auth.mfa.failed",
};

const codeOf = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  const { code } = cause as { code?: unknown };
  return typeof code === "string" ? code : undefined;
};

export function authMessage(cause: unknown, t: Translate, fallback: TranslationKey): string {
  const code = codeOf(cause);
  return t((code === undefined ? undefined : KEY_BY_CODE[code]) ?? fallback);
}
