import { z } from "zod";
import { CursorSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";
import { ReportParametersSchema } from "./report-run";

/**
 * Slice 7A Task 13 — the saved-view wire shapes (contracts §4.11.2, ADR 0067). A saved view is a named
 * parameter set over a definition; it carries no permission code (§3.6.1 names none), and its owner is the
 * session's principal, never a payload field.
 */
const ViewName = z.string().min(1).max(120);

export const SavedViewSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  reportDefinitionId: UuidSchema,
  nameEn: ViewName,
  nameAr: ViewName.nullable(),
  parameters: ReportParametersSchema,
  ownerPrincipalId: UuidSchema,
  shared: z.boolean(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

export const CreateSavedViewBody = z
  .object({
    reportDefinitionId: UuidSchema,
    nameEn: ViewName,
    nameAr: ViewName.optional(),
    parameters: ReportParametersSchema.default({}),
    shared: z.boolean().default(false),
    // `ownerPrincipalId` is deliberately ABSENT, and `strict` refuses it: the column defaults to
    // app.current_actor(), so a payload can never file a bookmark under another principal (§3.3, SAH-044).
  })
  .strict();

export const UpdateSavedViewBody = z
  .object({
    nameEn: ViewName.optional(),
    nameAr: ViewName.nullable().optional(),
    parameters: ReportParametersSchema.optional(),
    shared: z.boolean().optional(),
  })
  .strict();

export const SavedViewQuery = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    "filter[report_definition_id][eq]": UuidSchema.optional(),
  })
  .strict();

export const SavedViewList = ListEnvelope(SavedViewSchema);
export type SavedViewDto = z.infer<typeof SavedViewSchema>;
