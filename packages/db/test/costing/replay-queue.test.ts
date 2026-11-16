import { fileURLToPath } from "node:url";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  postInventoryDocument,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import { replay } from "../../src/costing/replay";
import { createJobClient, JOBS, type JobClient, type JobEnvelope } from "../../src/jobs/enqueue";
import { loadDocumentTypes } from "../../src/seed/document-types";
import { installBoss, stopBoss } from "../boss";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const TYPES = fileURLToPath(new URL("../../seed/my/document-types", import.meta.url));
const REPLAY = "inventory.cost.replay";

/**
 * 3B's `inventory.cost.replay` through a REAL pg-boss, keyed `singletonKey = companyId` on its `stately` queue
 * (contracts §4.2.6). The defect this file pins: `createJobClient` used to pair every key with
 * `singletonSeconds = 86400`, a throttle slot whose unique index (`job_i4`) counts a job in every state but
 * `cancelled`, so the SECOND back-dated post of a company in one UTC day was refused — `JobNotInsertedError`,
 * and the post failed — even when the first replay had long completed.
 *
 * The receipts are the only movements that move the one issue's cost, so the issue's `document_line.cost`
 * (rewritten by the replay, ADR 0038 decision 2) is the witness of which receipts a replay saw.
 */
describe("inventory.cost.replay on its stately queue — two back-dated posts in one day (SAH-005)", () => {
  let db: Db;
  let s: Seed;
  let boss: PgBoss;
  let jobs: JobClient;
  let receiptType: string;
  let issueType: string;
  let itemId: string;
  let warehouseId: string;
  let issueId: string;

  const receipt = (effectiveDate: string, unitPrice: string) =>
    postInventoryDocument(db, s, {
      documentTypeId: receiptType,
      warehouseId,
      jobs,
      effectiveDate,
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice }],
    });
  const replays = async () =>
    db.admin<{ id: string; state: string }[]>`
      select id::text as id, state::text as state from pgboss.job
       where name = ${REPLAY} and singleton_key = ${s.company}
       order by created_on, state`;
  const issueCost = async (): Promise<string> => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ cost: string }[]>`
        select cost::text as cost from app.document_line where document_id = ${issueId}`,
    );
    return row!.cost;
  };
  /** What the worker does with a job it fetched: run the handler's body, then settle the job. */
  const run = async (job: { id: string; data: object }) => {
    const envelope = job.data as JobEnvelope<{ companyId: string }>;
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const result = await replay(db.rw, envelope, ctx);
    await boss.complete(REPLAY, job.id);
    return result;
  };

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "ReplayQueue");
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    const catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map(
      (r) => r.code,
    );
    // COST_ADJUSTMENT comes from the pack; the replay resolves it before it computes anything.
    await loadDocumentTypes(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      TYPES,
      catalogue,
    );
    receiptType = await seedDocumentType(db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    issueType = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    ({ itemId } = await seedItem(db, s, { code: "RQ-1", trackLots: false }));
    warehouseId = await seedWarehouse(db, s, { code: "RQ-WH" });
    boss = await installBoss(db, Object.keys(JOBS));
    jobs = createJobClient(boss);

    // Forward only: 10 @ 5.0000 on 1 March, then an issue of 4 on 10 March at 4 × 5.0000 = 20.0000.
    await receipt("2026-03-01", "5.0000");
    ({ documentId: issueId } = await postInventoryDocument(db, s, {
      documentTypeId: issueType,
      warehouseId,
      jobs,
      effectiveDate: "2026-03-10",
      lines: [{ itemId, warehouseId, quantity: "4.000000", unitPrice: "9.0000" }],
    }));
    expect(await replays()).toEqual([]);
    expect(await issueCost()).toBe("20.0000");
  }, 600_000);
  afterAll(async () => {
    await stopBoss(boss);
    await db.stop();
  });

  it("two back-dated posts before the worker runs BOTH post, and collapse into one queued replay", async () => {
    const first = await receipt("2026-02-01", "15.0000");
    // The post the 24-hour slot refused: the first replay is still queued, so this one rides on it.
    const second = await receipt("2026-02-05", "25.0000");
    for (const posted of [first, second]) {
      expect(posted.result.enqueuedJobIds).toContain(`${REPLAY}:${s.company}`);
    }
    expect((await replays()).map((j) => j.state)).toEqual(["created"]);
  });

  it("the one replay recosts both — it reads the committed state when it runs, not when it was queued", async () => {
    const [job] = await boss.fetch<object>(REPLAY);
    expect(job).toBeDefined();
    const result = await run(job!);
    // Both back-dated receipts, the 1 March receipt and the issue: four movements at or after 1 February.
    expect(result.movementsReplayed).toBe(4);
    // The average on 10 March is (10 × 15 + 10 × 25 + 10 × 5) ÷ 30 = 15.0000, so the issue of 4 costs
    // 60.0000. A replay that saw only the first receipt would say (150 + 50) ÷ 20 × 4 = 40.0000.
    expect(await issueCost()).toBe("60.0000");
    expect((await replays()).map((j) => j.state)).toEqual(["completed"]);
  });

  it("a third back-dated post the same day, after that replay COMPLETED, queues a new one — the defect", async () => {
    // Under the old 24-hour slot this post threw JobNotInsertedError: the completed job still held the slot.
    await receipt("2026-02-10", "35.0000");
    expect((await replays()).map((j) => j.state).toSorted()).toEqual(["completed", "created"]);
    const [job] = await boss.fetch<object>(REPLAY);
    await run(job!);
    // (150 + 250 + 350 + 50) ÷ 40 = 20.0000, × 4 = 80.0000.
    expect(await issueCost()).toBe("80.0000");
  });

  it("a back-dated post while a replay is ACTIVE queues a second one, which runs after it and sees the post", async () => {
    await receipt("2026-02-15", "45.0000");
    const [running] = await boss.fetch<object>(REPLAY);
    expect(running).toBeDefined();
    // The worker has claimed the replay (state = active) and — in production — may already have read the
    // company's invalidated tail. This post's invalidation arrives after that read, so it must not collapse
    // into the running job: stately admits one queued job beside the active one.
    await receipt("2026-02-20", "55.0000");
    const states = (await replays()).map((j) => j.state);
    expect(states.filter((state) => state === "active")).toHaveLength(1);
    expect(states.filter((state) => state === "created")).toHaveLength(1);
    // At most one ACTIVE job per key: the queued one cannot be claimed while the first runs.
    expect(await boss.fetch<object>(REPLAY)).toEqual([]);

    await run(running!);
    const [next] = await boss.fetch<object>(REPLAY);
    expect(next).toBeDefined();
    expect(next!.id).not.toBe(running!.id);
    await run(next!);
    // Six largest-remainder quantity shares reduce the exact layer values by 119.9999 in total.
    // The remaining layers retain the fourth-decimal residue; full depletion must still total 1800.0000.
    expect(await issueCost()).toBe("119.9999");
    const [left] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.cost_layer
         where company_id = ${s.company} and invalidated_at is not null`,
    );
    expect(left!.n).toBe(0);
  });
});
