import type { Context, MiddlewareHandler } from "hono";
import { AppError, DateSchema, UuidSchema } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { parseReportDefinition, type ReportDefinition } from "@dulja/domain";
import type { AppEnv } from "../context";
import { markExportRequestGate } from "../middleware/require-permission";

/**
 * `accounting.report.export` — 7A's own code, referenced by `PERMISSION[…]` so §3.6.3's handler-↔-catalogue
 * lint is satisfied in the same task that seeds the row. It cannot be `requirePermission` middleware on the
 * `POST …/runs`: the code is `mutating: false` (spec:2147) and `assertRouteGates` refuses a non-mutating gate
 * on an unsafe method at boot (§4.2.5). That boot check is deliberate and this is its intended escape:
 * spec:2163 gives the `auditor` export authority, and R7 forbids the auditor holding any mutating code.
 *
 * `app.actor_has(code, company_id, branch_id)` with a NULL branch asks for company-wide authority. The caller
 * passes the company the route already gated, never one read from the body (AGENTS.md: an entity id alone lets
 * a caller authorised for one company reach another's rows).
 */
export async function requireReportExport(c: Context<AppEnv>, companyId: string): Promise<void> {
  const code = PERMISSION["accounting.report.export"];
  const allowed = await c.var.withTenant(async (tx) => {
    const [row] = await tx<{ ok: boolean }[]>`
      select app.actor_has(${code}, ${companyId}::uuid, null::uuid) as ok`;
    return row?.ok === true;
  });
  if (!allowed) {
    throw new AppError(
      "ERR_RBAC_FORBIDDEN",
      `rendering a report requires '${code}' in company ${companyId}`,
    );
  }
}

/**
 * `requireReportExport` as the POST's route gate, marked for `assertRouteGates` (ADR 0067 decision 6). The
 * presence half of the boot check refuses an unsafe route with no gate mark at all, and its read-only half
 * refuses `accounting.report.export` on a POST unless the gate says it is an export request on a listed path.
 * It runs before any row is read, so a caller without export authority learns nothing about the company's
 * report catalogue (a 403 whether or not the code has a definition).
 */
export const reportExportRequestGate: MiddlewareHandler<AppEnv> = markExportRequestGate(
  async (c, next) => {
    const companyId = c.req.param("companyId");
    if (companyId === undefined || !UuidSchema.safeParse(companyId).success)
      throw new AppError("ERR_VALIDATION_FAILED", "companyId must be a UUID");
    await requireReportExport(c, companyId);
    await next();
  },
  PERMISSION["accounting.report.export"],
);

/**
 * The definition's own read code, resolved from DATA. `requirePermission` takes a compile-time
 * `PermissionCode` and a definition's `permission` is a jsonb value, so this is 2B's overrides-gate shape
 * (§4.5.3): an inline `app.actor_has` pre-flight inside `c.var.withTenant`, with the data layer still the
 * control. It narrows the route's gate and never widens it: the export code has already been evaluated.
 */
export async function requireReportRead(
  c: Context<AppEnv>,
  companyId: string,
  permission: string,
): Promise<void> {
  const allowed = await c.var.withTenant(async (tx) => {
    const [row] = await tx<{ ok: boolean }[]>`
      select app.actor_has(${permission}, ${companyId}::uuid, null::uuid) as ok`;
    return row?.ok === true;
  });
  if (!allowed) {
    throw new AppError(
      "ERR_RBAC_FORBIDDEN",
      `this report requires the permission '${permission}', which the caller does not hold in company ${companyId}`,
    );
  }
}

/**
 * `{code}` → the definition to run. With no `reportDefinitionId`, the highest non-archived `version` wins, so
 * a tenant's clone at `max(version) + 1` is what a plain run picks up (the DoD's "clones and edits without a
 * release") and 7B seeding `version = 2` of a core code promotes that version for everyone. A pinned id must
 * be a live definition of the same code in the same company.
 */
