import { z } from "zod";

const EnvSchema = z.object({
  VITE_API_BASE_URL: z.string().url(),
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1),
  VITE_SENTRY_DSN: z.string().min(1).optional(),
  VITE_APP_ENV: z.enum(["dev", "staging", "production"]).default("dev"),
});

export interface AppEnvVars {
  apiBaseUrl: string;
  supabaseUrl: string;
  /** The **publishable** anon key. The service-role key is confined to the seed CLI (§3.11) and never ships here. */
  supabaseAnonKey: string;
  sentryDsn?: string;
  appEnv: "dev" | "staging" | "production";
}

/**
 * At an environment boundary the empty string **is** absence. Every shell renders an unset variable
 * that way, and so does GitHub Actions for a secret or repository variable nobody has set — which is
 * how an unconfigured `VITE_SENTRY_DSN` (OWNER GATE OD-22) reaches a Vite build as `""` rather than as
 * `undefined`, gets baked into the bundle literally, and would then be rejected here as *invalid* by a
 * schema whose `.optional()` was written to allow exactly that meaning (0E T13). Dropping empty keys
 * before parsing is what makes `.optional()` and `.default()` say what they mean for every field at
 * once: no DSN is no DSN, an unset `VITE_APP_ENV` is `"dev"`, and a genuinely required variable still
 * fails — as missing rather than as malformed.
 *
 * Only the empty string is dropped, so `import.meta.env`'s own non-string entries (`DEV`, `PROD`,
 * `SSR`) are untouched, and `EnvSchema` is non-strict, so the extra keys it carries still pass.
 */
function withoutEmptyValues(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
}

/**
 * Fails at boot, naming the variable — never at the first fetch, with a blank screen.
 *
 * This message stays English on purpose and must not be "fixed" into the catalogue: it throws before
 * i18next exists (a bad `VITE_*` is exactly the kind of misconfiguration that can also break the
 * bundle the catalogue ships in), and its reader is whoever built or deployed the app, not the
 * operator using it. A translated boot error would be a message nobody could produce and nobody
 * needs.
 */
export function readEnv(
  source: Record<string, unknown> = import.meta.env as Record<string, unknown>,
): AppEnvVars {
  const parsed = EnvSchema.safeParse(withoutEmptyValues(source));
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${names}`);
  }
  const value = parsed.data;
  return {
    apiBaseUrl: value.VITE_API_BASE_URL,
    supabaseUrl: value.VITE_SUPABASE_URL,
    supabaseAnonKey: value.VITE_SUPABASE_ANON_KEY,
    // `exactOptionalPropertyTypes` rejects `sentryDsn: undefined` against an optional property, so
    // an absent DSN means no key at all rather than a key holding `undefined`.
    ...(value.VITE_SENTRY_DSN === undefined ? {} : { sentryDsn: value.VITE_SENTRY_DSN }),
    appEnv: value.VITE_APP_ENV,
  };
}
