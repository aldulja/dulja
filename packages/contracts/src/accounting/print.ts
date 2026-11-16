import { z } from "zod";

/** contracts §4.5.9. Both directions are first-class; there is no default (spec:2253 — parity, not a fallback). */
export const PrintLangSchema = z.enum(["en", "ar"]);

export const PrintDocumentBody = z
  .object({
    /** Omitted means `standard` — `DEFAULT_TEMPLATE_CODE` in `@dulja/db`. */
    templateCode: z.string().min(1).max(64).optional(),
    lang: PrintLangSchema,
  })
  .strict();

export type PrintLang = z.infer<typeof PrintLangSchema>;
