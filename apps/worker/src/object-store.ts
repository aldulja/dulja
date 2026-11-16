import { MemoryObjectStore, R2ObjectStore, type ObjectStore } from "@dulja/db";
import type { AppEnv } from "./app-env";

/**
 * The worker's twin of 0D's `log()` / `setLogger()`. A job handler needs a store to write a rendered report
 * into, and §3.1 forbids importing `apps/api/src/object-store.ts`; a module-level accessor keeps
 * `StartedWorker` (§4.17.1) untouched — a test calls `setObjectStore(new MemoryObjectStore())` before it
 * runs a handler, and `apps/worker/src/index.ts` sets the one `objectStoreFromEnv` builds at boot.
 */
let current: ObjectStore | null = null;

export function setObjectStore(store: ObjectStore): void {
  current = store;
}

export function objectStore(): ObjectStore {
  if (current === null) {
    throw new Error(
      "objectStore() called before setObjectStore(); apps/worker/src/index.ts wires it at boot",
    );
  }
  return current;
}

/** The four §3.11 R2 names, in `R2ObjectStoreOptions` order. Their holder is `api, worker` from 7A on. */
export const R2_ENV_NAMES = [
  "R2_ACCOUNT_ID",
  "R2_ATTACHMENTS_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

/**
 * §3.11's terms, the same as `apps/api`'s `readConfig` + `objectStoreFromConfig`: all four present → R2;
 * none present in `dev` → an in-process store (what `bun run dev` and CI use); anything else — some of
 * them, or none outside `dev` — is a configuration error naming every missing variable, because a rendered
 * report would otherwise have nowhere to go. The rule is reproduced rather than shared: §3.1 forbids the
 * worker importing the API (ADR 0066). `containerSecrets(env, "worker")` is what puts the four names in the
 * worker container.
 */
export function objectStoreFromEnv(env: NodeJS.ProcessEnv, appEnv: AppEnv): ObjectStore {
  const values = R2_ENV_NAMES.map((name) => env[name] ?? "");
  const missing = R2_ENV_NAMES.filter((_, i) => values[i] === "");
  if (missing.length === R2_ENV_NAMES.length && appEnv === "dev") return new MemoryObjectStore();
  if (missing.length > 0) {
    throw new Error(
      `report rendering needs all four R2 variables when APP_ENV=${appEnv} (§3.11); missing: ${missing.join(", ")}`,
    );
  }
  const [accountId, bucket, accessKeyId, secretAccessKey] = values as [
    string,
    string,
    string,
    string,
  ];
  return new R2ObjectStore({ accountId, bucket, accessKeyId, secretAccessKey });
}
