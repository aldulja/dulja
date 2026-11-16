import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppEnvVars } from "./env";
import type { SessionStore } from "./session-storage";

/**
 * Supabase is used as an auth provider only (spec:1112 — "Used as a database and auth provider,
 * **not** as a backend"). No table is ever read through this client; every read goes to `/v1`
 * (spec:1118), which authenticates from the verified JWT and takes tenant and actor from it — never
 * from anything this client hands it.
 *
 * The three storage members are forwarded one by one rather than by passing `store` itself, so
 * supabase-js sees exactly the surface it is entitled to and never the `persistence` member the
 * session provider reads.
 */
export function createSupabase(env: AppEnvVars, store: SessionStore): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      storage: {
        getItem: (key) => store.getItem(key),
        setItem: (key, value) => store.setItem(key, value),
        removeItem: (key) => store.removeItem(key),
      },
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}