export async function resolveDefinitionForRun(
  c: Context<AppEnv>,
  companyId: string,
  code: string,
  reportDefinitionId?: string,
): Promise<{ id: string; definition: ReportDefinition }> {
  const row = await c.var.withTenant(async (tx) => {
    if (reportDefinitionId !== undefined) {
      const [pinned] = await tx<{ id: string; definition: unknown }[]>`
        select id, definition from app.report_definition
         where id = ${reportDefinitionId}::uuid and company_id = ${companyId}::uuid
           and code = ${code} and archived_at is null`;
      return pinned;
    }
    const [latest] = await tx<{ id: string; definition: unknown }[]>`
      select id, definition from app.report_definition
       where company_id = ${companyId}::uuid and code = ${code} and archived_at is null
       order by version desc limit 1`;
    return latest;
  });
  if (row === undefined) {
    // Never reveals cross-tenant existence: RLS reduced the table before the predicate ran (§4.2.4).
    throw new AppError(
      "ERR_NOT_FOUND",
      reportDefinitionId === undefined
        ? `no live report definition for code '${code}' in company ${companyId}`
        : `no live report definition ${reportDefinitionId} for code '${code}' in company ${companyId}`,
    );
  }
  return { id: row.id, definition: parseReportDefinition(row.definition) };
}

/**
 * A run started from a saved view records it, so the view must be one the caller could open: a live view of
 * the SAME definition in the SAME company, owned by the caller or shared. Any other id is a 404 — a foreign
 * company's view id must not become a reference on this company's run (AGENTS.md: an entity id alone).
 */
export async function assertSavedViewForRun(
  c: Context<AppEnv>,
  companyId: string,
  reportDefinitionId: string,
  savedViewId: string,
): Promise<void> {
  const [row] = await c.var.withTenant(
    (tx) => tx<{ id: string }[]>`
      select id from app.saved_view
       where id = ${savedViewId}::uuid and company_id = ${companyId}::uuid
         and report_definition_id = ${reportDefinitionId}::uuid and archived_at is null
         and (shared or owner_principal_id = app.current_actor())`,
  );
  if (row === undefined)
    throw new AppError(
      "ERR_NOT_FOUND",
      `no saved view ${savedViewId} of this report that the caller can open in company ${companyId}`,
    );
}

/** The parameter kinds whose value is an entity id. */
const ID_KINDS = new Set([
  "period",
  "account",
  "party",
  "item",
  "warehouse",
  "branch",
  "dimension_value",
]);

/**
 * The run's parameters against the definition's declaration: every `required` parameter present and
 * non-empty, no undeclared name, an id-kind value a UUID, a `date` a calendar date and an `enum` one of its
 * options. The errors are JSON Pointers into the body, which is what §4.2.4 lets `ERR_VALIDATION_FAILED`
 * carry; refusing here is a 400 the caller can fix, where the worker would only have failed the run.
 */
export function assertParameters(
  definition: ReportDefinition,
  parameters: Readonly<Record<string, string>>,
): void {
  const errors: { path: string; message: string }[] = [];
  for (const p of definition.parameters) {
    const value = parameters[p.name];
    if (value === undefined || value === "") {
      if (p.required)
        errors.push({ path: `/parameters/${p.name}`, message: "required parameter is missing" });
      continue;
    }
    if (ID_KINDS.has(p.kind) && !UuidSchema.safeParse(value).success)
      errors.push({ path: `/parameters/${p.name}`, message: `a ${p.kind} parameter is a UUID` });
    else if (p.kind === "date" && !DateSchema.safeParse(value).success)
      errors.push({ path: `/parameters/${p.name}`, message: "a date parameter is YYYY-MM-DD" });
    else if (p.kind === "enum" && !(p.options ?? ([] as readonly string[])).includes(value))
      errors.push({
        path: `/parameters/${p.name}`,
        message: `must be one of ${(p.options ?? []).join(", ")}`,
      });
  }
  for (const name of Object.keys(parameters))
    if (!definition.parameters.some((p) => p.name === name))
      errors.push({
        path: `/parameters/${name}`,
        message: "this report declares no such parameter",
      });
  if (errors.length > 0) {
    throw new AppError(
      "ERR_VALIDATION_FAILED",
      "the run parameters do not match the report's declaration",
      { errors },
    );
  }
}
