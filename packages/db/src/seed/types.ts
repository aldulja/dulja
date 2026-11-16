/**
 * The four Phase 0 loaders, in **application order**. `roles` first because every later grant references a role;
 * `dimensions` next because `document.branch_id` and `role_assignment_branch.branch_id` point at BRANCH values;
 * then periods, then the chart. §3.4.8: a slice that introduces a sub-pack ships its loader in the same PR, and
 * a slice that adds rows to an existing sub-pack adds a *file*, never a loader.
 */
export type SubPack =
  | "roles"
  | "dimensions"
  | "fiscal-periods"
  | "chart-of-accounts"
  | "document-types"
  | "templates"
  | "tax"
  | "reports"
  | "statutory";
export const SUB_PACKS: readonly SubPack[] = [
  "roles",
  "dimensions",
  "fiscal-periods",
  "chart-of-accounts",
  // 1A. After the chart, because a posting policy is validated against accounts that must already exist
  // (contracts §5 item 33), and SUB_PACKS is application order.
  "document-types",
  // 2C. Last, because a print template references the document type it prints (§3.4.8, §4.5.9).
  "templates",
  "tax",
  // 7A. Last: a report definition is validated against the permission catalogue and the closed dataset
  // registry, so it is applied after everything it can name (§3.4.8, §4.2.13).
  "reports",
  // 8A. Last: a rate table points at a scheme and a scheme at a company (contracts round 16, A12).
  "statutory",
];

/** A pack file a loader read, validated and deliberately did NOT apply — reported through
 *  `LoaderContext.reportSkip` and printed in `SeedResult.skipped`, so an operator reads what was left out
 *  rather than inferring it from a zero count. PR 11 review, round 3: the `tax` loader skips a synthetic regime
 *  when `SeedConfig.appEnv` is `production`. */
export interface SeedSkip {
  readonly subPack: SubPack;
  /** The file's name within its sub-pack directory. */
  readonly file: string;
  readonly reason: string;
}

/** The seed is not an HTTP surface, so it does not build a Problem — but it reuses the one registered code that
 *  describes "your input does not satisfy the schema" (§4.2.4) rather than inventing a new one. */
export class SeedError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "SeedError";
  }
}
