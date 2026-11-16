export const TEMPLATE_FRONT_MATTER = "---dulja-template-v1";

export interface PrintTemplateMeta {
  labels: { en: Record<string, string>; ar: Record<string, string> };
}

export class TemplateSourceError extends Error {
  readonly code = "ERR_TEMPLATE_SOURCE_INVALID" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "TemplateSourceError";
  }
}

const SEPARATOR = "\n---\n";

/**
 * `app.print_template.source` is one column (§4.5.9) and a bilingual template needs its label pairs to
 * travel with its body, so the stored text is a JSON front-matter header followed by `---` and the body.
 * Labels are data, not i18next keys: `packages/domain` may import nothing internal (§3.1), and a template
 * a tenant authored through the API has no place in a shipped catalogue anyway (ADR 0032).
 */
export function parseTemplateSource(source: string): { meta: PrintTemplateMeta; body: string } {
  if (!source.startsWith(`${TEMPLATE_FRONT_MATTER}\n`)) {
    throw new TemplateSourceError(
      `a template source must begin with ${TEMPLATE_FRONT_MATTER} on its own line`,
    );
  }
  const afterHeader = source.slice(TEMPLATE_FRONT_MATTER.length + 1);
  const end = afterHeader.indexOf(SEPARATOR);
  if (end < 0) {
    throw new TemplateSourceError(
      "the front matter of a template source must be closed by a line containing exactly ---",
    );
  }
  let meta: unknown;
  try {
    meta = JSON.parse(afterHeader.slice(0, end));
  } catch (e) {
    throw new TemplateSourceError(`the front matter is not valid JSON: ${(e as Error).message}`);
  }
  const labels = (meta as { labels?: unknown } | null)?.labels as
    | PrintTemplateMeta["labels"]
    | undefined;
  if (!labels || typeof labels !== "object") {
    throw new TemplateSourceError("the front matter must carry `labels`");
  }
  for (const lang of ["en", "ar"] as const) {
    if (!labels[lang] || typeof labels[lang] !== "object") {
      throw new TemplateSourceError(
        `the front matter must carry labels.${lang} (both catalogues, spec:2061)`,
      );
    }
  }
  return {
    meta: { labels: { en: labels.en, ar: labels.ar } },
    body: afterHeader.slice(end + SEPARATOR.length),
  };
}

export function composeTemplateSource(meta: PrintTemplateMeta, body: string): string {
  return `${TEMPLATE_FRONT_MATTER}\n${JSON.stringify(meta)}${SEPARATOR}${body}`;
}
