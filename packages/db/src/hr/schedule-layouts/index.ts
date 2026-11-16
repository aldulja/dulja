// packages/db/src/hr/schedule-layouts/index.ts — 8C Task 13, ⚠️ OD-28 (the statutory-schedule upload layouts).
// Internal to 8C: `packages/db/src/index.ts` re-exports none of these names and no §4 register gains a row.
import type { StatutoryScheduleResult } from "../schedule";

/** ⚠️ OD-23's half of the answer: the identifiers a filing carries and a ledger never does. */
export interface EmployerIdentifiers {
  /** 8A's `statutory_scheme.employer_registration`; null until the owner supplies it (8C Task 15). */
  readonly employerRegistration: string | null;
}

export interface ScheduleLayout {
  /** The scheme code this layout is for. */
  readonly code: string;
  readonly header: readonly string[];
  /** The field separator the authority's specification names — comma, tab or pipe. */
  readonly delimiter: string;
  /** The name the portal expects, built from the schedule; the attachment takes it verbatim. */
  fileName(result: StatutoryScheduleResult): string;
  render(result: StatutoryScheduleResult, employer: EmployerIdentifiers): string;
}

/**
 * **Deliberately empty, and it stays empty until OD-28 answers.** A row is added here only when
 * `docs/owner/statutory-layouts/<SCHEME>/` holds both the authority's published specification and one example file the
 * authority has accepted — the two files that directory's README asks for. An entry written from memory, from a blog
 * post or from a sample found online would be hazard 1's shape wearing a layout's clothes: an unverified authority fact
 * committed to the repository. `packages/db/test/hr/schedule-layouts.test.ts` refuses a layout with no evidence on disk.
 */
const LAYOUTS: ReadonlyMap<string, ScheduleLayout> = new Map();

/**
 * The layout for a scheme, or `null` when none is verified — and **`null` is the normal answer today**. The fallback is
 * Task 7's generic `scheduleCsv`, so a company with two verified schemes and two unverified ones renders both kinds.
 * The generator is not wired to this yet: with an empty registry it would be a branch nothing can take.
 */
export function layoutFor(schemeCode: string): ScheduleLayout | null {
  return LAYOUTS.get(schemeCode) ?? null;
}
