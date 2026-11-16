import { z } from "zod";
import { CursorSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/**
 * Slice 7A Task 12 — the report run's wire shapes (contracts §4.11.2, ADR 0067). The three vocabularies are
 * the `report_run` CHECKs of migration 0075, so a value outside them is a 400 here and never a 23514 there.
 */
export const ReportFormatSchema = z.enum(["pdf", "xlsx", "csv"]);
export const ReportLangSchema = z.enum(["en", "ar"]);
export const ReportRunStatusSchema = z.enum(["queued", "running", "done", "failed"]);

/** Every parameter value travels as a STRING: a date is `YYYY-MM-DD`, an id a uuid, an amount a decimal
 *  string. The dataset's per-column kind is what casts it (Task 5), so a JSON number can never become a
 *  monetary value on the way in (spec:2041). The key grammar is the definition schema's parameter name. */
export const ReportParametersSchema = z.record(
  z.string().regex(/^[a-z][A-Za-z0-9]{0,47}$/),
  z.string().max(200),
);

export const CreateReportRunBody = z
  .object({
    /** Omit to use the highest non-archived version of `{code}`; pass it to pin a version or a tenant clone. */
    reportDefinitionId: UuidSchema.optional(),
    /** The saved view this run was started from, recorded on the run; it must be a live view of the same
     *  definition in the same company that the caller owns or that is shared. */
    savedViewId: UuidSchema.optional(),
    parameters: ReportParametersSchema.default({}),
    format: ReportFormatSchema,
    lang: ReportLangSchema,
  })
  .strict();

export const ReportRunAcceptedSchema = z.object({
  runId: UuidSchema,
  /** The pg-boss job id, for correlating the run with the worker's log lines. */
  jobId: z.string().min(1),
  /** The run resource — ADR 0067. NOT `/v1/jobs/<jobId>`: 9B mounts that path only for a job with no resource of its
   *  own (round 20 C2), and a report run has one. */
  statusUrl: z.string().min(1),
});

export const ReportRunSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  reportDefinitionId: UuidSchema,
  savedViewId: UuidSchema.nullable(),
  parameters: ReportParametersSchema,
  format: ReportFormatSchema,
  lang: ReportLangSchema,
  status: ReportRunStatusSchema,
  requestedBy: UuidSchema,
  /** Lower-case hex of the stored bytes, once `done`. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  finishedAt: TimestampSchema.nullable(),
  /** `ERR_<CODE>: detail`, once `failed`. */
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  // `object_key` is deliberately NOT on the wire: it is a store path, and the content route is the only way to
  // reach the bytes (SAH-038 — an artefact's storage identity is a side channel, as an attachment's is).
});

/**
 * Literal `filter[<field>][eq]` keys — §4.2.8 Layer 2's default mechanism. Four fields, one operator, so
 * enumerating them is typed, checked by Zod and visible in the generated OpenAPI document. `strict`, so a
 * filter on any other field (`object_key`, `sha256`) is refused rather than silently ignored.
 */
export const ReportRunQuery = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    "filter[status][eq]": ReportRunStatusSchema.optional(),
    "filter[format][eq]": ReportFormatSchema.optional(),
    "filter[lang][eq]": ReportLangSchema.optional(),
    "filter[report_definition_id][eq]": UuidSchema.optional(),
  })
  .strict();

export const ReportRunList = ListEnvelope(ReportRunSchema);
export type ReportRunDto = z.infer<typeof ReportRunSchema>;
