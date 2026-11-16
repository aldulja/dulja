import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  decodeCursor,
  encodeCursor,
  ImportAcceptedSchema,
  ImportRunList,
  ImportRunQuery,
  ImportRunSchema,
  ProblemSchema,
  StartImportBody,
  UuidSchema,
  type ImportRunDto,
} from "@dulja/contracts";
import { PERMISSION, type PermissionCode } from "@dulja/contracts/permissions";
import {
  batchCounts,
  createImportRun,
  getImportRun,
  IMPORT_RUN_JOB_OPTIONS,
  listImportRuns,
  liveImportRun,
  IMPORT_RUN_LEASE_SECONDS,
  missingImportWriteCodes,
  supersedeStaleImportRuns,
  type ImportRunRow,
} from "@dulja/db";
import type { Sql } from "postgres";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";

/** The cut-over load's module (9B Task 9; contracts §4.2.7 as amended by round 20's C4 and C17). */
export const IMPORT_ROUTE_PATH = "/v1/companies/:companyId/imports";

/** §3.6.1 closes the permission vocabulary and 9B introduces no code. §3.6.2 puts company configuration — document
 *  types, posting policies, exchange rates, dimensions, custom fields, print templates — under
 *  `admin.company.manage`, and a cut-over load is the largest configuration act a tenant ever performs. It is the
 *  route's GATE, not the whole authority: starting a run also asks the write codes of its loaders
 *  (`IMPORT_LOADER_WRITE_CODES`, 9B review finding 4), in the handler, because which codes depends on the body. */
export const IMPORT_PERMISSIONS: readonly PermissionCode[] = [PERMISSION["admin.company.manage"]];

/** Company-scoped, so a branch-narrowed assignment never clears it (`app.actor_has(code, company, null)` is false for
 *  one) — test 36's refusal, as the export's gate. */
const importGate = requirePermission(PERMISSION["admin.company.manage"], {
  company: "path:companyId",
});

/** The run's own record — the `output.resourceUrl` `/v1/jobs/{jobId}` names. */
export function importRunUrl(companyId: string, runId: string): string {
  return `/v1/companies/${companyId}/imports/${runId}`;
}

