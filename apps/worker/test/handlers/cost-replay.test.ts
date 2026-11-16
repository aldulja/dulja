import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts";
import { loadDocumentTypes } from "@dulja/db/seed";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  uuidv7,
} from "@dulja/db/test";
import {
  postInventoryDocument,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import { startWorker, type StartedWorker } from "../support/worker";

/** `apps/worker/test/handlers/` → four levels up is the repo root. Derived here rather than imported from
 *  `tests/support/source`: A21(c)'s `dependency-rule` allowance covers `tests/invariants/support/**` only,
 *  and widening it a fourth time to reach one constant is worse than four `..` segments. This tier MAY
 *  import `@dulja/contracts` and `@dulja/db/seed` — TIER["apps/worker"] lists both (0b:5058). */
const TYPES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "seed",
  "my",
  "document-types",
);

describe("inventory.cost.replay through the worker", () => {
  let w: StartedWorker;
  beforeAll(async () => {
    w = await startWorker();
  }, 180_000);
  afterAll(async () => {
    await w.stop();
  });

  it("the handler is registered under its JOBS name and logs what it did", async () => {
    const s = await seedTenantV2(w.db, "WorkerReplay");
    // A bare `grantCodes(w.db, s)` grants NOTHING; both fixture policies' `approval.post` is this code.
    await grantCodes(w.db, s, { codes: ["accounting.journal.post"] });
    // `seedItem` below seeds 1300, 5000 and 5900 idempotently (3A's ITEM_DEFAULT_ACCOUNTS).
    const receipt = await seedDocumentType(w.db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    const issue = await seedDocumentType(w.db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    const { itemId } = await seedItem(w.db, s, { code: "W-1", trackLots: false });
    const warehouseId = await seedWarehouse(w.db, s, { code: "W-WH" });
    // `startWorker()` starts the container, applies the migrations and installs pg-boss — it does NOT load
    // the seed packs (0d:2350). The back-dated receipt below makes the replay post one adjustment, and
    // `resolveAdjustmentAccounts` raises `ERR_NOT_FOUND` on a company with no `COST_ADJUSTMENT` row before
    // it computes anything, so without this the assertion below would fail on a seeding gap.
    //
    // Called on the POOL: `loadDocumentTypes` opens its own `withTenant`, and the production `withTenant`
    // refuses a transaction with ERR_TENANT_CONTEXT_NESTED.
    await loadDocumentTypes(
      w.db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(w.db.admin) },
      TYPES,
      PERMISSIONS.map((p) => p.code),
    );

    // The real JobClient: postDocument's step 14 enqueues into pgboss on the posting transaction.
    await postInventoryDocument(w.db, s, {
      documentTypeId: receipt,
      warehouseId,
      jobs: w.jobs,
      effectiveDate: "2026-03-01",
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "5.0000" }],
    });
    await postInventoryDocument(w.db, s, {
      documentTypeId: issue,
      warehouseId,
      jobs: w.jobs,
      effectiveDate: "2026-03-02",
      lines: [{ itemId, warehouseId, quantity: "4.000000", unitPrice: "9.0000" }],
    });
    await postInventoryDocument(w.db, s, {
      documentTypeId: receipt,
      warehouseId,
      jobs: w.jobs,
      effectiveDate: "2026-02-01",
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "15.0000" }],
    });

    await w.run("inventory.cost.replay", {
      tenantId: s.tenant,
      requestId: await uuidv7(w.db.admin),
      payload: { companyId: s.company },
    });
    // `CapturedLog` is `{ level, fields, msg }` (0d:2340) and the handler spreads `...result` into the
    // FIELDS object, so the two counters are read off `fields` — `l.movementsReplayed` would not compile.
    const finished = w.logs.filter((l) => l.msg === "cost replay finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]!.fields).toMatchObject({
      job: "inventory.cost.replay",
      companyId: s.company,
      movementsReplayed: 3,
    });
    expect(finished[0]!.fields["adjustmentsPosted"]).toHaveLength(1);
  }, 600_000);
});
