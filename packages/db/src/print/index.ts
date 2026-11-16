import type { Sql } from "postgres";
import {
  buildPrintModel,
  htmlEscape,
  parseTemplateSource,
  renderTemplate,
  TemplateError,
  TemplateSourceError,
  typstEscape,
  type PrintModel,
} from "@dulja/domain";
import { loadSnapshot, PostingError } from "../posting";
import {
  loadPrintContext,
  PrintError,
  resolvePrintTemplate,
  type PrintTemplateRow,
} from "./template";

export interface RenderedDocument {
  /** The template text with the model substituted — NOT a PDF. */
  rendered: string;
  /** The row's ADR-0016 code; the API maps it to an adapter. */
  engine: string;
  paper: string;
  templateId: string;
  templateCode: string;
  templateVersion: number;
  /** "JV-000017-en" — the Content-Disposition stem, no extension. */
  fileStem: string;
  /** Returned so a test can assert the model without re-deriving it. */
  model: PrintModel;
}

/**
 * HTML escaping for the engine ADR 0016 chose; Typst escaping is kept reachable because the renderer is
 * engine-neutral by design (`typstEscape` ships in `@dulja/domain` for the same reason). Migration 0026's
 * CHECK admits `chromium` alone today, so the second branch is exercised by nothing until the ADR 0016
 * Alternatives path is taken. No raw-output form exists in either case.
 */
function escapeFor(engine: string): (value: string) => string {
  return engine === "typst" ? typstEscape : htmlEscape;
}

/** `JV-000017-en`; an unissued document has no number, so its stem carries the id's last 12 characters. */
function fileStem(row: { series: string; number: string; id: string }, lang: string): string {
  const tail = row.number === "" ? row.id.slice(-12) : row.number.padStart(6, "0");
  return `${row.series === "" ? "DOC" : row.series}-${tail}-${lang}`;
}

/**
 * Loads the document, its context and its template, builds the print model and substitutes it into the
 * template body. Returns **template text**, not a PDF: the engine adapters live in `apps/api` (a browser
 * is not `packages/db`'s business) and take this string as their input.
 */
export async function renderDocumentSource(
  tx: Sql,
  params: { documentId: string; templateCode?: string; lang: "en" | "ar" },
): Promise<RenderedDocument> {
  // Narrow on purpose: only 1A's own "no such document" becomes a PrintError. A connection failure, an
  // RLS denial or a bug must keep its own identity and reach the API's 500 path, not be reported to the
  // operator as a missing document.
  const snapshot = await loadSnapshot(tx, params.documentId).catch((e: unknown) => {
    if (e instanceof PostingError && e.code === "ERR_NOT_FOUND") {
      throw new PrintError("ERR_NOT_FOUND", `document ${params.documentId} not found`);
    }
    throw e;
  });

  const [typeRow] = await tx<{ documentTypeId: string }[]>`
    select document_type_id as "documentTypeId" from app.document where id = ${params.documentId}`;
  if (!typeRow) throw new PrintError("ERR_NOT_FOUND", `document ${params.documentId} not found`);

  const template: PrintTemplateRow = await resolvePrintTemplate(tx, {
    companyId: snapshot.header.companyId,
    documentTypeId: typeRow.documentTypeId,
    ...(params.templateCode === undefined ? {} : { templateCode: params.templateCode }),
  });

  const context = await loadPrintContext(tx, params.documentId, params.lang);

  let meta: { labels: { en: Record<string, string>; ar: Record<string, string> } };
  let body: string;
  try {
    ({ meta, body } = parseTemplateSource(template.source));
  } catch (e) {
    if (!(e instanceof TemplateSourceError)) throw e;
    throw new PrintError(
      "ERR_VALIDATION_FAILED",
      `print template ${template.code} v${template.version} has an unreadable source: ${e.message}`,
    );
  }

  const model = buildPrintModel(snapshot, { ...context, lang: params.lang, labels: meta.labels });

  let rendered: string;
  try {
    rendered = renderTemplate(body, model, escapeFor(template.engine));
  } catch (e) {
    if (!(e instanceof TemplateError)) throw e;
    throw new PrintError(
      "ERR_VALIDATION_FAILED",
      `print template ${template.code} v${template.version} failed to render: ${e.message}`,
    );
  }

  return {
    rendered,
    engine: template.engine,
    paper: template.paper,
    templateId: template.id,
    templateCode: template.code,
    templateVersion: template.version,
    fileStem: fileStem(
      { series: model.document.series, number: model.document.number, id: params.documentId },
      params.lang,
    ),
    model,
  };
}

export {
  DEFAULT_TEMPLATE_CODE,
  loadPrintContext,
  PrintError,
  resolvePrintTemplate,
  type PrintTemplateRow,
} from "./template";
