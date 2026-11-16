import { ConfigError, createHrKeyRing, DEV_HR_KEY, type HrKeyRing } from "@dulja/db";
import { parseAppEnv, type AppEnv } from "./app-env";

/**
 * The worker's HR key ring (8D A12) — 7A's `objectStore()` / `setObjectStore()` / `objectStoreFromEnv()` trio in
 * shape and for the same reason. 8A put the HR key names on the API's `ApiConfig`, and §3.1 forbids `apps/worker`
 * importing `apps/api`, so the worker reads them itself: `apps/worker/src/index.ts` composes the ring ONCE at boot,
 * and a test injects a deterministic one (`setHrKeyRing`) rather than arranging environment variables around a
 * running worker. A handler never reads `process.env`.
 */
let ring: HrKeyRing | null = null;

/** The composed ring. Throws rather than returning a silent default: a rotation under the wrong key writes
 *  ciphertext nobody can open, the one failure ADR 0080 refuses to risk. */
export function hrKeyRing(): HrKeyRing {
  if (ring === null) {
    throw new ConfigError(
      "hrKeyRing() called before setHrKeyRing(); apps/worker/src/index.ts composes it at boot from hrKeyRingFromEnv(process.env)",
    );
  }
  return ring;
}

export function setHrKeyRing(next: HrKeyRing): void {
  ring = next;
}

/**
 * Parses §3.11's `HR_FIELD_ENCRYPTION_KEY_VERSION` (8D A1): optional, default 1, an integer from 1 to 255 (one
 * envelope byte). Strict digits — `Number()` would read "", " 2 " and "1e0" as numbers. The rule is reproduced in
 * `apps/api/src/config.ts` rather than shared: §3.1 forbids either app importing the other.
 */
export function parseHrKeyVersion(raw: string | undefined): number {
  const value = raw === undefined || raw === "" ? "1" : raw;
  const version = /^[1-9][0-9]{0,2}$/.test(value) ? Number(value) : Number.NaN;
  if (!(version >= 1 && version <= 255))
    throw new ConfigError(
      `HR_FIELD_ENCRYPTION_KEY_VERSION must be an integer between 1 and 255; received ${JSON.stringify(raw)} (§3.11, 8D A1)`,
    );
  return version;
}

/**
 * §3.11's three names, on 8A's terms (amendment A8) so the API and the worker boot alike: `HR_FIELD_ENCRYPTION_KEY`
 * is optional only when APP_ENV is dev (the all-zero `DEV_HR_KEY` stands in) and required everywhere else;
 * `HR_FIELD_ENCRYPTION_KEY_PREVIOUS` is optional; `HR_FIELD_ENCRYPTION_KEY_VERSION` is optional and defaults to 1.
 * There is no `…_PREVIOUS_VERSION`: `createHrKeyRing` derives it as the current version − 1, which is what a
 * rotation produces — so a previous key bound beside version 1 is refused here, by name, rather than as a ring
 * error. The key encoding (base64 of 32 bytes) is validated by `createHrKeyRing`, naming the variable.
 */
export function hrKeyRingFromEnv(
  env: NodeJS.ProcessEnv,
  appEnv: AppEnv = parseAppEnv(env),
): HrKeyRing {
  const current = env["HR_FIELD_ENCRYPTION_KEY"] || (appEnv === "dev" ? DEV_HR_KEY : undefined);
  if (current === undefined)
    throw new ConfigError(
      `HR_FIELD_ENCRYPTION_KEY is required when APP_ENV=${appEnv} — the worker cannot open or re-seal employee_sensitive without it (contracts §3.11; docs/runbooks/deploy.md)`,
    );
  const version = parseHrKeyVersion(env["HR_FIELD_ENCRYPTION_KEY_VERSION"]);
  const previous = env["HR_FIELD_ENCRYPTION_KEY_PREVIOUS"] || null;
  if (previous !== null && version === 1)
    throw new ConfigError(
      "HR_FIELD_ENCRYPTION_KEY_PREVIOUS is bound but HR_FIELD_ENCRYPTION_KEY_VERSION is 1 — set the version to the previous one plus one (docs/runbooks/hr-key-rotation.md)",
    );
  return createHrKeyRing({ current, currentVersion: version, previous });
}
