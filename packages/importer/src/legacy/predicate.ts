import type { LegacyRow } from "./types";

/**
 * The `where` a caller may ask the legacy reader for (contracts §4.13.1: "a typed structure, never SQL text").
 * 9A defines it; 9B consumes it through `LegacyReader.read` and never redefines it (§4 preamble). Values are
 * always bound as parameters, so nothing a caller passes can become statement text. ADR 0082.
 */
export type LegacyPredicate =
  | {
      readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
      readonly column: string;
      readonly value: string | boolean | null;
    }
  | {
      readonly op: "in";
      readonly column: string;
      readonly values: readonly (string | boolean | null)[];
    }
  | { readonly op: "between"; readonly column: string; readonly from: string; readonly to: string }
  | { readonly op: "is_null" | "is_not_null"; readonly column: string }
  | { readonly op: "and" | "or"; readonly operands: readonly LegacyPredicate[] };

/**
 * SQL three-valued logic, reproduced exactly: any comparison whose operand is NULL is unknown, and unknown is
 * not true. Getting this wrong in the fixture driver would make a reconciliation test pass on rows the live
 * database excludes — which is the whole class of defect this slice exists to find (SAH-011).
 *
 * Comparisons are over the text form, which is what every value is once the renderer has cast it (ADR 0082):
 * exact for equality and for ISO dates, and for ordering only where the corpus keeps codes equal-width. The
 * fixture corpus is written to that rule; the live driver compares natively.
 */
export function evaluatePredicate(row: LegacyRow, predicate: LegacyPredicate): boolean {
  switch (predicate.op) {
    case "and":
      return predicate.operands.every((p) => evaluatePredicate(row, p));
    case "or":
      return predicate.operands.some((p) => evaluatePredicate(row, p));
    case "is_null":
      return (row[predicate.column] ?? null) === null;
    case "is_not_null":
      return (row[predicate.column] ?? null) !== null;
    case "between": {
      const v = row[predicate.column] ?? null;
      return v !== null && String(v) >= predicate.from && String(v) <= predicate.to;
    }
    case "in": {
      const v = row[predicate.column] ?? null;
      return (
        v !== null &&
        predicate.values.some((candidate) => candidate !== null && compare(v, candidate, "eq"))
      );
    }
    default: {
      const v = row[predicate.column] ?? null;
      if (v === null || predicate.value === null) return false;
      return compare(v, predicate.value, predicate.op);
    }
  }
}

function compare(
  left: string | boolean,
  right: string | boolean,
  op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte",
): boolean {
  const a = String(left);
  const b = String(right);
  switch (op) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
  }
}

/** Every column a predicate names, in first-appearance order — the driver validates these before rendering. */
export function predicateColumns(predicate: LegacyPredicate): string[] {
  if ("operands" in predicate) {
    const seen: string[] = [];
    for (const operand of predicate.operands) {
      for (const column of predicateColumns(operand)) if (!seen.includes(column)) seen.push(column);
    }
    return seen;
  }
  return [predicate.column];
}
