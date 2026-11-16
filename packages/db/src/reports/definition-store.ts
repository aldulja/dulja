import type { Sql } from "postgres";
import {
  ReportDefinitionError,
  parseReportDefinition,
  validateReportDefinition,
  type ReportDefinition,
} from "@dulja/domain";
import { DATASET_IDS } from "./datasets";
import { ReportError } from "./errors";
import { assertDefinitionFields } from "./statement";

/**
 * The `report_definition` store (7A Task 13, contracts §4.11.2) — the configuration half of "a user clones and
 * edits a report without a release" (spec:2293). Every function takes the caller's `withTenant` transaction;
 * RLS bounds the tenant and the route passes the company it cleared.
 */
export interface ReportDefinitionRow {
  id: string;
  companyId: string;
  code: string;
  version: number;
  definition: ReportDefinition;
  clonedFrom: string | null;
  isCore: boolean;
  archivedAt: string | null;
  createdAt: string;
}

export interface ReportDefinitionSetsSource {
  datasets: ReadonlySet<string>;
  permissions: ReadonlySet<string>;
}

/**
 * The two closed sets `validateReportDefinition` needs, read from where they live at run time: `DATASET_IDS`
 * (this package) and `select code from app.permission` (global). `packages/db` may not import
 * `@dulja/contracts` (§3.1), and `permission-catalogue.test.ts` asserts the table equals `PERMISSIONS` in both
 * directions, so the two sources cannot disagree — 1A's `loadDocumentTypes` decision applied here.
 */
export async function reportDefinitionSets(tx: Sql): Promise<ReportDefinitionSetsSource> {
  const rows = await tx<{ code: string }[]>`select code from app.permission`;
  return { datasets: new Set(DATASET_IDS), permissions: new Set(rows.map((r) => r.code)) };
}

function selectList(tx: Sql) {
  return tx`d.id, d.company_id, d.code, d.version, d.definition, d.cloned_from, d.is_core,
            to_char(d.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as archived_at,
            to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at`;
}

interface RawDefinition {
  id: string;
  company_id: string;
  code: string;
  version: number;
  definition: unknown;
  cloned_from: string | null;
  is_core: boolean;
  archived_at: string | null;
  created_at: string;
}

function toRow(raw: RawDefinition): ReportDefinitionRow {
  return {
    id: raw.id,
    companyId: raw.company_id,
    code: raw.code,
    version: raw.version,
    definition: parseReportDefinition(raw.definition),
    clonedFrom: raw.cloned_from,
    isCore: raw.is_core,
    archivedAt: raw.archived_at,
    createdAt: raw.created_at,
  };
}

export async function getReportDefinition(
  tx: Sql,
  id: string,
): Promise<ReportDefinitionRow | null> {
  const [raw] = await tx<RawDefinition[]>`
    select ${selectList(tx)} from app.report_definition d where d.id = ${id}::uuid`;
  return raw === undefined ? null : toRow(raw);
}

export interface ListDefinitionsParams {
  companyId: string;
  code?: string | undefined;
  includeArchived?: boolean | undefined;
  limit: number;
  cursor?: { code: string; version: number } | null;
}

/** Keyset-paged on `(code, version)`, both ascending — the unique key, so a page boundary never splits a row. */
export async function listReportDefinitions(
  tx: Sql,
  params: ListDefinitionsParams,
): Promise<ReportDefinitionRow[]> {
  const byCode = params.code === undefined ? tx`` : tx`and d.code = ${params.code}`;
  const archived = params.includeArchived === true ? tx`` : tx`and d.archived_at is null`;
  const keyset =
    params.cursor == null
      ? tx``
      : tx`and (d.code, d.version) > (${params.cursor.code}, ${params.cursor.version}::int)`;
  const raws = await tx<RawDefinition[]>`
    select ${selectList(tx)}
      from app.report_definition d
     where d.company_id = ${params.companyId}::uuid ${byCode} ${archived} ${keyset}
     order by d.code asc, d.version asc
     limit ${Math.min(Math.max(params.limit, 1), 1001)}`;
  return raws.map(toRow);
}

/**
 * `coalesce(max(version), 0) + 1` over EVERY version, archived ones included: reusing an archived version
 * number would collide on the unique key and make the history lie. Not `2`: 7B seeds a re-expressed code at
 * `version = 2` with an upsert (§4.16.1), and a clone that took `2` would be what that seed overwrote.
 */