/** The account map is the operator's input and never echoed; `perTargetTable` is what the run COMMITTED. */
async function toDto(tx: Sql, run: ImportRunRow): Promise<ImportRunDto> {
  return {
    runId: run.id,
    companyId: run.companyId,
    requestedBy: run.requestedBy,
    cutOverDate: run.cutOverDate,
    dryRun: run.dryRun,
    only: run.only,
    hasAccountMap: run.accountMap !== null,
    status: run.status,
    perTargetTable: await batchCounts(tx, { companyId: run.companyId, runId: run.id }),
    perLoader: run.perLoader,
    skips: run.skipCount,
    artefacts: run.artefactCount,
    error: run.error,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

export const importRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

importRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["admin"],
    summary: "Start a cut-over load from the legacy database (async; poll statusUrl)",
    middleware: [importGate] as const,
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { required: true, content: { "application/json": { schema: StartImportBody } } },
    },
    responses: {
      202: {
        description: "The run is queued; poll statusUrl",
        content: { "application/json": { schema: ImportAcceptedSchema } },
      },
      400: {
        description: "Invalid body",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "A run of this company is already queued or running",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    // The row and the pg-boss job in ONE transaction: the job is visible only after the commit and never on a
    // rollback (§4.2.6, spec:2321). `requested_by` is stamped by `app.stamp_actor` — never from the body. The account
    // map goes on the RLS-bound row, never into the payload: `pgboss.job` has no RLS (§4.2.6).
    const { runId, jobId } = await c.var.withTenant(async (tx) => {
      // 9B review, finding 4 (ADR 0084 decision 22): the load runs as the system principal, so the route's gate was
      // the only authority a run was asked for. The requester must also hold, at company scope, the write code of
      // every loader the run executes (`only` respected) — 7A's "the writer holds the permission". The job asks again
      // when it claims the run, so a role revoked in between is caught.
      const missing = await missingImportWriteCodes(tx, {
        principalId: c.var.ctx.actorId,
        companyId,
        only: body.only,
      });
      if (missing.length > 0)
        throw new AppError(
          "ERR_RBAC_FORBIDDEN",
          `the import writes what ${missing.join(", ")} ${missing.length === 1 ? "gates" : "gate"}, and principal ${c.var.ctx.actorId} does not hold ${missing.length === 1 ? "it" : "them"} company-wide in company ${companyId}; ask for ${missing.length === 1 ? "it" : "them"}, or restrict the run with only`,
        );
      // 9B review, finding 7: a run queued past the lease that no worker ever claimed has lost its job, and would
      // hold the company's one live slot for ever; this request supersedes it (failed, with a stable reason).
      const superseded = await supersedeStaleImportRuns(tx, companyId);
      if (superseded.length > 0)
        c.var.logger.warn(
          { company_id: companyId, superseded_import_run_ids: superseded },
          "superseded import runs that stayed queued and unclaimed past the lease",
        );
      const live = await liveImportRun(tx, companyId);
      if (live !== null)
        throw new AppError(
          "ERR_CONFLICT_UNIQUE",
          `import run ${live.id} of company ${companyId} is ${live.status}; one load of a company runs at a time — wait for it to finish (GET ${importRunUrl(companyId, live.id)}). A run still queued and never claimed ${IMPORT_RUN_LEASE_SECONDS / 3600} hours after it was requested is superseded by the next request`,
        );
      const run = await createImportRun(tx, {
        companyId,
        cutOverDate: body.cutOverDate,
        dryRun: body.dryRun,
        only: body.only,
        accountMap: body.accountMap,
      });
      // C3's payload. No singleton key: one live run per company is `import_run_one_live_per_company`'s, and a keyed
      // standard job would hold a 24-hour slot a FINISHED job still occupies. The lease's options, as 7A/7C enqueue.
      const job = await c.var.jobs.enqueue(
        tx,
        "admin.import.run",
        {
          tenantId: c.var.ctx.tenantId,
          requestId: c.var.ctx.requestId,
          payload: {
            companyId,
            runId: run.id,
            cutOverDate: run.cutOverDate,
            dryRun: run.dryRun,
            ...(run.only === null ? {} : { only: run.only }),
          },
        },
        IMPORT_RUN_JOB_OPTIONS,
      );
      return { runId: run.id, jobId: job };
    });
    c.var.logger.info(
      { import_run_id: runId, job_id: jobId, company_id: companyId, dry_run: body.dryRun },
      "import requested",
    );
    // spec:2206's status resource — the generic job status (round 20 C2), which names the run in `output`.
    return c.json({ runId, jobId, statusUrl: `/v1/jobs/${jobId}` }, 202);
  },
);

importRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["admin"],
    summary: "List the company's cut-over load runs, newest first",
    middleware: [importGate] as const,
    request: { params: z.object({ companyId: UuidSchema }), query: ImportRunQuery },
    responses: {
      200: {
        description: "Import runs",
        content: { "application/json": { schema: ImportRunList } },
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
    const page = await c.var.withTenant(async (tx) => {
      const rows = await listImportRuns(tx, {
        companyId,
        limit: q.limit,
        cursor,
        ...(status === undefined ? {} : { status }),
      });
      const items: ImportRunDto[] = [];
      for (const row of rows) items.push(await toDto(tx, row));
      return { rows, items };
    });
    const last = page.rows.at(-1);
    return c.json(
      {
        items: page.items,
        next_cursor:
          page.rows.length === q.limit && last !== undefined
            ? encodeCursor({ k: [last.createdAt], id: last.id })
            : null,
      },
      200,
    );
  },
);

importRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{runId}",
    tags: ["admin"],
    summary:
      "One cut-over load run — its status, its counts and the rows it committed per target table",
    middleware: [importGate] as const,
    request: { params: z.object({ companyId: UuidSchema, runId: UuidSchema }) },
    responses: {
      200: {
        description: "The run",
        content: { "application/json": { schema: ImportRunSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "No such run in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, runId } = c.req.valid("param");
    // Any holder of the gate in the company reads a run (7A's report-run rule): the record carries counts, codes and
    // legacy keys — company configuration — and nothing another permission gates (9B T8: no figure, no sensitive
    // value in any message). The PATH company bounds it: another company's run answers as a missing one.
    const run = await c.var.withTenant(async (tx) => {
      const row = await getImportRun(tx, runId);
      if (row === null || row.companyId !== companyId)
        throw new AppError(
          "ERR_NOT_FOUND",
          `import run ${runId} was not found in company ${companyId}`,
        );
      return toDto(tx, row);
    });
    return c.json(run, 200);
  },
);

export const importRouteModule: RouteModule = {
  path: IMPORT_ROUTE_PATH,
  router: importRoutes,
  permissions: IMPORT_PERMISSIONS,
  auth: "human",
};
