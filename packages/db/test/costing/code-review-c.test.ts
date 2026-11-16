import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  postInventoryDocument,
  postOverriddenIssue,
  recordingJobs,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import { replay } from "../../src/costing/replay";
import { loadDocumentTypes } from "../../src/seed/document-types";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/** Resolved from this file: Vitest runs this package from `packages/db` (1a:5114). */
const TYPES = fileURLToPath(new URL("../../seed/my/document-types", import.meta.url));

/**
 * Code review, stream C — finding C1. The replay's "before" for a movement is the cost the LEDGER carries
 * for it. For an authorised override issue the layers only partly covered, that is the covered consumptions
 * PLUS the shortfall valued at the running average (ADR 0038 note 7: "valued but not consumed") — and the
 * replay took only the consumptions, so its COST_ADJUSTMENT over-stated COGS by the shortfall's value and
 * 1300 ended that far from the layers. Every case runs in its own tenant: `postOverriddenIssue` grants a
 * role with a fixed code, so it can run once per tenant.
 */
describe("C1 — a replayed override issue's 'before' includes the shortfall value the ledger carries", () => {
  let db: Db;
  let catalogue: string[];

  beforeAll(async () => {
    db = await startDb();
    catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map(
      (r) => r.code,
    );
  }, 300_000);
  afterAll(async () => {
    await db.stop();
  });

  interface World {
    s: Seed;
    receiptType: string;
    issueType: string;
    itemId: string;
    warehouseId: string;
  }

  async function world(name: string): Promise<World> {
    const s = await seedTenantV2(db, name);
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    // `replay` resolves COST_ADJUSTMENT at the top of the job, so the pack's types must exist here.
    await loadDocumentTypes(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      TYPES,
      catalogue,
    );
    const receiptType = await seedDocumentType(db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    const issueType = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    // trackLots: false — one lot-less line, so the delivery is ONE movement the layers partly cover (a
    // lot-tracked item would be FEFO-split into a covered line and a wholly uncovered sentinel-lot line).
    const { itemId } = await seedItem(db, s, { code: `${name}-ITEM`, trackLots: false });
    const warehouseId = await seedWarehouse(db, s, { code: `${name}-WH` });
    return { s, receiptType, issueType, itemId, warehouseId };
  }

  async function receive(w: World, quantity: string, unitPrice: string, on: string) {
    const jobs = recordingJobs();
    await postInventoryDocument(db, w.s, {
      documentTypeId: w.receiptType,
      warehouseId: w.warehouseId,
      effectiveDate: on,
      jobs,
      lines: [{ itemId: w.itemId, warehouseId: w.warehouseId, quantity, unitPrice }],
    });
    return jobs;
  }

  async function runReplay(w: World): Promise<string[]> {
    const ctx = { tenantId: w.s.tenant, actorId: w.s.system, requestId: await uuidv7(db.admin) };
    const { adjustmentsPosted } = await replay(
      db.rw,
      { tenantId: w.s.tenant, requestId: ctx.requestId, payload: { companyId: w.s.company } },
      ctx,
    );
    return adjustmentsPosted;
  }

  /** The ledger's balance on one account (debit − credit, base), the layers' value, and the issue's cost. */
  async function figures(w: World, issueId: string) {
    return withTenant(db.rw, w.s.tenant, w.s.human, async (tx) => {
      const balance = async (code: string) => {
        const [row] = await tx<{ bal: string }[]>`
          select coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::numeric(19,4)::text as bal
            from app.ledger_entry e join app.account a on a.id = e.account_id
           where e.company_id = ${w.s.company} and a.code = ${code}`;
        return row!.bal;
      };
      const [layers] = await tx<{ value: string }[]>`
        select coalesce(sum(round(value * qty_remaining / qty_in, 4)), 0)::numeric(19,4)::text as value
          from app.cost_layer where company_id = ${w.s.company} and invalidated_at is null`;
      const [line] = await tx<{ cost: string }[]>`
        select cost::text as cost from app.document_line where document_id = ${issueId}`;
      return {
        inventory: await balance("1300"),
        cogs: await balance("5000"),
        layers: layers!.value,
        cost: line!.cost,
      };
    });
  }

  /** The two legs of one COST_ADJUSTMENT, by account code. */
  async function adjustment(w: World, documentId: string) {
    return withTenant(
      db.rw,
      w.s.tenant,
      w.s.human,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, e.base_debit::text as debit, e.base_credit::text as credit
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where e.document_id = ${documentId} order by a.code`,
    );
  }

  it("the finding's scenario: 120 @ 5, an override delivery of 125, a back-dated receipt covers the five", async () => {
    const w = await world("C1A");
    await receive(w, "120.000000", "5.0000", "2026-01-05");
    // 125 against 120 on hand: 600.0000 covered + 5 × 5.0000 of shortfall = 625.0000 booked to 5000/1300,
    // with only 600.0000 of cost_consumption rows behind it.
    const { documentId: issueId } = await postOverriddenIssue(db, w.s, {
      documentTypeId: w.issueType,
      itemId: w.itemId,
      warehouseId: w.warehouseId,
      quantity: "125.000000",
      effectiveDate: "2026-01-10",
    });
    const posted = await figures(w, issueId);
    expect(posted).toEqual({
      inventory: "-25.0000",
      cogs: "625.0000",
      layers: "0.0000",
      cost: "625.0000",
    });

    // The back-dated receipt: 5 @ 11.0000 on the 8th. The layers now cover all 125 at (600 + 55) / 125 =
    // 5.2400, so the issue costs 655.0000 and COGS must move by 655 − 625 = 30.0000 — not 655 − 600 = 55.
    const jobs = await receive(w, "5.000000", "11.0000", "2026-01-08");
    expect(jobs.enqueued.map((j) => j.name)).toContain("inventory.cost.replay");
    const first = await runReplay(w);
    expect(first).toHaveLength(1);
    expect(await adjustment(w, first[0]!)).toEqual([
      { code: "1300", debit: "0.0000", credit: "30.0000" },
      { code: "5000", debit: "30.0000", credit: "0.0000" },
    ]);
    const afterFirst = await figures(w, issueId);
    expect(afterFirst.cost).toBe("655.0000");
    expect(afterFirst.cogs).toBe(afterFirst.cost); // the ledger carries the current answer
    expect(afterFirst.inventory).toBe(afterFirst.layers); // 1300 = Σ layers — both 0.0000
    expect(afterFirst.inventory).toBe("0.0000");

    // A SECOND replay afterwards: 125 more @ 5.2400 on the 9th keeps the average at exactly 5.2400, so the
    // issue's cost does not move and no adjustment posts — and every figure still ties.
    await receive(w, "125.000000", "5.2400", "2026-01-09");
    expect(await runReplay(w)).toEqual([]);
    const afterSecond = await figures(w, issueId);
    expect(afterSecond).toEqual({
      inventory: "655.0000",
      cogs: "655.0000",
      layers: "655.0000",
      cost: "655.0000",
    });
  }, 300_000);

  it("a replay that leaves part of the shortfall open books its value, and the next replay starts from it", async () => {
    const w = await world("C1B");
    await receive(w, "120.000000", "5.0000", "2026-01-05");
    const { documentId: issueId } = await postOverriddenIssue(db, w.s, {
      documentTypeId: w.issueType,
      itemId: w.itemId,
      warehouseId: w.warehouseId,
      quantity: "125.000000",
      effectiveDate: "2026-01-10",
    });

    // 2 @ 8.0000 back-dated to the 8th covers two of the five. Average 616 / 122 = 5.0492 (4 dp): 122
    // covered at 616.0000 and 3 short at 15.1476, so the issue now costs 631.1476 and COGS moves by 6.1476.
    // The three units are still an open shortfall, so 1300 lags the layers by its value (ADR 0038 note 7).
    await receive(w, "2.000000", "8.0000", "2026-01-08");
    const first = await runReplay(w);
    expect(first).toHaveLength(1);
    expect(await adjustment(w, first[0]!)).toEqual([
      { code: "1300", debit: "0.0000", credit: "6.1476" },
      { code: "5000", debit: "6.1476", credit: "0.0000" },
    ]);
    const open = await figures(w, issueId);
    expect(open.cost).toBe("631.1476");
    expect(open.cogs).toBe(open.cost);

    // 3 @ 6.0000 back-dated to the 7th covers the rest: (600 + 18 + 16) / 125 = 5.0720 exactly, so the issue
    // costs 634.0000. The second replay's "before" is the 631.1476 the first one booked — covered value AND
    // the shortfall it valued — so COGS moves by 2.8524 and 1300 ties to the (now empty) layers.
    await receive(w, "3.000000", "6.0000", "2026-01-07");
    const second = await runReplay(w);
    expect(second).toHaveLength(1);
    expect(await adjustment(w, second[0]!)).toEqual([
      { code: "1300", debit: "0.0000", credit: "2.8524" },
      { code: "5000", debit: "2.8524", credit: "0.0000" },
    ]);
    expect(await figures(w, issueId)).toEqual({
      inventory: "0.0000",
      cogs: "634.0000",
      layers: "0.0000",
      cost: "634.0000",
    });
  }, 300_000);

  it("the same two replays under FIFO value the open shortfall at Σ value ÷ Σ quantity of the layers taken", async () => {
    const w = await world("C1C");
    await withTenant(
      db.rw,
      w.s.tenant,
      w.s.human,
      (tx) => tx`update app.company set costing_method = 'fifo' where id = ${w.s.company}`,
    );
    await receive(w, "120.000000", "5.0000", "2026-01-05");
    const { documentId: issueId } = await postOverriddenIssue(db, w.s, {
      documentTypeId: w.issueType,
      itemId: w.itemId,
      warehouseId: w.warehouseId,
      quantity: "125.000000",
      effectiveDate: "2026-01-10",
    });
    expect((await figures(w, issueId)).cost).toBe("625.0000"); // 600 taken + 5 × 5.0000

    // FIFO takes both layers whole — 600.0000 + 16.0000 — and values the three short at 616 / 122 = 5.0492,
    // 15.1476: the issue costs 631.1476 and COGS moves by 6.1476.
    await receive(w, "2.000000", "8.0000", "2026-01-08");
    const first = await runReplay(w);
    expect(await adjustment(w, first[0]!)).toEqual([
      { code: "1300", debit: "0.0000", credit: "6.1476" },
      { code: "5000", debit: "6.1476", credit: "0.0000" },
    ]);
    expect((await figures(w, issueId)).cost).toBe("631.1476");

    // Covered in full: 600 + 18 + 16 = 634.0000, so COGS moves by 634 − 631.1476 = 2.8524 and 1300 ties.
    await receive(w, "3.000000", "6.0000", "2026-01-07");
    const second = await runReplay(w);
    expect(await adjustment(w, second[0]!)).toEqual([
      { code: "1300", debit: "0.0000", credit: "2.8524" },
      { code: "5000", debit: "2.8524", credit: "0.0000" },
    ]);
    expect(await figures(w, issueId)).toEqual({
      inventory: "0.0000",
      cogs: "634.0000",
      layers: "0.0000",
      cost: "634.0000",
    });
  }, 300_000);
});
