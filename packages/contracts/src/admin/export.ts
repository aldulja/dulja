import { z } from "zod";
import { CursorSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/**
 * Slice 7C Task 9 — the tenant data export's wire shapes (spec:2186, 2206, 2211; contracts §4.2.8 as amended
 * by 7C A14; ADR 0069/0070). The vocabularies are `app.export_job`'s CHECKs (migration 0078), so a value
 * outside them is a 400 here and never a 23514 there.
 */
export const ExportFormatSchema = z.enum(["csv", "json", "both"]);
export const ExportStatusSchema = z.enum(["queued", "running", "done", "failed"]);

export const CreateExportBody = z
  .object({
    /** spec:2186 "CSV + JSON + a documented schema": both by default; `schema.json` is in every archive. */
    format: ExportFormatSchema.default("both"),
    /** spec:1067: attachments are included by default, filtered by the requester's module read codes. */
    includeAttachments: z.boolean().default(true),
  })
  .strict();

export const ExportAcceptedSchema = z.object({
  exportJobId: UuidSchema,
  /** The pg-boss job id, for log correlation only. `/v1/jobs/{jobId}` (9B, round 20 C2/C17) answers only a job
   *  with no resource of its own, and an export has one (ADR 0067), so this id addresses nothing there. */
  jobId: z.string().min(1),
  /** spec:2206's status resource — `/v1/companies/<companyId>/exports/<exportJobId>`, the shape 7A's report
   *  run answers with. */
  statusUrl: z.string().min(1),
});

/** `manifest.json` as the archive carries it (ADR 0069). No object-store key appears in it (SAH-038). */
export const ExportManifestSchema = z.object({
  formatVersion: z.literal(1),
  exportJobId: UuidSchema,
  companyId: UuidSchema,
  generatedAt: z.string(),
  format: ExportFormatSchema,
  tables: z.array(
    z.object({
      name: z.string(),
      rowCount: z.number().int(),
      gate: z.string().nullable(),
      files: z.array(z.string()),
    }),
  ),
  /** Every table the requester's gates kept out, with the gate — an incomplete export is visibly incomplete. */
  excluded: z.array(z.object({ table: z.string(), gate: z.string() })),
  /** Rows kept out of a table that IS in the archive — a gated module's documents' rows, with the gate that would
   *  admit them (Phase 8 review: an `hr` document's rows without `hr.payroll.read`). */
  excludedRows: z.array(z.object({ table: z.string(), gate: z.string(), module: z.string() })),
  attachments: z.array(
    z.object({
      id: UuidSchema,
      fileName: z.string(),
      byteSize: z.number().int(),
      sha256: z.string(),
      path: z.string(),
    }),
  ),
  attachmentsOmitted: z.array(
    z.object({
      id: UuidSchema,
      reason: z.enum(["module_not_readable", "object_missing", "digest_mismatch"]),
    }),
  ),
});

export const ExportJobSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  requestedBy: UuidSchema,
  format: ExportFormatSchema,
  status: ExportStatusSchema,
  /** The modules whose attachments the requester could read when they asked (ADR 0070). */
  readableModules: z.array(z.string()),
  /** Whether the requester held `inventory.item.read`, the lot-attachment gate, when they asked. */
  lotAttachments: z.boolean(),
  includeAttachments: z.boolean(),
  tableCount: z.number().int().nullable(),
  /** `bigint` on the wire is a decimal string (§3.2). */
  rowCount: z.string().nullable(),
  byteSize: z.string().nullable(),
  /** Lower-case hex of the archive, once `done` — the digest a tenant verifies a download against. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  manifest: ExportManifestSchema.nullable(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  /** `ERR_<CODE>: detail`, once `failed`. */
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  // `object_key` is deliberately NOT on the wire: the content route is the only way to the bytes (SAH-038).
});
export type ExportJobDto = z.infer<typeof ExportJobSchema>;

/** Literal `filter[…]` keys — §4.2.8 Layer 2's default. `strict`, so a filter on any other field is refused
 *  rather than silently ignored. */
export const ExportJobQuery = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    "filter[status][eq]": ExportStatusSchema.optional(),
  })
  .strict();

export const ExportJobList = ListEnvelope(ExportJobSchema);
