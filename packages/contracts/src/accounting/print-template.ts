import { z } from "zod";
import { ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/** ADR 0016's Decision: the closed value set of `print_template.engine` is `{chromium}` — the same set as
 *  the column's CHECK (migration 0026). Widening it is a later migration plus an adapter, never a schema edit. */
export const PrintEngineSchema = z.enum(["chromium"]);
/** §4.5.9's registered paper vocabulary; 7A's `layout.paper` is constrained by the same three values. */
export const PaperSchema = z.enum(["A4", "A5", "receipt"]);
export const TemplateLabelsSchema = z.object({
  en: z.record(z.string(), z.string()),
  ar: z.record(z.string(), z.string()),
});

export const PrintTemplateSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  documentTypeId: UuidSchema,
  documentTypeCode: z.string(),
  code: z.string(),
  version: z.number().int().positive(),
  nameEn: z.string(),
  nameAr: z.string().nullable(),
  engine: PrintEngineSchema,
  paper: PaperSchema,
  /** front matter + body, exactly as stored (spec:1240 "diffable") */
  source: z.string(),
  createdAt: TimestampSchema,
});

export const CreatePrintTemplateBody = z
  .object({
    documentTypeCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    code: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    version: z.number().int().positive(),
    nameEn: z.string().min(1),
    nameAr: z.string().nullable().optional(),
    engine: PrintEngineSchema,
    paper: PaperSchema.default("A4"),
    labels: TemplateLabelsSchema,
    body: z.string().min(1),
  })
  .strict();

export const PrintTemplateList = ListEnvelope(PrintTemplateSchema);
export type PrintTemplateDto = z.infer<typeof PrintTemplateSchema>;
