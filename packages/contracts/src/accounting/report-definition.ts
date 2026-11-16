import { z } from "zod";
import { CursorSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/**
 * Slice 7A Task 13 — the report-definition wire shapes (contracts §4.11.2): clone and edit a report without a
 * release (spec:2293). The DEFINITION body itself is validated once, by `validateReportDefinition` and the
 * field check in the store (`packages/db/src/reports/definition-store.ts`), whose `errors[]` are JSON Pointers
 * into the definition. A second closed shape here would be two spellings of one format (hazard 9) and would
 * answer the same fault with two different sets of paths.
 */

/** §4.16.1's code grammar: exactly two segments, the first a module. The same pattern as `@dulja/domain`'s
 *  `REPORT_CODE_PATTERN`; repeated as a literal only because a Zod regex is what the OpenAPI document shows. */
export const ReportDefinitionCodeSchema = z
  .string()
  .regex(/^(accounting|inventory|hr|pos)\.[a-z][a-z0-9_]{2,47}$/);

/** A definition as the API returns it. `loose`, so every member the JSON Schema
 *  (`packages/domain/report-definition.schema.json`) carries reaches the wire without a second spelling. */
export const ReportDefinitionDocumentSchema = z
  .object({
    version: z.literal(1),
    code: ReportDefinitionCodeSchema,
    nameEn: z.string(),
    nameAr: z.string(),
    module: z.enum(["accounting", "inventory", "hr", "pos"]),
    permission: z.string(),
  })
  .loose();

/** A definition as a request carries it: any JSON object, validated in full by the store. */
export const ReportDefinitionInputSchema = z.record(z.string(), z.unknown());

export const ReportDefinitionSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  code: ReportDefinitionCodeSchema,
  /** The ROW version (`app.report_definition.version`) — never `definition.version`, the format version. */
  version: z.number().int().positive(),
  definition: ReportDefinitionDocumentSchema,
  clonedFrom: UuidSchema.nullable(),
  isCore: z.boolean(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

export const CreateReportDefinitionBody = z
  .object({ definition: ReportDefinitionInputSchema })
  .strict();

/** A tenant version is edited in place; a core version refuses and says to clone it. */
export const UpdateReportDefinitionBody = z
  .object({ definition: ReportDefinitionInputSchema })
  .strict();

/** Every member optional: a clone with no overrides is a verbatim copy at the next version. The overrides are
 *  shallow-merged over the source and the result validated in full; `code` may not change. */
export const CloneReportDefinitionBody = z
  .object({ overrides: z.record(z.string(), z.unknown()).optional() })
  .strict();

/** Literal `filter[<field>][eq]` keys (§4.2.8 Layer 2), `strict` so an unknown filter is a 400. */
export const ReportDefinitionQuery = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    "filter[code][eq]": ReportDefinitionCodeSchema.optional(),
    "filter[archived][eq]": z.enum(["true", "false"]).optional(),
  })
  .strict();

export const ReportDefinitionList = ListEnvelope(ReportDefinitionSchema);
export type ReportDefinitionDto = z.infer<typeof ReportDefinitionSchema>;
