import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Quantity } from "@dulja/domain";
import { issueDocument, postDocument, transitionDocument, voidDocument } from "../../src/posting";
import { recordCounts, snapshotCountSheet, type CountSheetLine } from "../../src/inventory/count";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedUnit,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { ctxOf, GRN_POLICY, STOCK_COUNT_POLICY } from "./policies";
// §4.17.1 amendment 12 (Task 0): the second principal R1 needs, exported rather than copied four times.
import {
  ensureOpenPeriods,
  secondPrincipal,
} from "../../../../tests/invariants/support/post-inventory";
import type { TenantContext } from "../../src/with-tenant";

describe("STOCK_COUNT — posts ONLY the variance (spec:1052, 2026; test 31)", () => {
  let db: Db;
  let s: Seed;
  let scType: string;
  let grnType: string;
  let warehouseId: string;
  let unitId: string;
  let partyId: string;
  let acc1300: string;
  /** Three items, seeded in code order SKU-C1 … SKU-C3. */
  let items: string[];
  /** Two principals — R1 needs a maker and a DIFFERING checker. */
  let counter: string;
  let checker: string;
  let counterCtx: TenantContext;
  let checkerCtx: TenantContext;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-count");
    await grantCodes(db, s);
    // Every sheet below is dated in February 2026, which Plan 0A's `seedTenant` seeds CLOSED (with March
    // locked); `issueDocument` refuses a closed period with ERR_PERIOD_NOT_OPEN before R1 or the variance
    // are ever reached. The same twelve open months every costing and purchasing suite posts into.
    await ensureOpenPeriods(db, s, 2026);
    acc1300 = await seedAccount(db, s, {
      code: "1300",
      nameEn: "Inventory control",
      type: "asset",
    });
    await seedAccount(db, s, { code: "5110", nameEn: "Stock-count variance", type: "expense" });
    // GRN_POLICY's credit leg. Without it the stock-creating receipt raises ERR_POLICY_REQUIRES_MISSING
    // (§4.4.1) and every case below fails in `beforeAll` for a reason that has nothing to do with counting.
    await seedAccount(db, s, {
      code: "2150",
      nameEn: "Goods received not invoiced",
      type: "liability",
    });
    scType = await seedDocumentType(db, s, {
      code: "STOCK_COUNT",
      module: "inventory",
      policy: STOCK_COUNT_POLICY,
    });
    grnType = await seedDocumentType(db, s, {
      code: "GOODS_RECEIPT",
      module: "inventory",
      policy: GRN_POLICY,
    });
    partyId = await seedParty(db, s, { code: "SUP-1", kind: "vendor" });
    warehouseId = await seedWarehouse(db, s, { code: "WH-COUNT", kind: "stock", branchId: s.hq });
    unitId = await seedUnit(db, s, { code: "PCS" });

    // Three items, so "one line has a variance and the other two do not" is a real three-line sheet.
    // `snapshotCountSheet` orders its lines by item code then lot code, so the array below is the sheet's
    // own order and `sheet.lines[0]` is SKU-C1 — which is what lets a case name a line by index.
    items = [];
    for (const code of ["SKU-C1", "SKU-C2", "SKU-C3"]) {
      const { itemId } = await seedItem(db, s, {
        code,
        trackLots: false,
        baseUnitId: unitId,
        accounts: { inventoryAccountId: acc1300 },
      });
      items.push(itemId);
    }

    // The two principals, and the grants that make R1 non-vacuous: the counter may draft and may NOT
    // approve; the checker may approve and post and may NOT draft (Task 2's role split, spec:2159-2161).
    counter = await secondPrincipal(db, s, "counter");
    checker = await secondPrincipal(db, s, "checker");
    await grantCodes(db, s, {
      codes: ["inventory.count.create"],
      principalId: counter,
      roleCode: "counter",
    });
    await grantCodes(db, s, {
      codes: ["inventory.adjustment.approve"],
      principalId: checker,
      roleCode: "checker",
    });
    // `s.human` posts the receipts that create the stock, so it needs the receipt codes and nothing else
    // this suite gates on — the counter and the checker are never `s.human`, which is what keeps R1 real.
    await grantCodes(db, s, { codes: ["inventory.receipt.post", "inventory.receipt.create"] });
    counterCtx = { tenantId: s.tenant, actorId: counter, requestId: "count-maker" };
    checkerCtx = { tenantId: s.tenant, actorId: checker, requestId: "count-checker" };

    // Stock of 10 each at 4.0000, one GOODS_RECEIPT per item so each has its own layer.
    for (const itemId of items) {
      const { documentId } = await draftTypedDocument(db, s, {
        documentTypeId: grnType,
        series: "GRN",
        effectiveDate: "2026-01-05",
        partyId,
        warehouseId,
        lines: [
          {
            kind: "item",
            itemId,
            warehouseId,
            unitId,
            quantity: "10.000000",
            unitPrice: "4.0000",
            amount: "40.0000",
          },
        ],
      });
      await withTenant(db.rw, s.tenant, s.human, (tx) =>
        postDocument(tx, ctxOf(s), { documentId }),
      );
    }
  }, 300_000);
  afterAll(async () => {
    await db?.stop();
  });

  /** The counts to enter: a list, or a function of the sheet as drawn — for a case whose figures depend on
   *  what the cases before it posted into the same warehouse. */
  type Counts =
    | readonly { index: number; counted: string }[]
    | ((lines: readonly CountSheetLine[]) => readonly { index: number; counted: string }[]);

  /** Snapshot a sheet and enter the given counts, leaving it a DRAFT. `index` is the position in the
   *  snapshot's own line order (item code, then lot code), so a case names a line without knowing its uuid. */
  async function snapshotAndRecord(
    counts: Counts,
    effectiveDate: string,
  ): Promise<{ documentId: string; lines: CountSheetLine[] }> {
    const sheet = await withTenant(db.rw, s.tenant, counter, (tx) =>
      snapshotCountSheet(tx, counterCtx, {
        documentTypeId: scType,
        series: "SC",
        effectiveDate,
        warehouseId,
      }),
    );
    const lines = await withTenant(db.rw, s.tenant, counter, (tx) =>
      recordCounts(tx, counterCtx, {
        documentId: sheet.documentId,
        counts: (typeof counts === "function" ? counts(sheet.lines) : counts).map((c) => ({
          documentLineId: sheet.lines[c.index]!.documentLineId,
          countedQuantity: c.counted,
        })),
      }),
    );
    return { documentId: sheet.documentId, lines };
  }

  /** …and take it all the way to `posted` through the R1 pair: the counter submits, the checker approves,
   *  issues and posts. Two principals, because that is the whole point of the type (spec:2026). */
  async function snapshotAndCount(
    counts: Counts,
    effectiveDate: string,
  ): Promise<{ documentId: string; lines: CountSheetLine[] }> {
    const sheet = await snapshotAndRecord(counts, effectiveDate);
    await withTenant(db.rw, s.tenant, counter, (tx) =>
      transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" }),
    );
    await withTenant(db.rw, s.tenant, checker, async (tx) => {
      await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" });
      await issueDocument(tx, checkerCtx, { documentId: sheet.documentId });
      await postDocument(tx, checkerCtx, { documentId: sheet.documentId });
    });
    return sheet;
  }

  /** `ledger_entry.line_no` is the ledger row's OWN ordinal within the document — `unique (document_id,
   *  line_no)` (0001) forbids two rows sharing one — and the table records no source document line, so
   *  which count line a row came from is proven through the movement (which does carry `line_no`) and the
   *  amounts, never read off the ledger. */
  const ledgerOf = (documentId: string) =>
    withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, e.debit::text, e.credit::text
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where e.document_id = ${documentId} order by a.code`,
    );

  it("THE DoD CLAUSE — three lines, one variance: one movement, two ledger rows, nothing for the matches", async () => {
    const sheet = await withTenant(db.rw, s.tenant, counter, (tx) =>
      snapshotCountSheet(tx, counterCtx, {
        documentTypeId: scType,
        series: "SC",
        effectiveDate: "2026-02-01",
        warehouseId,
      }),
    );
    expect(sheet.lines).toHaveLength(3);
    expect(sheet.lines.map((l) => [l.expectedQuantity, l.countedQuantity, l.variance])).toEqual([
      ["10.000000", null, null],
      ["10.000000", null, null],
      ["10.000000", null, null],
    ]);

    // Item 1 counts short by 2; items 2 and 3 match exactly.
    await withTenant(db.rw, s.tenant, counter, (tx) =>
      recordCounts(tx, counterCtx, {
        documentId: sheet.documentId,
        counts: [
          { documentLineId: sheet.lines[0]!.documentLineId, countedQuantity: "8.000000" },
          { documentLineId: sheet.lines[1]!.documentLineId, countedQuantity: "10.000000" },
          { documentLineId: sheet.lines[2]!.documentLineId, countedQuantity: "10.000000" },
        ],
      }),
    );

    // R1: the counter submits, the checker approves and posts.
    await withTenant(db.rw, s.tenant, counter, (tx) =>
      transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" }),
    );
    await withTenant(db.rw, s.tenant, checker, async (tx) => {
      await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" });
      await issueDocument(tx, checkerCtx, { documentId: sheet.documentId });
      await postDocument(tx, checkerCtx, { documentId: sheet.documentId });
    });

    const movements = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ line_no: number; quantity: string; value: string }[]>`
        select line_no, quantity::text, value::text
          from app.inventory_movement where document_id = ${sheet.documentId} order by line_no`,
    );
    expect(movements).toEqual([{ line_no: 1, quantity: "-2.000000", value: "-8.0000" }]);

    const ledger = await ledgerOf(sheet.documentId);
    expect(ledger).toEqual([
      { code: "1300", debit: "0.0000", credit: "8.0000" },
      { code: "5110", debit: "8.0000", credit: "0.0000" },
    ]);
    // The two matching lines contributed NOTHING: the one movement is line 1's, and the two ledger rows
    // together move exactly that movement's value — 8.0000 each side, the whole of it and no more.
  });

  it("a SURPLUS line is valued at the average of the open layers (amendment A8)", async () => {
    // SKU-C2 (index 1) — SKU-C1 is at 8 after the case above posted its shortfall. SKU-C2's stock is still
    // 10 at 4.0000 in one layer. A count finding 13 is a receipt of 3 with NO purchase price, so amendment
    // A8 values it at `average(openLayers)` = 4.0000 and the surplus posts at 12.0000. Lines 1 and 3 are
    // never counted, and an uncounted line posts nothing (recordCounts, docs/runbooks/stock-count.md).
    const sheet = await snapshotAndCount([{ index: 1, counted: "13.000000" }], "2026-02-05");
    expect(await ledgerOf(sheet.documentId)).toEqual([
      { code: "1300", debit: "12.0000", credit: "0.0000" },
      { code: "5110", debit: "0.0000", credit: "12.0000" },
    ]);
    const [layer] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ unit_cost: string; qty_in: string }[]>`
        select l.unit_cost::text, l.qty_in::text
          from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
         where m.document_id = ${sheet.documentId}`,
    );
    expect(layer).toEqual({ unit_cost: "4.0000", qty_in: "3.000000" });
    const movements = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ line_no: number; quantity: string }[]>`
        select line_no, quantity::text from app.inventory_movement where document_id = ${sheet.documentId}`,
    );
    expect(movements).toEqual([{ line_no: 2, quantity: "3.000000" }]); // the uncounted lines: nothing
  });

  it("a fully matching sheet plans no ledger line, so the post is refused and the issued sheet is voided", async () => {
    // Every line's variance is zero, so `quantity_sign` is null on every line: no `when` matches and the
    // evaluator's zero-drop removes every movement (behaviour 3 — inventory_movement carries
    // check (quantity <> 0)). The plan is therefore EMPTY, and the frozen contract (§4.3.2 step 6, round-1
    // correction) refuses a plan with zero ledger lines with ERR_DOC_NO_LINES. The 3D plan and the runbook
    // first said such a sheet posts with an empty ledger; that contradicts step 6, and the frozen contract
    // wins until the owner amends it (docs/reports/phase-4.md records the open item). The count is still
    // evidence: the sheet is issued, numbered, and voided with its reason, so the series gap is explained
    // (SAH-051).
    //
    // The figures are read off the sheet rather than written as 10s, because the two cases above posted into
    // this warehouse (SKU-C1 is at 8, SKU-C2 at 13) and a hard-coded 10 would be a real variance on both.
    const sheet = await snapshotAndRecord(
      (lines) => lines.map((l, index) => ({ index, counted: l.expectedQuantity })),
      "2026-02-10",
    );
    expect(sheet.lines.map((l) => l.variance)).toEqual(["0.000000", "0.000000", "0.000000"]);
    await withTenant(db.rw, s.tenant, counter, (tx) =>
      transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" }),
    );
    await expect(
      withTenant(db.rw, s.tenant, checker, async (tx) => {
        await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" });
        await issueDocument(tx, checkerCtx, { documentId: sheet.documentId });
        await postDocument(tx, checkerCtx, { documentId: sheet.documentId });
      }),
    ).rejects.toThrow(/ERR_DOC_NO_LINES/);
    await withTenant(db.rw, s.tenant, checker, async (tx) => {
      await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" });
      await issueDocument(tx, checkerCtx, { documentId: sheet.documentId });
      await voidDocument(tx, checkerCtx, { documentId: sheet.documentId, reason: "count matched" });
    });
    const [doc] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string; number: string | null; voids: number }[]>`
        select d.status::text, d.number::text,
               (select count(*)::int from app.document_number_void v
                 where v.company_id = d.company_id and v.series = d.series and v.number = d.number) as voids
          from app.document d where d.id = ${sheet.documentId}`,
    );
    expect(doc!.status).toBe("void");
    expect(doc!.number).not.toBeNull(); // it still numbered — a matching count is evidence
    expect(doc!.voids).toBe(1);
    const [counts] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ mv: number; le: number }[]>`
        select (select count(*)::int from app.inventory_movement where document_id = ${sheet.documentId}) as mv,
               (select count(*)::int from app.ledger_entry      where document_id = ${sheet.documentId}) as le`,
    );
    expect(counts).toEqual({ mv: 0, le: 0 });
  });

  // Test 31's THREE paths are two files, not one. The **API** path is a case in
  // `apps/api/test/routes/accounting/document-count.test.ts`: `startApi` and `problemOf` are `apps/api`
  // test-tier helpers (§4.17.1) and §3.1's `dependency-rule` forbids `packages/db` from depending on
  // `apps/api`. The **direct SQL** and **job** paths belong here, where they are what they claim to be: the
  // trigger refusing a write that never went through the API at all.
  it("test 31 by direct `app_rw` SQL: the same principal's UPDATE raises the same token", async () => {
    const { documentId: sheetId } = await snapshotAndRecord(
      [{ index: 0, counted: "9.000000" }],
      "2026-02-15",
    );
    await withTenant(db.rw, s.tenant, counter, (tx) =>
      transitionDocument(tx, counterCtx, { documentId: sheetId, to: "submitted" }),
    );
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        counter,
        (tx) => tx`update app.document set status = 'approved' where id = ${sheetId}`,
      ),
    ).rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER/);
  });

  it("test 31 by job: a job that submitted a sheet cannot approve it — R1 compares ACTORS, not authority", async () => {
    // A job runs as the tenant's system principal (hazard 20). R2 passes — a system principal satisfies
    // `app.actor_has` unconditionally (§4.5.3's first `exists`) — and R1 still refuses, because the job is
    // the actor of the `submitted` transition too. That is test 31's job path as spec:2172 words it ("the
    // actor of the approved … transition must differ from every actor of the submitted transition") and as
    // 2B's `tests/invariants/segregation-of-duties.test.ts` runs it: byJob submits, byJob approves.
    //
    // It is NOT "a job cannot approve a human's submission": the job's actor differs from the counter's, so
    // spec:2172 admits that approval, and 2B's suite asserts the mirror image (a human approving a job's
    // submission) succeeds. Requiring a HUMAN approver would be a new control, which is an ADR, not a test.
    const job = { tenantId: s.tenant, actorId: s.system, requestId: "job-approve" };
    const sheet = await snapshotAndRecord([{ index: 0, counted: "9.000000" }], "2026-02-16");
    await withTenant(db.rw, s.tenant, s.system, (tx) =>
      transitionDocument(tx, job, { documentId: sheet.documentId, to: "submitted" }),
    );
    await expect(
      withTenant(db.rw, s.tenant, s.system, (tx) =>
        transitionDocument(tx, job, { documentId: sheet.documentId, to: "approved" }),
      ),
    ).rejects.toThrow(
      /ERR_SOD_MAKER_IS_CHECKER: principal .* submitted document .* and cannot approve it/,
    );
  });

  it("an approver who never received a submission is refused: draft → approved is not a legal transition", async () => {
    // draft -> approved directly. 0022's matrix (block 2a) runs BEFORE R1 (block 2b) and has no
    // `draft → approved` pair, so the refusal is ERR_DOC_STATUS_ILLEGAL and R1's ERR_SOD_NO_SUBMISSION is
    // unreachable from any draft — `packages/db/test/document-status.test.ts` says so and reaches that code
    // the only way it can be reached, a row INSERTED at `submitted` with no event history.
    const sheet = await snapshotAndRecord([{ index: 0, counted: "9.000000" }], "2026-02-17");
    await expect(
      withTenant(db.rw, s.tenant, checker, (tx) =>
        transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" }),
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: draft → approved is not a legal transition/);
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string }[]>`
        select status::text as status from app.document where id = ${sheet.documentId}`,
    );
    expect(row!.status).toBe("draft");
  });

  it("recordCounts refuses a non-draft sheet, so a submitted count cannot be edited", async () => {
    const sheet = await snapshotAndRecord([{ index: 0, counted: "9.000000" }], "2026-02-18");
    await withTenant(db.rw, s.tenant, counter, (tx) =>
      transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" }),
    );
    await expect(
      withTenant(db.rw, s.tenant, counter, (tx) =>
        recordCounts(tx, counterCtx, {
          documentId: sheet.documentId,
          counts: [{ documentLineId: sheet.lines[0]!.documentLineId, countedQuantity: "1.000000" }],
        }),
      ),
    ).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: count sheet .* is submitted; counted quantities may only be entered on a draft/,
    );
  });

  it("a line no count names keeps a NULL counted quantity and a NULL variance", async () => {
    // Line 1 is counted one short of whatever the sheet drew — SKU-C1 is no longer at its opening 10 once
    // the DoD case above has posted its shortfall, so a literal count would not be "one short".
    const sheet = await snapshotAndRecord(
      (lines) => [
        {
          index: 0,
          counted: Quantity.of(lines[0]!.expectedQuantity)
            .subtract(Quantity.of("1.000000"))
            .toString(),
        },
      ],
      "2026-02-19",
    );
    const oneShort = Quantity.of(sheet.lines[0]!.expectedQuantity).subtract(
      Quantity.of("1.000000"),
    );
    expect(sheet.lines.map((l) => [l.countedQuantity, l.variance])).toEqual([
      [oneShort.toString(), "-1.000000"],
      [null, null],
      [null, null],
    ]);
  });

  it("a sheet over a warehouse with no stock is ERR_DOC_NO_LINES, not an empty document", async () => {
    const empty = await seedWarehouse(db, s, {
      code: "WH-EMPTY",
      kind: "stock",
      branchId: s.hq,
    });
    await expect(
      withTenant(db.rw, s.tenant, counter, (tx) =>
        snapshotCountSheet(tx, counterCtx, {
          documentTypeId: scType,
          series: "SC",
          effectiveDate: "2026-02-20",
          warehouseId: empty,
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_NO_LINES: warehouse WH-EMPTY has no stock to count/);
  });

  it("`quantity` and `counted_quantity` are written together — no line has one without the other", async () => {
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document_line
         where (counted_quantity is null) <> (quantity is null)
           and expected_quantity is not null`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});
