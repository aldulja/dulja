import type { Sql } from "postgres";
import type { PrintContext } from "@dulja/domain";

/**
 * Declared HERE, in the leaf, and re-exported from `./index` — so `template.ts` needs no import from
 * `index.ts` and there is no cycle to work around. `packages/db` cannot import `AppError`: 0B's
 * `dependency-rule` lint pins this package to `@dulja/domain`, which is contracts §4.2.4's declared
 * `PostingError` exception applied to the same situation. The API translates: `ERR_NOT_FOUND` → 404,
 * `ERR_VALIDATION_FAILED` → 400 with the detail as the message.
 */
export class PrintError extends Error {
  constructor(
    readonly code: "ERR_NOT_FOUND" | "ERR_VALIDATION_FAILED",
    readonly detail: string,
  ) {
    super(detail);
    this.name = "PrintError";
  }
}

export interface PrintTemplateRow {
  id: string;
  companyId: string;
  documentTypeId: string;
  code: string;
  version: number;
  nameEn: string;
  nameAr: string | null;
  engine: string;
  paper: string;
  source: string;
}

/**
 * The default template code when a print request names none. It matches the seed file
 * `packages/db/seed/my/templates/<TYPE>.standard.v1.json` (Task 7), so a tenant that has only seeded
 * templates never has to send a code.
 */
export const DEFAULT_TEMPLATE_CODE = "standard";

/**
 * The highest `version` of `(document_type_id, code)`. `app.print_template` is never deleted and never
 * archived (Global Constraint 8) — a new version supersedes, so "latest" is `max(version)`.
 */
export async function resolvePrintTemplate(
  tx: Sql,
  params: { companyId: string; documentTypeId: string; templateCode?: string },
): Promise<PrintTemplateRow> {
  const code = params.templateCode ?? DEFAULT_TEMPLATE_CODE;
  const [row] = await tx<PrintTemplateRow[]>`
    select id, company_id as "companyId", document_type_id as "documentTypeId",
           code, version, name_en as "nameEn", name_ar as "nameAr", engine, paper, source
      from app.print_template
     where company_id = ${params.companyId}
       and document_type_id = ${params.documentTypeId}
       and code = ${code}
     order by version desc
     limit 1`;
  if (!row) {
    throw new PrintError(
      "ERR_NOT_FOUND",
      `no print template '${code}' for document type ${params.documentTypeId} in company ${params.companyId}`,
    );
  }
  return row;
}

/**
 * Everything `buildPrintModel` needs that the posting snapshot does not carry: the company's display
 * name, the document type's two names, the party's name and a label per account the document touches.
 * One query per concern, all under the caller's RLS session — a row another tenant owns is simply absent.
 *
 * `app.company` has a single `name` (0001), but `app.party` and `app.account` have `name_en` and a
 * NULLABLE `name_ar` (contracts §4.5.7; migrations 0001 and 0017) — there is no `name` column on either,
 * and selecting one is a `42703`. So `lang` picks, with English as the explicit fallback when the Arabic
 * name was never entered: an Arabic print of a party that has only `name_en` shows `name_en`,
 * deliberately, rather than an empty cell.
 */
export async function loadPrintContext(
  tx: Sql,
  documentId: string,
  lang: "en" | "ar",
): Promise<Omit<PrintContext, "lang" | "labels">> {
  const ar = lang === "ar";
  const [head] = await tx<
    {
      companyName: string;
      typeNameEn: string;
      typeNameAr: string | null;
      partyName: string | null;
      notes: string | null;
    }[]
  >`
    select c.name       as "companyName",
           dt.name_en   as "typeNameEn",
           dt.name_ar   as "typeNameAr",
           case when ${ar} then coalesce(p.name_ar, p.name_en) else p.name_en end as "partyName",
           d.notes      as "notes"
      from app.document d
      join app.company c        on c.id = d.company_id
      join app.document_type dt on dt.id = d.document_type_id
      left join app.party p     on p.id = d.party_id
     where d.id = ${documentId}`;
  if (!head) throw new PrintError("ERR_NOT_FOUND", `document ${documentId} not found`);

  const labelRows = await tx<{ id: string; label: string }[]>`
    select a.id,
           a.code || ' · ' || case when ${ar} then coalesce(a.name_ar, a.name_en) else a.name_en end as label
      from app.document_line l
      join app.account a on a.id = l.account_id
     where l.document_id = ${documentId}`;

  const accountLabels: Record<string, string> = {};
  for (const r of labelRows) accountLabels[r.id] = r.label;

  return {
    companyName: head.companyName,
    documentTypeNameEn: head.typeNameEn,
    documentTypeNameAr: head.typeNameAr,
    partyName: head.partyName,
    // `document.notes` is migration 0027's column (the expand half, ADR 0033); null prints as nothing.
    notes: head.notes,
    accountLabels,
  };
}
