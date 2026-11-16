/**
 * Where the till's API lives (ADR 0093, amending 0055 and 0057; OPS-05, PRD-02).
 *
 * The origin is the trust root of every request a till makes: the enrolment code, every cashier sign-in and
 * every ticket go to it, signed with the terminal key. So it follows the rule `updater.ts` already applies to
 * the update feed: **a packaged till uses the origin it was built with, full stop.** `DULJA_API_BASE_URL` is
 * an ordinary user environment variable, which anything running as the logged-in user can `setx` with no
 * admin rights, so a packaged build never reads it. A development run is the developer's own machine and
 * still honours it.
 *
 * The packaged origin must be `https:`. A plain-http origin would let anything on the shop's network read and
 * alter the till's traffic; refusing it at startup, with a dialog, is better than a till that quietly sends
 * cashier PINs in clear.
 *
 * Pure (no Electron import), so both branches are decidable in a unit test on any host.
 */

/** The file `scripts/write-pos-config.ts` writes at packaging time, shipped under `resources/`. */
export const POS_CONFIG_FILE = "pos-config.json";

/** The development fallback: the local API `bun run --cwd apps/api dev` serves. Never used when packaged. */
export const DEV_API_BASE_URL = "http://127.0.0.1:3000";

export interface PosBuildConfig {
  apiBaseUrl?: unknown;
}

/** Parses the baked file's text; anything unreadable is `null`, which a packaged till refuses. */
export function parsePosBuildConfig(text: string | null): PosBuildConfig | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as PosBuildConfig) : null;
  } catch {
    return null;
  }
}

function present(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function resolveApiOrigin(
  isPackaged: boolean,
  override: string | undefined,
  baked: PosBuildConfig | null,
): string {
  const built = present(baked?.apiBaseUrl);
  if (!isPackaged) return present(override) ?? built ?? DEV_API_BASE_URL;
  if (built === undefined) {
    throw new Error(
      `This build of Dulja POS has no API origin (resources/${POS_CONFIG_FILE}). Rebuild it with DULJA_API_BASE_URL set.`,
    );
  }
  let url: URL;
  try {
    url = new URL(built);
  } catch {
    throw new Error(`Dulja POS needs an https API origin; this build carries "${built}".`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Dulja POS needs an https API origin; this build carries "${built}".`);
  }
  return url.origin;
}
