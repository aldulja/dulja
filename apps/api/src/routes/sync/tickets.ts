import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { AppError, PERMISSION, ProblemSchema } from "@dulja/contracts";
import {
  TicketBatchBody,
  BatchResultSchema,
  BatchQueuedSchema,
} from "@dulja/contracts/sync/ticket";
import { applyBatch, enqueueSyncBatch, type BatchOutcome } from "@dulja/db";
import { SYNC_BATCH_SYNC_LIMIT, encodeSyncCursor } from "@dulja/sync";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { AppEnv } from "../../context";
// apps/api/src/routes/sync/tickets.ts
export const ticketRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
ticketRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["sync"],
    request: {
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: TicketBatchBody } } },
    },
    middleware: [requirePermission(PERMISSION["pos.sync.push"], { company: "terminal" })],
    responses: {
      200: {
        description: "applied",
        content: { "application/json": { schema: BatchResultSchema } },
      },
      202: {
        description: "queued",
        content: { "application/json": { schema: BatchQueuedSchema } },
      },
      400: {
        description: "invalid",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const batch = c.req.valid("json");
    const t = c.get("terminal");
    // A till may only sell as ITSELF. The body's terminalId is data; the signature is identity (LEGACY-044).
    if (batch.terminalId !== t.terminalId) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        "the batch's terminalId is not the terminal that signed this request",
      );
    }
    if (batch.tickets.length > SYNC_BATCH_SYNC_LIMIT) {
      // Keyed by batchId, so a re-send of the same batch with a fresh Idempotency-Key queues no second job
      // and is answered with the job already holding the key (PR 12 review; `enqueueSyncBatch`).
      const job = await c.var.withTenant((tx) =>
        enqueueSyncBatch(tx, c.get("jobs"), {
          tenantId: t.tenantId,
          requestId: c.get("requestId"),
          payload: { terminalId: t.terminalId, batch },
        }),
      );
      // 202 "queued" only while the job may still run. Once it has finished, re-sending the over-size batch
      // can never answer per ticket and "queued" with Retry-After would be untrue, so the client is told how it
      // ended and how to get the answers: the same tickets in batches applied at once, where client_ref dedup
      // acks what the job applied and applies what a failed job did not (ADR 0056, PR 12 review).
      if (job.state !== "queued") {
        throw new AppError(
          "ERR_VALIDATION_FAILED",
          `batch ${batch.batchId} was queued as job ${job.jobId}, which ${
            job.state === "completed" ? "has completed" : "failed after its retries"
          }; re-send its tickets in batches of at most ${SYNC_BATCH_SYNC_LIMIT} for an answer per ticket`,
        );
      }
      c.header("Retry-After", "5");
      return c.json({ batchId: batch.batchId, jobId: job.jobId, status: "queued" as const }, 202);
    }
    const out = await c.var.withTenant((tx) =>
      applyBatch(
        tx,
        c.get("ctx"),
        {
          terminalId: t.terminalId,
          companyId: t.companyId,
          branchId: t.branchId,
          principalId: t.principalId,
          jobs: c.get("jobs"),
        },
        batch,
      ),
    );
    return c.json(toBatchResult(out), 200);
  },
);
function toBatchResult(out: BatchOutcome) {
  return BatchResultSchema.parse({
    batchId: out.batchId,
    results: out.results,
    shiftResults: out.shiftResults,
    tillEventResults: out.tillEventResults,
    cashEventResults: out.cashEventResults,
    catalogueCursor: encodeSyncCursor({ revision: out.catalogueRevision }),
  });
}
