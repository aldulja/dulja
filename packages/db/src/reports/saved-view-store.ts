import type { Sql } from "postgres";
import { parseReportDefinition } from "@dulja/domain";
import { ReportError } from "./errors";

/**
 * The `saved_view` store (7A Task 13, contracts §4.11.2, ADR 0067). A saved view is personal state — a named
 * parameter set its owner bookmarks — so it carries no permission code (§3.6.1 names none). Its gates are RLS
 * (the tenant), the company predicate every function takes, `owner_principal_id = app.current_actor()` for a
 * write, and the `shared` flag for a read. Archived, never deleted (spec:2049).
 */
export interface SavedViewRow {
  id: string;
  companyId: string;
  reportDefinitionId: string;
  nameEn: string;
  nameAr: string | null;
  parameters: Readonly<Record<string, string>>;
  ownerPrincipalId: string;
  shared: boolean;
  archivedAt: string | null;
  createdAt: string;
}

/** `created_at` keeps its microseconds: it is the list's keyset, and a cursor truncated to milliseconds would
 *  skip every view created later in the same millisecond as the page's last one (the run-store rule). */
function selectList(tx: Sql) {
  return tx`v.id, v.company_id, v.report_definition_id, v.name_en, v.name_ar, v.parameters,
            v.owner_principal_id, v.shared,
            to_char(v.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as archived_at,
            to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
}

interface RawView {
  id: string;
  company_id: string;
  report_definition_id: string;
  name_en: string;
  name_ar: string | null;
  parameters: Record<string, string>;
  owner_principal_id: string;
  shared: boolean;
  archived_at: string | null;
  created_at: string;
}

function toRow(raw: RawView): SavedViewRow {
  return {
    id: raw.id,
    companyId: raw.company_id,
    reportDefinitionId: raw.report_definition_id,
    nameEn: raw.name_en,
    nameAr: raw.name_ar,
    parameters: raw.parameters,
    ownerPrincipalId: raw.owner_principal_id,
    shared: raw.shared,
    archivedAt: raw.archived_at,
    createdAt: raw.created_at,
  };
}

/**
 * The definition must be a live one of the SAME company — the composite FK binds only the tenant, so without
 * this predicate a view of company A could name company B's definition — and the view's parameters must be a
 * subset of the definition's own declaration, or the bookmark would fail at render time rather than at save
 * time. A view may leave a required parameter out: the run that starts from it supplies the rest.
 */
async function assertParameters(
  tx: Sql,
  companyId: string,
  reportDefinitionId: string,
  parameters: Readonly<Record<string, string>>,
): Promise<void> {
  const [row] = await tx<{ definition: unknown }[]>`
    select definition from app.report_definition
     where id = ${reportDefinitionId}::uuid and company_id = ${companyId}::uuid
       and archived_at is null`;
  if (row === undefined) {
    throw new ReportError(
      "ERR_NOT_FOUND",
      `report definition ${reportDefinitionId} was not found in company ${companyId} or is archived`,
    );
  }
  const declared = new Set(parseReportDefinition(row.definition).parameters.map((p) => p.name));
  const unknown = Object.keys(parameters).filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `report definition ${reportDefinitionId} declares no such parameter: ${unknown.join(", ")}`,
    );
  }
}

export async function createSavedView(
  tx: Sql,
  input: {
    companyId: string;
    reportDefinitionId: string;
    nameEn: string;
    nameAr?: string | null;
    parameters: Readonly<Record<string, string>>;
    shared?: boolean;
  },
): Promise<SavedViewRow> {
  await assertParameters(tx, input.companyId, input.reportDefinitionId, input.parameters);
  // owner_principal_id takes its column default `app.current_actor()`: the owner is the session's, never a
  // payload field (§3.3's rule for attributed columns, SAH-044's lesson).
  const [raw] = await tx<RawView[]>`
    insert into app.saved_view as v
      (tenant_id, company_id, report_definition_id, name_en, name_ar, parameters, shared)
    values (app.current_tenant(), ${input.companyId}::uuid, ${input.reportDefinitionId}::uuid,
            ${input.nameEn}, ${input.nameAr ?? null},
            ${JSON.stringify(input.parameters)}::text::jsonb, ${input.shared ?? false})
    returning ${selectList(tx)}`;
  return toRow(raw!);
}

export async function getSavedView(tx: Sql, id: string): Promise<SavedViewRow | null> {
  const [raw] = await tx<RawView[]>`
    select ${selectList(tx)} from app.saved_view v where v.id = ${id}::uuid`;
  return raw === undefined ? null : toRow(raw);
}

/** The caller's OWN live views plus the company's shared ones, newest first. RLS is tenant-wide, so the
 *  owner-or-shared predicate is what keeps a colleague's private bookmark private. */
export async function listSavedViews(
  tx: Sql,
  params: {
    companyId: string;
    reportDefinitionId?: string | undefined;
    limit: number;
    cursor?: { createdAt: string; id: string } | null;
  },
): Promise<SavedViewRow[]> {
  const byDefinition =
    params.reportDefinitionId === undefined
      ? tx``
      : tx`and v.report_definition_id = ${params.reportDefinitionId}::uuid`;
  const keyset =
    params.cursor == null
      ? tx``
      : tx`and (v.created_at, v.id) < (${params.cursor.createdAt}::timestamptz, ${params.cursor.id}::uuid)`;
  const raws = await tx<RawView[]>`
    select ${selectList(tx)}
      from app.saved_view v
     where v.company_id = ${params.companyId}::uuid
       and v.archived_at is null
       and (v.owner_principal_id = app.current_actor() or v.shared)
       ${byDefinition} ${keyset}
     order by v.created_at desc, v.id desc
     limit ${Math.min(Math.max(params.limit, 1), 1001)}`;
  return raws.map(toRow);
}

/** The owner, compared with `app.current_actor()` in SQL — the authority, never a handler's copy of it. */
async function assertOwner(tx: Sql, id: string): Promise<SavedViewRow> {
  const view = await getSavedView(tx, id);
  if (view === null) throw new ReportError("ERR_NOT_FOUND", `saved view ${id} was not found`);
  const [row] = await tx<{ owner: boolean }[]>`
    select ${view.ownerPrincipalId}::uuid = app.current_actor() as owner`;
  if (row?.owner !== true) {
    // ERR_RBAC_FORBIDDEN (403), not ERR_VALIDATION_FAILED: the request is well formed; the caller is simply
    // not this bookmark's owner. `shared` makes a view readable, never writable.
    throw new ReportError(
      "ERR_RBAC_FORBIDDEN",
      `only its owner may change a saved view; view ${id} belongs to another principal`,
    );
  }
  return view;
}

/** Only the owner may change a view; anyone else gets `ERR_RBAC_FORBIDDEN` from the store. */
export async function updateSavedView(
  tx: Sql,
  input: {
    id: string;
    nameEn?: string | undefined;
    nameAr?: string | null | undefined;
    parameters?: Readonly<Record<string, string>> | undefined;
    shared?: boolean | undefined;
  },
): Promise<SavedViewRow> {
  const view = await assertOwner(tx, input.id);
  if (view.archivedAt !== null) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `saved view ${input.id} is archived and cannot be changed`,
    );
  }
  if (input.parameters !== undefined) {
    await assertParameters(tx, view.companyId, view.reportDefinitionId, input.parameters);
  }
  const [raw] = await tx<RawView[]>`
    update app.saved_view v
       set name_en    = ${input.nameEn ?? view.nameEn},
           name_ar    = ${input.nameAr === undefined ? view.nameAr : input.nameAr},
           parameters = ${JSON.stringify(input.parameters ?? view.parameters)}::text::jsonb,
           shared     = ${input.shared ?? view.shared}
     where v.id = ${input.id}::uuid and v.archived_at is null
    returning ${selectList(tx)}`;
  if (raw === undefined) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `saved view ${input.id} is archived and cannot be changed`,
    );
  }
  return toRow(raw);
}

/** Archived, never deleted (spec:2049, hazard 25); `app_rw` holds no DELETE on this table. Archiving an
 *  already-archived view is a no-op, which is what makes the route's DELETE idempotent in fact. */
export async function archiveSavedView(tx: Sql, id: string): Promise<void> {
  await assertOwner(tx, id);
  await tx`update app.saved_view set archived_at = now() where id = ${id}::uuid and archived_at is null`;
}
