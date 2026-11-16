import { createHash } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  decodeCursor,
  encodeCursor,
  ProblemSchema,
  ReportRunList,
  ReportRunQuery,
  ReportRunSchema,
  UuidSchema,
} from "@dulja/contracts";
import { PERMISSION, type PermissionCode } from "@dulja/contracts/permissions";
import { listReportRuns, loadRunDefinition, type ObjectStore, type ReportRunRow } from "@dulja/db";
import { parseReportDefinition } from "@dulja/domain";
import type { Context } from "hono";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { requireReportRead } from "../../reports/authorise";

/** The report-run status resource (contracts §4.11.2 as amended, ADR 0067): what `statusUrl` points at. */
export const REPORT_RUN_ROUTE_PATH = "/v1/companies/:companyId/report-runs";

/** The codes this module's gates evaluate, for its `RouteModule.permissions` (§4.2.7). The definition's own
 *  read code is a data value, evaluated inline, and narrows these; it is never a gate of its own. */
export const REPORT_RUN_PERMISSIONS: readonly PermissionCode[] = [
  PERMISSION["accounting.report.export"],
];

/** Reading a run, its list and its bytes is the export authority: the download IS the export
 *  (spec:2146, spec:2163). A GET, so the plain middleware gate applies and R7's boot check is untouched. */
const exportGate = requirePermission(PERMISSION["accounting.report.export"], {
  company: "path:companyId",
});

const RunParams = z.object({ companyId: UuidSchema, runId: UuidSchema });

/** `object_key` never reaches the wire; the content route is the only path to the bytes (SAH-038). */
function toDto(run: ReportRunRow) {
  return {
    id: run.id,
    companyId: run.companyId,
    reportDefinitionId: run.reportDefinitionId,
    savedViewId: run.savedViewId,
    parameters: run.parameters,
    format: run.format,
    lang: run.lang,
    status: run.status,
    requestedBy: run.requestedBy,
    sha256: run.sha256,
    finishedAt: run.finishedAt,
    error: run.error,
    createdAt: run.createdAt,
  };
}

/** The run in THIS company with its definition, or 404 — the id alone never reaches another company's run. */
async function loadCompanyRun(c: Context<AppEnv>, companyId: string, runId: string) {
  const loaded = await c.var.withTenant((tx) => loadRunDefinition(tx, runId));
  if (loaded === null || loaded.run.companyId !== companyId)
    throw new AppError(
      "ERR_NOT_FOUND",
      `report run ${runId} was not found in company ${companyId}`,
    );
  const definition = parseReportDefinition(loaded.definition);
  // Every read of a run re-resolves the definition's own permission, so a code revoked after the run was
  // queued closes the status and the download too. The gate is on the DEFINITION, never on who requested it.
  await requireReportRead(c, companyId, definition.permission);
  return { run: loaded.run, definition };
}

/**
 * A **factory**, like 0B's `createUserRoutes(authAdmin)` and 2C's `createAttachmentRoutes(objectStore)`: the
 * content route needs the store, and §4.2.3's `Variables` set is closed (7A adds no member; it only READS
 * 3B's `jobs`), so the store arrives through the closure and never through the context.
 */
