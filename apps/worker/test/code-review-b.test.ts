// apps/worker/test/code-review-b.test.ts — the code review's stream-B finding on the worker (B5), written to
// fail against the tree it was found on and pass against the fix. The data-layer findings are in
// packages/db/test/ar-ap/code-review-b.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemContext, withTenant } from "@dulja/db";
import { seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { createAccountingProjectionRebuildHandler } from "../src/handlers/accounting-projection-rebuild";
import { startWorker, type StartedWorker } from "./support/worker";

describe("B5 — the rebuild's incident names the projections the run actually checked", () => {
  let w: StartedWorker;
  let s: Seed;

  const checkedIn = async (requestId: string) => {
    const rows = await withTenant(
      w.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(w.db.admin) },
      (tx) => tx<{ after: { projections: { checked: string[]; mismatches: unknown[] } } }[]>`
        select after from app.audit_log
         where tenant_id = ${s.tenant} and table_name = 'integrity_incident' and row_id = ${requestId}`,
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.after.projections;
  };
  const runWith = async (handler: ReturnType<typeof createAccountingProjectionRebuildHandler>) => {
    const requestId = await uuidv7(w.db.admin);
    await handler(
      w.db.rw,
      { tenantId: s.tenant, requestId, payload: { companyId: s.company, asOf: "2026-04-30" } },
      await systemContext(w.db.rw, s.tenant, requestId),
    );
    return requestId;
  };

  beforeAll(async () => {
    w = await startWorker();
    s = await seedTenantV2(w.db, "WorkerCodeReviewB");
  }, 600_000);
  afterAll(async () => {
    await w.stop();
  });

  it("a thrown item_profitability rebuild is recorded as checked beside the party_ageing compare", async () => {
    const projections = await checkedIn(
      await runWith(
        createAccountingProjectionRebuildHandler({
          rebuildProfitability: async () => {
            throw new Error("injected profitability failure");
          },
        }),
      ),
    );
    // On the parent `checked` was the constant ["party_ageing"] while the one mismatch named
    // item_profitability — an incident that contradicted itself.
    expect(projections.mismatches).toMatchObject([{ projection: "item_profitability" }]);
    expect(projections.checked).toEqual(["party_ageing", "item_profitability"]);
  });

  it("a thrown party_ageing rebuild never reached item_profitability, so only party_ageing is checked", async () => {
    const projections = await checkedIn(
      await runWith(
        createAccountingProjectionRebuildHandler({
          rebuild: async () => {
            throw new Error("injected ageing failure");
          },
        }),
      ),
    );
    expect(projections.mismatches).toMatchObject([{ projection: "party_ageing" }]);
    expect(projections.checked).toEqual(["party_ageing"]);
  });
});
