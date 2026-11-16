import type { LegacyReader } from "../reader";
import { aggregateDrift } from "./aggregate-drift";
import { duplicateAggregates } from "./duplicate-aggregates";
import { employeeMapping } from "./employee-mapping";
import { nullPoison } from "./null-poison";
import { orphans } from "./orphans";
import { unbalancedVouchers } from "./unbalanced-vouchers";

/** Contracts §4.13.1, verbatim — mutable members and the closed six-member `kind` union included. */
export interface ReconciliationReport {
  kind:
    | "aggregate_drift"
    | "unbalanced_vouchers"
    | "orphans"
    | "null_poison"
    | "duplicate_aggregates"
    | "employee_mapping";
  rows: Record<string, unknown>[];
  summary: Record<string, string>;
}

export const RECONCILIATION_KINDS: readonly ReconciliationReport["kind"][] = [
  "aggregate_drift",
  "unbalanced_vouchers",
  "orphans",
  "null_poison",
  "duplicate_aggregates",
  "employee_mapping",
];

/**
 * Contracts §4.13.1. Exhaustive over the closed union and deliberately without a `default`: TypeScript narrows
 * `kind` to `never` after the last case, so a seventh member with no branch fails the build (TS2366) instead of
 * falling into a fallback that hides it.
 */
export async function reconcile(
  reader: LegacyReader,
  kind: ReconciliationReport["kind"],
): Promise<ReconciliationReport> {
  switch (kind) {
    case "aggregate_drift":
      return aggregateDrift(reader);
    case "unbalanced_vouchers":
      return unbalancedVouchers(reader);
    case "orphans":
      return orphans(reader);
    case "null_poison":
      return nullPoison(reader);
    case "duplicate_aggregates":
      return duplicateAggregates(reader);
    case "employee_mapping":
      return employeeMapping(reader);
  }
}
