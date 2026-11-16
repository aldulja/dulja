import type { Context, MiddlewareHandler } from "hono";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../context";
import { LOT_READ_CODE, MODULE_READ_CODE } from "../middleware/require-attachment-read";
import { markExportRequestGate, requirePermission } from "../middleware/require-permission";

/**
 * `POST …/exports`' route gate (7C A12, ADR 0070). `admin.data.export` is `mutating: false` — an export
 * changes no business record — so it gates the POST only through `markExportRequestGate`, on the path
 * `EXPORT_REQUEST_ROUTES` lists for exactly this code (R7's export widening, ADR 0067's decision 6). The check
 * itself is `requirePermission`'s at company scope with NO branch source: `app.actor_has(code, company, null)`
 * is false for a branch-narrowed assignment, so an export is company-wide or refused (test 36).
 */
export const exportRequestGate: MiddlewareHandler<AppEnv> = markExportRequestGate(
  requirePermission(PERMISSION["admin.data.export"], { company: "path:companyId" }),
  PERMISSION["admin.data.export"],
);

/** The gates the JOB cannot re-derive, resolved here, at the request, for the REQUESTING principal. */
export interface ExportGateSnapshot {
  readableModules: readonly string[];
  lotAttachments: boolean;
}

/**
 * The half of the authorisation decision the job cannot make (ADR 0070). `admin.export.run` runs as the
 * tenant's system principal (spec:2179, hazard 20), which holds every code, and `MODULE_READ_CODE` — §4.5.8's
 * one map from a document type's module to its read code — lives in `apps/api`, which neither `packages/db`
 * nor `apps/worker` may import (§3.1). So the modules whose attachments the requester may read are resolved
 * HERE and stored on the row, as is the lot rule's `inventory.item.read` (§4.5.8 gates a lot attachment on
 * the catalogue's read code, not on a module's). Both are asked at company scope with a null branch, the
 * same scope the route's own gate is evaluated at: a module read held only at one branch reads no module.
 * No `readableModules()` helper exists in the tree (7C A16 item 6), so the map is read here directly.
 */
export async function exportGateSnapshot(
  c: Context<AppEnv>,
  companyId: string,
): Promise<ExportGateSnapshot> {
  const modules = Object.keys(MODULE_READ_CODE).toSorted();
  const codes = modules.map((module) => MODULE_READ_CODE[module as keyof typeof MODULE_READ_CODE]!);
  const answers = await c.var.withTenant(
    (tx) => tx<{ module: string; held: boolean }[]>`
      select m.module, app.actor_has(m.code, ${companyId}::uuid, null::uuid) as held
        from unnest(${modules}::text[], ${codes}::text[]) as m(module, code)
      union all
      select '', app.actor_has(${LOT_READ_CODE}, ${companyId}::uuid, null::uuid)`,
  );
  return {
    readableModules: answers
      .filter((a) => a.module !== "" && a.held)
      .map((a) => a.module)
      .toSorted(),
    lotAttachments: answers.some((a) => a.module === "" && a.held),
  };
}