export function createReportRunRoutes(objectStore: ObjectStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });

  routes.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["reports"],
      summary: "List the company's report runs, newest first",
      middleware: [exportGate] as const,
      request: { params: z.object({ companyId: UuidSchema }), query: ReportRunQuery },
      responses: {
        200: {
          description: "Report runs",
          content: { "application/json": { schema: ReportRunList } },
        },
        400: {
          description: "Invalid query",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
        403: {
          description: "Forbidden",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
      },
    }),
    async (c) => {
      const { companyId } = c.req.valid("param");
      const q = c.req.valid("query");
      const requested: [string, string | undefined][] = [
        ["status", q["filter[status][eq]"]],
        ["format", q["filter[format][eq]"]],
        ["lang", q["filter[lang][eq]"]],
        ["report_definition_id", q["filter[report_definition_id][eq]"]],
      ];
      const filters = requested.flatMap(([field, value]) =>
        value === undefined ? [] : [{ field, op: "eq", value }],
      );

      let cursor: { createdAt: string; id: string } | null = null;
      if (q.cursor !== undefined) {
        const decoded = decodeCursor(q.cursor);
        const [createdAt] = decoded.k;
        if (typeof createdAt !== "string" || decoded.k.length !== 1)
          throw new AppError(
            "ERR_VALIDATION_FAILED",
            "the cursor's keyset does not match this list's sort key",
          );
        cursor = { createdAt, id: decoded.id };
      }

      // The store narrows the list to runs whose definition's own read code the caller holds — the gate the
      // single-run and content routes apply through `requireReportRead` (Phase 7 review, finding 4).
      const rows = await c.var.withTenant((tx) =>
        listReportRuns(tx, { companyId, filters, limit: q.limit, cursor }),
      );
      const last = rows.at(-1);
      return c.json(
        {
          items: rows.map(toDto),
          next_cursor:
            rows.length === q.limit && last !== undefined
              ? encodeCursor({ k: [last.createdAt], id: last.id })
              : null,
        },
        200,
      );
    },
  );

  routes.openapi(
    createRoute({
      method: "get",
      path: "/{runId}",
      tags: ["reports"],
      summary: "One report run — the status resource a POST …/runs answers with",
      middleware: [exportGate] as const,
      request: { params: RunParams },
      responses: {
        200: {
          description: "The run",
          content: { "application/json": { schema: ReportRunSchema } },
        },
        403: {
          description: "Forbidden",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
        404: {
          description: "Not found",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
      },
    }),
    async (c) => {
      const { companyId, runId } = c.req.valid("param");
      const { run } = await loadCompanyRun(c, companyId, runId);
      return c.json(toDto(run), 200);
    },
  );

  routes.openapi(
    createRoute({
      method: "get",
      path: "/{runId}/content",
      tags: ["reports"],
      summary: "Download a finished run's rendered artefact",
      middleware: [exportGate] as const,
      request: { params: RunParams },
      responses: {
        200: {
          description: "The rendered artefact (application/pdf, XLSX or text/csv)",
          content: {
            "application/pdf": { schema: z.string().openapi({ format: "binary" }) },
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
              schema: z.string().openapi({ format: "binary" }),
            },
            "text/csv": { schema: z.string() },
          },
        },
        403: {
          description: "Forbidden",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
        404: {
          description: "Not found, or not finished",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
      },
    }),
    async (c) => {
      const { companyId, runId } = c.req.valid("param");
      const { run, definition } = await loadCompanyRun(c, companyId, runId);
      if (run.status !== "done" || run.objectKey === null) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `report run ${runId} has not finished (status ${run.status})${run.error === null ? "" : `: ${run.error}`}`,
        );
      }
      const stored = await objectStore.get(run.objectKey);
      if (stored === null)
        throw new AppError(
          "ERR_NOT_FOUND",
          `the artefact of report run ${runId} is no longer in the store`,
        );
      // The worker recorded the digest of the bytes it stored; bytes that no longer match are never served,
      // and the key never reaches the client — the detail goes to the log with the request id (spec:2063).
      if (createHash("sha256").update(stored.bytes).digest("hex") !== run.sha256) {
        c.var.logger.error({ report_run_id: runId }, "report_run_integrity");
        throw new AppError("ERR_INTERNAL", `report run ${runId} could not be served`);
      }
      return c.body(stored.bytes as unknown as ArrayBuffer, 200, {
        "content-type": stored.contentType,
        // A file name a human recognises; the run id keeps two downloads distinguishable.
        "content-disposition": `attachment; filename="${definition.code}-${runId}.${run.format}"`,
        "cache-control": "private, no-store",
      });
    },
  );

  return routes;
}
