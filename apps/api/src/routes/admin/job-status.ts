import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  JobStatusSchema,
  ProblemSchema,
  UuidSchema,
  type JobStatusDto,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { getImportRun, type JobName } from "@dulja/db";
import type { Sql } from "postgres";
import type { AppEnv, RequestContext } from "../../context";
import { membershipOnly } from "../../middleware/require-permission";
import type { RouteModule } from "../index";
import { importRunUrl } from "./import";

/**
 * spec:2206's status resource for an asynchronous job — §4.2.7's "async status at `/v1/jobs/{jobId}`", which no slice
 * had mounted (round 20 C2; built in 9B Task 9, C17). 7A's report runs and 7C's exports keep their own resources
 * (ADR 0067), so this route answers only a job whose SUBJECT is registered in `JOB_SUBJECTS` below — today the
 * cut-over load — and every other job id, of any tenant, is the same 404.
 */
export const JOB_STATUS_ROUTE_PATH = "/v1/jobs";

/** What a job is FOR: the resource it works on, its status and its failure, if the caller may see it; else null. */
interface JobSubject {
  resourceUrl: string;
  status: string;
  error: string | null;
}
type SubjectReader = (
  tx: Sql,
  payload: Record<string, unknown>,
  ctx: RequestContext,
) => Promise<JobSubject | null>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The jobs this route answers, each with the rule that decides who may see one (Proposed, ADR 0084 amendment).
 *
 * `admin.import.run` — the run the payload names, read under RLS (so another tenant's is never found), of the company
 * the payload names, REQUESTED BY THE CALLER, who must still hold `admin.company.manage` in that company. A pg-boss
 * row carries no company in the URL and no RLS (§4.2.6), so membership alone would let any member of a tenant poll
 * every job id they learn; requester-and-gate bounds it to what `GET …/imports/{runId}` already shows that caller.
 */
const JOB_SUBJECTS: Partial<Record<JobName, SubjectReader>> = {
  "admin.import.run": async (tx, payload, ctx) => {
    const runId = payload["runId"];
    const companyId = payload["companyId"];
    if (typeof runId !== "string" || !UUID.test(runId) || typeof companyId !== "string")
      return null;
    const run = await getImportRun(tx, runId);
    if (run === null || run.companyId !== companyId || run.requestedBy !== ctx.actorId) return null;
    const [gate] = await tx<{ ok: boolean }[]>`
      select app.actor_has(${PERMISSION["admin.company.manage"]}, ${run.companyId}::uuid, null) as ok`;
    if (gate?.ok !== true) return null;
    return {
      resourceUrl: importRunUrl(run.companyId, run.id),
      status: run.status,
      error: run.error,
    };
  },
};

const JobParams = z.object({ jobId: UuidSchema });

export const jobStatusRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

jobStatusRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{jobId}",
    tags: ["admin"],
    summary: "The state of an asynchronous job with no resource of its own (spec:2206)",
    // Membership is the route's gate (§3.6.1 has no "read a job" code, and a job carries no company in the URL); the
    // per-job rule is JOB_SUBJECTS', evaluated on the row.
    middleware: [membershipOnly()] as const,
    request: { params: JobParams },
    responses: {
      200: {
        description: "The job",
        content: { "application/json": { schema: JobStatusSchema } },
      },
      400: {
        description: "Not a job id",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "No such job for this caller",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { jobId } = c.req.valid("param");
    const status = await c.var.withTenant(async (tx): Promise<JobStatusDto | null> => {
      // pg-boss's own table: no tenant column and no RLS (§4.2.6). The envelope's `tenantId` is the first bound —
      // every enqueue in this codebase carries it (hazard 31) — and the subject's own RLS-bound row is the second.
      const [row] = await tx<
        {
          id: string;
          name: string;
          state: JobStatusDto["state"];
          created_on: string;
          completed_on: string | null;
          tenant_id: string | null;
          payload: unknown;
        }[]
      >`
        select id::text as id, name, state::text as state,
               to_char(created_on   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_on,
               to_char(completed_on at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as completed_on,
               data ->> 'tenantId' as tenant_id, data -> 'payload' as payload
          from pgboss.job
         where id = ${jobId}::uuid`;
      if (row === undefined || row.tenant_id !== c.var.ctx.tenantId) return null;
      const reader = JOB_SUBJECTS[row.name as JobName];
      if (reader === undefined) return null;
      const payload =
        typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {};
      const subject = await reader(tx, payload, c.var.ctx);
      if (subject === null) return null;
      return {
        jobId: row.id,
        name: row.name,
        state: row.state,
        createdOn: row.created_on,
        completedOn: row.completed_on,
        output: subject,
      };
    });
    // ONE refusal for an unknown id, another tenant's job, another requester's, a job with a resource of its own and a
    // job whose subject the caller may no longer see — so a 404 never says "it exists, but not for you".
    if (status === null) throw new AppError("ERR_NOT_FOUND", `job ${jobId} was not found`);
    return c.json(status, 200);
  },
);

export const jobStatusRouteModule: RouteModule = {
  path: JOB_STATUS_ROUTE_PATH,
  router: jobStatusRoutes,
  permissions: [],
  auth: "human",
};
