import { createHash } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  CreateExportBody,
  decodeCursor,
  encodeCursor,
  ExportAcceptedSchema,
  ExportJobList,
  ExportJobQuery,
  ExportJobSchema,
  ProblemSchema,
  UuidSchema,
  type ExportJobDto,
} from "@dulja/contracts";
import { PERMISSION, type PermissionCode } from "@dulja/contracts/permissions";
import {
  createExportJob,
  EXPORT_JOB_JOB_OPTIONS,
  getExportJob,
  listExportJobs,
  type ExportJobRow,
  type ObjectStore,
} from "@dulja/db";
import type { Context } from "hono";
import type { AppEnv } from "../../context";
import { exportGateSnapshot, exportRequestGate } from "../../export/authorise";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";

/** The tenant data export's module (spec:2186, contracts §4.2.7 as amended by 7C A12). */
export const EXPORT_ROUTE_PATH = "/v1/companies/:companyId/exports";

/** The codes this module's gates evaluate, for its `RouteModule.permissions` (§4.2.7). */
export const EXPORT_PERMISSIONS: readonly PermissionCode[] = [PERMISSION["admin.data.export"]];

/** Company-scoped, so a branch-narrowed assignment never clears it (`app.actor_has(code, company, null)` is
 *  false for one) — test 36's refusal. The three GETs take it as plain middleware; the POST takes the same
 *  check through `exportRequestGate`, R7's export widening (ADR 0070). */
const exportGate = requirePermission(PERMISSION["admin.data.export"], {
  company: "path:companyId",
});

const JobParams = z.object({ companyId: UuidSchema, exportJobId: UuidSchema });

/** `object_key` never reaches the wire (SAH-038); the content route is the only path to the bytes. */
function toDto(job: ExportJobRow): ExportJobDto {
  return {
    id: job.id,
    companyId: job.companyId,
    requestedBy: job.requestedBy,
    format: job.format,
    status: job.status,
    readableModules: [...job.readableModules],
    lotAttachments: job.lotAttachments,
    includeAttachments: job.includeAttachments,
    tableCount: job.tableCount,
    rowCount: job.rowCount,
    byteSize: job.byteSize,
    sha256: job.sha256,
    manifest: job.manifest as ExportJobDto["manifest"],
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    createdAt: job.createdAt,
  };
}

/**
 * One export job of the path company that the CALLER requested, or 404. An archive is built under its
 * requester's gates (ADR 0070): another holder of `admin.data.export` who lacks, say, `hr.employee.read` must
 * not download a colleague's archive that carries the HR tables — test 32's side channel. So every read of
 * an export is the requester's own, and another principal's job answers exactly as a missing one does.
 */
async function loadOwnJob(
  c: Context<AppEnv>,
  companyId: string,
  exportJobId: string,
): Promise<ExportJobRow> {
  const row = await c.var.withTenant((tx) => getExportJob(tx, exportJobId));
  if (row === null || row.companyId !== companyId || row.requestedBy !== c.var.ctx.actorId)
    throw new AppError(
      "ERR_NOT_FOUND",
      `export job ${exportJobId} was not found in company ${companyId}`,
    );
  return row;
}

/** A **factory**, like 2C's `createAttachmentRoutes(objectStore)` and 7A's `createReportRunRoutes`: the
 *  download route needs the store, and §4.2.3's `Variables` set is closed, so the store arrives through the
 *  closure and never through the context. */
