import type { Options } from "json-schema-to-typescript";

/** The exact header 1A's generator writes above the generated type. `policy-type.test.ts` strips it before
 *  comparing, and `generate-policy-type.ts` prepends it — one declaration, so they cannot disagree. */
export const POLICY_TYPE_BANNER = [
  "// GENERATED FILE — do not edit by hand.",
  "// Source: packages/domain/posting-policy.schema.json ($id urn:dulja:posting-policy:1)",
  "// Regenerate: bun run --cwd packages/domain policy:types",
  "",
].join("\n");

/** The exact options 1A's generator passes to `compile`. Changing one of these changes the committed file,
 *  so the drift test must read them from here rather than restate them (contracts §4.18). */
export const POLICY_TYPE_OPTIONS: Partial<Options> = {
  bannerComment: "",
  additionalProperties: false,
  style: { printWidth: 120, singleQuote: false },
};

/** The header `generate-report-type.ts` writes above the generated `ReportDefinition` (7A Task 4). */
export const REPORT_TYPE_BANNER = [
  "// GENERATED FILE — do not edit by hand.",
  "// Source: packages/domain/report-definition.schema.json ($id urn:dulja:report-definition:1)",
  "// Regenerate: bun run --cwd packages/domain report:types",
  "",
].join("\n");

/** The same option object as POLICY_TYPE_OPTIONS. Sharing it is what keeps the two generated files formatted
 *  identically; like the policy generator, the report generator prepends its banner rather than passing it. */
export const REPORT_TYPE_OPTIONS: Partial<Options> = { ...POLICY_TYPE_OPTIONS };

/** The header `generate-rate-table-type.ts` writes above the generated `RateTable` (8A Task 9). */
export const RATE_TABLE_TYPE_BANNER = [
  "// GENERATED FILE — do not edit by hand.",
  "// Source: packages/domain/payroll/rate-table.schema.json ($id urn:dulja:rate-table:1)",
  "// Regenerate: bun run --cwd packages/domain rate-table:types",
  "",
].join("\n");

/** The same option object as POLICY_TYPE_OPTIONS, shared for the reason REPORT_TYPE_OPTIONS is (§4.18 round 2). */
export const RATE_TABLE_TYPE_OPTIONS: Partial<Options> = { ...POLICY_TYPE_OPTIONS };
