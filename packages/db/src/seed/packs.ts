import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import type { SeedConfig } from "./config";
import { SeedError, SUB_PACKS, type SeedSkip, type SubPack } from "./types";

export interface LoaderContext {
  readonly config: SeedConfig;
  readonly tenantId: string;
  readonly companyId: string;
  readonly systemPrincipalId: string;
  readonly packRoot: string;
  /** Where a loader reports a pack file it read and deliberately did not apply (PR 11 review, round 3).
   *  Optional, so `load` keeps its `Promise<number>` contract and a caller that does not collect skips — a
   *  test calling one loader directly — is unaffected; `seed` collects them into `SeedResult.skipped`. */
  readonly reportSkip?: (skip: SeedSkip) => void;
}

/** A loader returns the number of rows it inserted — zero on a re-run, which is what "changes nothing" means. */
export interface PackLoader {
  readonly name: SubPack;
  load(tx: Sql, ctx: LoaderContext): Promise<number>;
}

/** Every sub-pack that is a DIRECTORY under the pack root. `roles` is TypeScript data
 *  (`packages/db/seed/roles.ts`) and has no directory (§3.4.8). */
export const SUB_PACK_DIRECTORIES: readonly string[] = SUB_PACKS.filter((p) => p !== "roles");

/**
 * The REQUIRED-presence list (§4.2.13's round-2 amendment keeps the spelling and amends the meaning):
 * every directory a pack must CONTAIN. §2.1's 0C card shipped three — the chart of accounts, the BRANCH
 * dimension and the fiscal periods; 1A appended `document-types` with its loader; 2C appends `templates`
 * with its own, 5A `tax`, 7A `reports` and 8A `statutory`. The ALLOWED set is `SUB_PACK_DIRECTORIES` above, and from 2C onward the two are computed
 * separately. The const keeps its §4.2.13 spelling — renaming it is the architect's amendment (ADR 0012).
 */
export const PHASE_0_SUB_PACK_DIRECTORIES: readonly string[] = [
  "chart-of-accounts",
  "dimensions",
  "fiscal-periods",
  "document-types",
  "templates",
  "tax",
  "reports",
  "statutory",
];

/** 0C declared five; 1A removed `document-types` with its loader, 2C removed `templates`, 5A `tax`, 7A `reports`
 *  and 8A `statutory` with their own. None remains; the map stays so a later slice that reserves a sub-pack ahead of
 *  its loader names itself in the refusal (§3.4.8). Exported so the loader tests can pin what is left. */
export const OWNED_ELSEWHERE: Readonly<Record<string, string>> = {};

export function assertPackShape(packRoot: string): void {
  const present = readdirSync(packRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  for (const required of PHASE_0_SUB_PACK_DIRECTORIES) {
    if (!present.includes(required))
      throw new SeedError(`missing sub-pack: ${required} (in ${packRoot})`);
  }
  for (const found of present) {
    // A directory whose loader has SHIPPED is legal; one whose loader has not is the F-21 failure 0C wrote
    // this check for, and still names its owner.
    if (SUB_PACK_DIRECTORIES.includes(found)) continue;
    const owner = OWNED_ELSEWHERE[found];
    throw new SeedError(
      owner
        ? `unexpected sub-pack: ${found} — ${found}/ is slice ${owner}'s and its loader has not shipped (contracts §3.4.8)`
        : `unexpected sub-pack: ${found} — the known sub-packs are ${SUB_PACK_DIRECTORIES.join(", ")}`,
    );
  }
}

/** Reads and JSON-parses `<packRoot>/<sub-pack>/<file>`; a missing or malformed file is a SeedError naming it. */
export function readPackFile<T>(packRoot: string, subPack: SubPack, file: string): T {
  let text: string;
  try {
    text = readFileSync(join(packRoot, subPack, file), "utf8");
  } catch {
    throw new SeedError(`seed pack file not found: ${subPack}/${file} (looked in ${packRoot})`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new SeedError(
      `seed pack file ${subPack}/${file} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

/** `readPackFile`'s twin for a body that is not JSON — a template source (§4.5.9). */
export function readPackText(packRoot: string, subPack: SubPack, file: string): string {
  try {
    return readFileSync(join(packRoot, subPack, file), "utf8");
  } catch {
    throw new SeedError(`seed pack file not found: ${subPack}/${file} (looked in ${packRoot})`);
  }
}