export function createExportRoutes(objectStore: ObjectStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });

  routes.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["admin"],
      summary: "Request a data export of the company — CSV, JSON and a documented schema",
      middleware: [exportRequestGate] as const,
      request: {
        params: z.object({ companyId: UuidSchema }),
        headers: IdempotencyHeader,
        body: { required: true, content: { "application/json": { schema: CreateExportBody } } },
      },
      responses: {
        202: {
          description: "The export is queued; poll statusUrl",
          content: { "application/json": { schema: ExportAcceptedSchema } },
        },
        400: {
          description: "Invalid body",
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
      const { format, includeAttachments } = c.req.valid("json");
      // The requester's attachment gates, resolved NOW: the job runs as the system principal (ADR 0070).
      const gates = await exportGateSnapshot(c, companyId);
      // The row and the pg-boss job in ONE transaction: the job is visible only after the commit and never on
      // a rollback (§4.2.6, spec:2321). `requested_by` is stamped by `app.stamp_actor` — never from the body.
      const { exportJobId, jobId } = await c.var.withTenant(async (tx) => {
        const row = await createExportJob(tx, {
          companyId,
          format,
          readableModules: gates.readableModules,
          lotAttachments: gates.lotAttachments,
          includeAttachments,
        });
        // The lease's options (Phase 7 review, finding 2), as a report run's are.
        const job = await c.var.jobs.enqueue(
          tx,
          "admin.export.run",
          {
            tenantId: c.var.ctx.tenantId,
            requestId: c.var.ctx.requestId,
            payload: { exportJobId: row.id },
          },
          EXPORT_JOB_JOB_OPTIONS,
        );
        return { exportJobId: row.id, jobId: job };
      });
      c.var.logger.info(
        { export_job_id: exportJobId, job_id: jobId, company_id: companyId },
        "export requested",
      );
      // The status URL is the RESOURCE this module mounts, never `/v1/jobs/{jobId}` (ADR 0067).
      return c.json(
        { exportJobId, jobId, statusUrl: `/v1/companies/${companyId}/exports/${exportJobId}` },
        202,
      );
    },
  );

  routes.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["admin"],
      summary: "List the caller's data exports of the company, newest first",
      middleware: [exportGate] as const,
      request: { params: z.object({ companyId: UuidSchema }), query: ExportJobQuery },
      responses: {
        200: {
          description: "Export jobs",
          content: { "application/json": { schema: ExportJobList } },
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
      const status = q["filter[status][eq]"];
      const rows = await c.var.withTenant((tx) =>
        listExportJobs(tx, {
          companyId,
          requestedBy: c.var.ctx.actorId,
          limit: q.limit,
          cursor,
          ...(status === undefined ? {} : { status }),
        }),
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
      path: "/{exportJobId}",
      tags: ["admin"],
      summary: "One data export — the status resource a POST …/exports answers with",
      middleware: [exportGate] as const,
      request: { params: JobParams },
      responses: {
        200: {
          description: "The export job",
          content: { "application/json": { schema: ExportJobSchema } },
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
      const { companyId, exportJobId } = c.req.valid("param");
      return c.json(toDto(await loadOwnJob(c, companyId, exportJobId)), 200);
    },
  );

  routes.openapi(
    createRoute({
      method: "get",
      path: "/{exportJobId}/content",
      tags: ["admin"],
      summary: "Download a finished export's .tar.gz archive",
      middleware: [exportGate] as const,
      request: { params: JobParams },
      responses: {
        200: {
          description: "The archive; X-Content-Sha256 carries its digest",
          content: { "application/gzip": { schema: z.string().openapi({ format: "binary" }) } },
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
      const { companyId, exportJobId } = c.req.valid("param");
      const job = await loadOwnJob(c, companyId, exportJobId);
      // A queued, running or failed job has no artefact: 404, never an empty 200 that a caller could save as
      // "the export".
      if (job.status !== "done" || job.objectKey === null || job.sha256 === null)
        throw new AppError(
          "ERR_NOT_FOUND",
          `export job ${exportJobId} has not finished (status ${job.status})${job.error === null ? "" : `: ${job.error}`}`,
        );
      const stored = await objectStore.get(job.objectKey);
      if (stored === null)
        throw new AppError(
          "ERR_NOT_FOUND",
          `the archive of export job ${exportJobId} is no longer in the store`,
        );
      // The job recorded the digest of the bytes it stored; bytes that no longer match are never served, and
      // the key never reaches the client — the detail goes to the log with the request id (spec:2063).
      if (createHash("sha256").update(stored.bytes).digest("hex") !== job.sha256) {
        c.var.logger.error({ export_job_id: exportJobId }, "export_job_integrity");
        throw new AppError("ERR_INTERNAL", `export job ${exportJobId} could not be served`);
      }
      return c.body(stored.bytes as unknown as ArrayBuffer, 200, {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="dulja-export-${exportJobId}.tar.gz"`,
        "x-content-sha256": job.sha256,
        "cache-control": "private, no-store",
      });
    },
  );

  return routes;
}

export function exportRouteModule(objectStore: ObjectStore): RouteModule {
  return {
    path: EXPORT_ROUTE_PATH,
    router: createExportRoutes(objectStore),
    permissions: EXPORT_PERMISSIONS,
    auth: "human",
  };
}
