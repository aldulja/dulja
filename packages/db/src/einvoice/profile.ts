// packages/db/src/einvoice/profile.ts
//
// Loads a versioned profile file (ADR 0052) and validates it with @dulja/domain's parseProfile.
// The directory is deliberately OUTSIDE packages/db/seed — see einvoice-profiles/README.md rule 4.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProfile, type EInvoiceProfile } from "@dulja/domain";

/** `packages/db/einvoice-profiles`. Two directories up from `src/einvoice/`. */
export const PROFILE_DIR = fileURLToPath(new URL("../../einvoice-profiles", import.meta.url));

export class ProfileNotFoundError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProfileNotFoundError";
  }
}

const FILE_NAME = /^([a-z][a-z0-9_-]*)\.v([1-9][0-9]*)\.json$/;

// `dir` defaults to PROFILE_DIR in every function below and only a test passes another, so the
// failure paths are exercised without editing the committed directory.
export function profilePath(code: string, version: number, dir: string = PROFILE_DIR): string {
  return join(dir, `${code}.v${version}.json`);
}

/** Ascending. `[]` when the code has no file at all — which is the authority transmitter' state until OD-15. */
export function availableProfileVersions(code: string, dir: string = PROFILE_DIR): number[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const versions: number[] = [];
  for (const entry of entries) {
    const match = FILE_NAME.exec(entry);
    if (match && match[1] === code) versions.push(parseInt(match[2]!, 10));
  }
  return versions.toSorted((a, b) => a - b);
}

/**
 * Read and validate a profile. `version` omitted means the highest available. At boot the registry
 * loads every available version explicitly, so each transmission is interpreted against the file
 * that produced it (SAH-013): its poll and cancel resolve the version the row is pinned to.
 *
 * It throws; it never returns a silent `{}`. A missing directory or file, a file that is not JSON,
 * or one whose `code`/`version` disagree with its name is `ProfileNotFoundError`; a file that fails
 * the schema is `EInvoiceProfileError` from `parseProfile`. At boot, `registerDefaultTransmitters`
 * catches either, leaves that version unregistered and reports the skip for the entrypoint to log;
 * every caller of that version then receives `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` from
 * `transmitterFor`, which is the fail-closed direction.
 */
export function loadProfile(
  code: string,
  version?: number,
  dir: string = PROFILE_DIR,
): EInvoiceProfile {
  const resolved = version ?? availableProfileVersions(code, dir).at(-1);
  if (resolved === undefined) {
    throw new ProfileNotFoundError(code, `no profile file for ${code} in ${dir}`);
  }
  const path = profilePath(code, resolved, dir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ProfileNotFoundError(
      code,
      `no profile file for ${code} at version ${resolved} (${path})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ProfileNotFoundError(code, `${path} is not JSON: ${(e as Error).message}`);
  }
  const profile = parseProfile(parsed);
  if (profile.code !== code || profile.version !== resolved) {
    throw new ProfileNotFoundError(
      code,
      `${path} declares ${profile.code}.v${profile.version}; the file name says ${code}.v${resolved}`,
    );
  }
  return profile;
}
