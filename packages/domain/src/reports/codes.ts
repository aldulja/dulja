import { ReportDefinitionError } from "./error";

export type ReportModule = "accounting" | "inventory" | "hr" | "pos";
export const REPORT_MODULES: readonly ReportModule[] = ["accounting", "inventory", "hr", "pos"];

/**
 * Contracts §4.16.1's frozen grammar: EXACTLY two segments, the first being the definition's own `module`.
 * Two segments is what makes a report code impossible to confuse with a three-segment permission code, and
 * deriving the module from the code is what makes the two impossible to disagree. The register of codes
 * itself is §4.16.1's table, not a TypeScript constant (ADR 0065).
 */
export const REPORT_CODE_PATTERN = /^(accounting|inventory|hr|pos)\.[a-z][a-z0-9_]{2,47}$/;

export type ReportCode = string & { readonly __brand: "ReportCode" };

export function isReportCode(value: unknown): value is ReportCode {
  return typeof value === "string" && REPORT_CODE_PATTERN.test(value);
}

export function reportCode(value: string): ReportCode {
  if (!isReportCode(value)) {
    throw new ReportDefinitionError(
      `'${value}' is not a report code: contracts §4.16.1 requires <module>.<name> with module in ${REPORT_MODULES.join(" | ")}`,
      [{ path: "/code", message: `'${value}' does not match ${REPORT_CODE_PATTERN.source}` }],
    );
  }
  return value;
}

export function moduleOfReportCode(code: string): ReportModule {
  return reportCode(code).split(".", 1)[0] as ReportModule;
}

/** §4.11.1's `dataset.filters[].op`. The same eight tokens as `@dulja/contracts`' `FILTER_OPS` (§4.2.8),
 *  pinned equal by `packages/contracts/test/report-filter-ops.test.ts`, because `packages/domain` may not
 *  import `@dulja/contracts` (§3.1) and one vocabulary must not fork. */
export const REPORT_FILTER_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "like"] as const;
export type ReportFilterOp = (typeof REPORT_FILTER_OPS)[number];

export type ReportFormat = "pdf" | "xlsx" | "csv";
export const REPORT_FORMATS: readonly ReportFormat[] = ["pdf", "xlsx", "csv"];
export type ReportLang = "en" | "ar";
/** §4.5.9 registers this vocabulary for `print_template.paper`; §4.11.1's `layout.paper` uses the same three
 *  tokens and no slice invents a fourth without amending that section. */
export type ReportPaper = "A4" | "A5" | "receipt";
export type ReportOrientation = "portrait" | "landscape";
export type ReportColumnFormat = "text" | "money" | "quantity" | "date" | "integer" | "percent";

/** The formats a `sum` or `avg` total is defined over. `text` and `date` are excluded on purpose. */
export const NUMERIC_COLUMN_FORMATS: readonly ReportColumnFormat[] = [
  "money",
  "quantity",
  "integer",
  "percent",
];
