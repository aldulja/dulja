import { replay } from "@dulja/db";
import { registerHandler, type JobHandler } from "../handler";
import { log } from "../log";

/**
 * `inventory.cost.replay` (§4.2.6, `schedule: null` — enqueued by `invalidateFrom` on the posting
 * transaction, one per company, collapsed by `singletonKey = companyId`).
 *
 * Amendment A6: §4.7.2 gives `replay` a return value — `{ movementsReplayed, adjustmentsPosted }`, which the
 * job's own test asserts — while §4.2.6's `JobHandler<N>` returns `Promise<void>`. So the registration is a
 * thin wrapper that logs the two counters rather than a second implementation. Everything that makes the
 * replay bounded, forward-only, restartable and visible lives in `packages/db/src/costing/replay.ts`; nothing
 * here decides anything (ADR 0038).
 *
 * It opens no transaction of its own: `replay` is handed `sql`, not a `tx`, because one transaction over a
 * year of movements would hold the per-tenant audit lock to commit (spec:1368).
 */
export function createCostReplayHandler(): JobHandler<"inventory.cost.replay"> {
  return async (sql, job, ctx) => {
    // §3.7.2's job-isolation harness runs EVERY registered job with `payload: {}` (0d:2733–2741), and a
    // hand-enqueued or truncated job is the same shape in production. The honest answer is a logged no-op —
    // never a replay against `company_id = undefined`, which postgres.js refuses as UNDEFINED_VALUE. 9B's
    // `importRunHandler` guards the same way and its plan names this handler as having the same exposure.
    if (!job.payload?.companyId) {
      log().info(
        { job: "inventory.cost.replay", tenant_id: ctx.tenantId },
        "no companyId in the payload; nothing to replay",
      );
      return;
    }
    const result = await replay(sql, job, ctx);
    log().info(
      { job: "inventory.cost.replay", companyId: job.payload.companyId, ...result },
      "cost replay finished",
    );
  };
}

/**
 * Registers what this slice owns. Called from `apps/worker/src/index.ts` at boot and from
 * `apps/worker/test/support/worker.ts`, which is the same registration production performs.
 *
 * A module-level `registerHandler(...)` side effect plus a bare `import "./handlers/cost-replay"` — the shape
 * Task 9 Step 4 sketches — cannot work in this tree: `startWorker()` calls `resetHandlers()` and then
 * re-registers, so a side effect that ran once at import time is cleared and never restored, and
 * `tests/invariants/job-isolation.test.ts` asserts `registeredJobNames()` contains every `JOB_PROBES` key.
 * The exported-function shape is what `registerAccountingHandlers` and `registerInventoryHandlers` already
 * use, and it keeps one registration list rather than two.
 */
export function registerCostingHandlers(): void {
  registerHandler("inventory.cost.replay", createCostReplayHandler());
}