export async function nextDefinitionVersion(
  tx: Sql,
  params: { companyId: string; code: string },
): Promise<number> {
  const [row] = await tx<{ next: number }[]>`
    select (coalesce(max(d.version), 0) + 1)::int as next
      from app.report_definition d
     where d.company_id = ${params.companyId}::uuid and d.code = ${params.code}`;
  return row!.next;
}

/**
 * Schema, grammar and the two closed sets (`validateReportDefinition`, whose JSON-Pointer `errors[]` reach the
 * wire through `ReportDefinitionError`), then THE one field check (`assertDefinitionFields`, Task 9) — the same
 * function the seed loader calls, so a definition written through the API and one shipped in a pack are held
 * to one rule, statement codes' three extra fields included.
 */
function assertValid(definition: unknown, sets: ReportDefinitionSetsSource): ReportDefinition {
  const result = validateReportDefinition(definition, sets);
  if (!result.ok) {
    throw new ReportDefinitionError(
      `report definition is invalid: ${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
      result.errors,
    );
  }
  const parsed = parseReportDefinition(definition);
  assertDefinitionFields(parsed);
  return parsed;
}

/**
 * The two rules a WRITE adds to validation (Phase 7 review, finding 1; ADR 0065's amendment). A run executes as
 * the tenant's system principal, so a definition's `permission` is the only gate on the rows it reads, and
 * `assertDatasetGate` (inside `assertValid`) only bounds that code to what the dataset admits. These close the
 * rest:
 *
 * 1. **A code's `dataset.source` is fixed by its existing versions** — archived ones included, in this company.
 *    A clone or an edit of `accounting.audit_log` reads `audit_log`, as its core does; a new source is a new
 *    report, which needs a §4.16.1 row like a new code.
 * 2. **The writer holds every gate involved**: the new `permission`, and every `permission` the code's existing
 *    versions carry — through `app.actor_has(code, company, null)`, the call the run route makes. So a writer
 *    cannot author a report over rows they could not read themselves, and cannot move a code from a stronger
 *    gate to a weaker sibling (`document` admits `accounting.report.read` and `inventory.stock.read`) unless
 *    they already hold both. `admin.company.manage` (the route's gate) stays necessary; it is no longer
 *    sufficient.
 *
 * Runs inside the caller's transaction after the `(company, code)` advisory lock, so a concurrent writer cannot
 * slip a different source in between the read and the insert.
 */
async function assertCodeVersionRules(
  tx: Sql,
  input: { companyId: string; definition: ReportDefinition },
): Promise<void> {
  const { definition } = input;
  const existing = await tx<{ source: string; permission: string }[]>`
    select distinct d.definition -> 'dataset' ->> 'source' as source,
                    d.definition ->> 'permission' as permission
      from app.report_definition d
     where d.company_id = ${input.companyId}::uuid and d.code = ${definition.code}`;
  const sources = [...new Set(existing.map((r) => r.source))];
  if (sources.length > 0 && !sources.includes(definition.dataset.source)) {
    const message = `'${definition.code}' reads '${sources.join("', '")}' in every version; a version may not read '${definition.dataset.source}' — a different dataset is a different report`;
    throw new ReportDefinitionError(`report definition is invalid: /dataset/source ${message}`, [
      { path: "/dataset/source", message },
    ]);
  }
  const required = [...new Set([definition.permission, ...existing.map((r) => r.permission)])];
  for (const code of required) {
    const [row] = await tx<{ ok: boolean }[]>`
      select app.actor_has(${code}, ${input.companyId}::uuid, null::uuid) as ok`;
    if (row?.ok !== true) {
      throw new ReportError(
        "ERR_RBAC_FORBIDDEN",
        `writing report '${definition.code}' requires the permission '${code}', which the caller does not hold in company ${input.companyId}`,
      );
    }
  }
}

export async function createReportDefinition(
  tx: Sql,
  input: {
    companyId: string;
    definition: unknown;
    isCore?: boolean;
    clonedFrom?: string | null;
  },
): Promise<ReportDefinitionRow> {
  const sets = await reportDefinitionSets(tx);
  const definition = assertValid(input.definition, sets);
  // Two concurrent creates or clones of one code would read the same max(version); the second would then
  // fail on the unique key as a 409. The transaction lock serialises them so both succeed in turn.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`report_definition:${input.companyId}/${definition.code}`}, 0))`;
  await assertCodeVersionRules(tx, { companyId: input.companyId, definition });
  const version = await nextDefinitionVersion(tx, {
    companyId: input.companyId,
    code: definition.code,
  });
  const [raw] = await tx<RawDefinition[]>`
    insert into app.report_definition as d
      (tenant_id, company_id, code, version, definition, is_core, cloned_from)
    values (app.current_tenant(), ${input.companyId}::uuid, ${definition.code}, ${version},
            ${JSON.stringify(definition)}::text::jsonb, ${input.isCore ?? false},
            ${input.clonedFrom ?? null}::uuid)
    returning ${selectList(tx)}`;
  return toRow(raw!);
}

/**
 * The DoD's clone: `max(version) + 1`, `is_core = false`, `cloned_from` set. The overrides are applied over
 * the source definition and the RESULT is re-validated, so a clone is never invalid in a way its source was
 * not. A clone may not change `code`: the code is the identity a run resolves by, and a new code is a new
 * report that needs a §4.16.1 row.
 */
export async function cloneReportDefinition(
  tx: Sql,
  input: {
    companyId: string;
    sourceId: string;
    overrides?: Partial<ReportDefinition> | undefined;
  },
): Promise<ReportDefinitionRow> {
  const source = await getReportDefinition(tx, input.sourceId);
  if (source === null || source.companyId !== input.companyId) {
    throw new ReportError(
      "ERR_NOT_FOUND",
      `report definition ${input.sourceId} was not found in company ${input.companyId}`,
    );
  }
  const overrides = input.overrides ?? {};
  if (overrides.code !== undefined && overrides.code !== source.definition.code) {
    throw new ReportDefinitionError(`a clone keeps its source's code '${source.definition.code}'`, [
      {
        path: "/code",
        message: `a clone keeps its source's code '${source.definition.code}'; a new code is a new report and needs a contracts §4.16.1 row`,
      },
    ]);
  }
  return createReportDefinition(tx, {
    companyId: input.companyId,
    definition: { ...source.definition, ...overrides, code: source.definition.code },
    isCore: false,
    clonedFrom: source.id,
  });
}

/**
 * A tenant version is edited in place; a CORE version never is. A core row is the seed pack's and the pack is
 * re-applied after every deploy (§3.4.8), so an in-place edit would be silently reverted — a refusal that says
 * to clone is better than an edit that disappears.
 */
export async function updateReportDefinition(
  tx: Sql,
  input: { id: string; definition: unknown },
): Promise<ReportDefinitionRow> {
  const existing = await getReportDefinition(tx, input.id);
  if (existing === null) {
    throw new ReportError("ERR_NOT_FOUND", `report definition ${input.id} was not found`);
  }
  if (existing.isCore) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `report definition ${input.id} is a core definition; clone it and edit the clone (the seed pack re-applies core rows on every deploy)`,
    );
  }
  if (existing.archivedAt !== null) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `report definition ${input.id} is archived and cannot be edited`,
    );
  }
  const sets = await reportDefinitionSets(tx);
  const definition = assertValid(input.definition, sets);
  if (definition.code !== existing.code) {
    throw new ReportDefinitionError(`an edit cannot change a definition's code`, [
      {
        path: "/code",
        message: `an edit keeps the code '${existing.code}'; a new code is a new report`,
      },
    ]);
  }
  await tx`select pg_advisory_xact_lock(hashtextextended(${`report_definition:${existing.companyId}/${definition.code}`}, 0))`;
  await assertCodeVersionRules(tx, { companyId: existing.companyId, definition });
  const [raw] = await tx<RawDefinition[]>`
    update app.report_definition d
       set definition = ${JSON.stringify(definition)}::text::jsonb
     where d.id = ${input.id}::uuid and d.archived_at is null and not d.is_core
    returning ${selectList(tx)}`;
  if (raw === undefined) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `report definition ${input.id} is archived and cannot be edited`,
    );
  }
  return toRow(raw);
}

/** Archived, never deleted (spec:2049). `app_rw` holds no DELETE on this table (§3.5.4). */
export async function archiveReportDefinition(tx: Sql, id: string): Promise<void> {
  const rows = await tx`
    update app.report_definition set archived_at = now()
     where id = ${id}::uuid and archived_at is null`;
  if (rows.count === 0) {
    throw new ReportError(
      "ERR_NOT_FOUND",
      `report definition ${id} was not found or is already archived`,
    );
  }
}
