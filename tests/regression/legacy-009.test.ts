import { describe, expect, it } from "vitest";
import { recordOverride, withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7 } from "@dulja/db/test";
import {
  postInventoryDocument,
  recordingJobs,
  secondPrincipal,
} from "../invariants/support/post-inventory";
import { costingContext } from "./support/costing";
import { repoFile, sharedDb } from "../support/regression";
import { payrollFixture, postPayrollRun } from "../invariants/support/payroll";
import { sourceFiles as walkSources } from "../support/source";

const ctx = costingContext("009"); // ← this file's own LEGACY number

describe("LEGACY-009 Three weighted-average formulas that cannot reconcile — 3B", () => {
  // first proven by spec:286, spec:1228, spec:2425
  it("there is exactly ONE weighted-average implementation in the repository", async () => {
    // The mechanical half: no file outside packages/domain/src/costing/ divides a value by a quantity.
    const offenders = (await ctx.sourceFiles(["packages", "apps"]))
      .filter((f) => !f.path.includes("packages/domain/src/costing/"))
      .filter(
        (f) =>
          /\/\s*(?:sum|total)?[Vv]alue\s*\/\s*(?:sum|total)?[Qq]/.test(f.text) ||
          /runningAverage|weightedAverage/.test(f.text),
      );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("the valuation figure and the cost a profit report reads are the same number, to the cent (test 7, cost side)", async () => {
    const { db, s, item, warehouse, receipt, issueType } = await ctx.inventory();
    const jobs = recordingJobs();
    // Bought twice, sold once, GONE NEGATIVE under an authorised override, then a supplier return.
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-05",
      lines: [
        { itemId: item, warehouseId: warehouse, quantity: "60.000000", unitPrice: "10.0000" },
      ],
    });
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-15",
      lines: [
        { itemId: item, warehouseId: warehouse, quantity: "40.000000", unitPrice: "15.0000" },
      ],
    });
    await postInventoryDocument(db, s, {
      documentTypeId: issueType,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-20",
      lines: [
        { itemId: item, warehouseId: warehouse, quantity: "70.000000", unitPrice: "50.0000" },
      ],
    });
    // The excursion: only through inventory.negative_stock.override, recorded by a SECOND principal (F-6).
    await ctx.overriddenIssue(db, s, issueType, warehouse, item, "40.000000", "2026-01-25");
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-28",
      lines: [
        { itemId: item, warehouseId: warehouse, quantity: "20.000000", unitPrice: "18.0000" },
      ],
    });

    const valuation = await ctx.valuation(db, s, "2026-01-31");
    const fromLines = await ctx.sumDocumentLineCost(db, s); // Σ document_line.cost over the issues
    const fromConsumptions = await ctx.sumConsumptionValue(db, s); // Σ cost_consumption.value, valid rows only
    const shortfall = await ctx.openShortfallValue(db, s); // derived from QUANTITIES, not by subtraction
    const receipts = await ctx.receiptValue(db, s);

    // Every figure above, worked by hand, so the next reader checks the assertions instead of re-deriving
    // them — and so a wrong one shows up as a wrong number rather than as a green test:
    //   receipts        60 @ 10 + 40 @ 15 + 20 @ 18                              = 600 + 600 + 360 = 1560.0000
    //   issue of 70     average (600 + 600) ÷ 100 = 12.0000, so                             70 × 12 =  840.0000
    //   issue of 40     30 remain at the same 12.0000 average → 360.0000 consumed,
    //                   plus 10 units of AUTHORISED shortfall valued at 12.0000  →  360 + 120 =  480.0000
    //   Σ document_line.cost over the two issues                                    840 + 480 = 1320.0000
    //   Σ valid cost_consumption.value                                              840 + 360 = 1200.0000
    //   open shortfall  (40 − 30) × 12.0000                                                    =  120.0000
    //   closing layers  20 @ 18                                                                =  360.0000
    //
    // (1) The consumption side plus the shortfall is the line side. NON-VACUOUS: the shortfall came from
    //     `(|movement.quantity| − Σ consumed quantity) × the average it was consumed at`, so this fails if
    //     the engine values a shortfall at anything other than the running average, if a consumption row is
    //     missing, or if document_line.cost is not the engine's own answer.  1200 + 120 = 1320.
    expect(await ctx.plus(db, fromConsumptions, shortfall)).toBe(fromLines);
    // (2) Closing value + what was issued − the unconsumed shortfall = what came in. That last term is the
    //     one ADR 0038 note 7 makes necessary: the shortfall is on the LINE (and so in `fromLines`) but was
    //     never in stock, so it is not part of what the receipts brought in.  360 + 1320 − 120 = 1560.
    expect(await ctx.minus(db, await ctx.plus(db, valuation.value, fromLines), shortfall)).toBe(
      receipts,
    );
    expect(receipts).toBe("1560.0000"); // pin the fixture itself, so a drifted seed is not a drifted rule
  });
});

/**
 * — 3D. The same defect, one slice further on: by Phase 3's end an item has been transferred, driven
 * negative through an authorised override and returned to its supplier, and three reports read it. The
 * behavioural half of that story is `tests/invariants/test-07-one-costing-answer.test.ts` (acceptance test
 * 7, spec:2425); what is asserted here is the structural half LEGACY-009 actually names — that there is still
 * exactly ONE place a valuation is computed, and that the three inventory reports read the projections and
 * the consumptions rather than growing a second arithmetic of their own.
 *
 * `sourceFiles` and `repoFile` are SYNCHRONOUS (`tests/support/source.ts`, `tests/support/regression.ts`),
 * so neither call is awaited; the walker is aliased to `walkSources` so it cannot be confused with the
 * `ctx.sourceFiles` the 3B block above uses.
 */
describe("LEGACY-009 One costing answer across a transfer, an override and a return — 3D", () => {
  it("exactly one module computes a valuation, and every report imports it", () => {
    // The legacy system recomputed stock value in four places with three different answers. Here
    // `valuationAsOf` is the one read (spec:1228) and `costingEngine` the one calculator.
    const files = walkSources(["packages/db/src"]);
    const recomputers = files.filter(
      (f) =>
        /(?:qty_remaining\s*\*\s*unit_cost|(?:\w+\.)?value\s*\*\s*(?:\w+\.)?qty_remaining\s*\/\s*(?:\w+\.)?qty_in)/.test(
          f.text,
        ) && !f.path.startsWith("packages/db/src/costing/"),
    );
    expect(recomputers.map((f) => f.path)).toEqual([]);
  });

  it("the three inventory reports read the projections and the consumptions, never a second arithmetic", () => {
    const soh = repoFile("packages/db/src/reports/stock-on-hand.ts");
    const sbi = repoFile("packages/db/src/reports/sales-by-item.ts");
    expect(soh).toMatch(/app\.stock_on_hand/);
    expect(soh).not.toMatch(/from app\.inventory_movement/);
    expect(sbi).toMatch(/app\.cost_consumption/);
    expect(sbi).not.toMatch(/unit_cost\s*\*/); // no re-multiplication anywhere
  });
});

/**
 * — 3B, found by the first DB-backed run of acceptance test 7. A replay that COVERS an authorised shortfall
 * must move the ledger with the layers. The uncovered movement had no `cost_consumption` row before the
 * replay (ADR 0038 note 7), and `replay`'s adjustment read only movements with an invalidated generation, so
 * the layers gave up the newly covered units' cost and the COST_ADJUSTMENT never booked it — the valuation
 * and the 1300 control parted by exactly that movement's value (27.3511 in test 7's story).
 *
 * Its OWN tenant (`costingContext("009-covered")`): the 3B block above pins company-wide absolutes
 * (`receipts === "1560.0000"`), which any document posted into its company would break.
 */
const covered = costingContext("009-covered");

describe("LEGACY-009 A recost that covers an authorised shortfall reconciles the ledger — 3B (first DB-backed run)", () => {
  it("the replay's adjustment books the cost of a shortfall a back-dated receipt covered", async () => {
    const { db, s, item, warehouse, receipt, issueType } = await covered.inventory();
    const jobs = recordingJobs();
    const line = (quantity: string, unitPrice: string) => ({
      itemId: item,
      warehouseId: warehouse,
      quantity,
      unitPrice,
    });
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-10",
      lines: [line("10.000000", "10.0000")],
    });
    // One issue, two lines. Line 1 takes all ten units; line 2's five then meet NO open layer, so under the
    // override they are valued at the average of nothing (0.0000) and consumed from nothing. Two lines rather
    // than a second document, because a document whose only line costs 0.0000 plans no ledger line at all
    // and is refused ERR_DOC_NO_LINES (§4.3.2 step 6) — test 7's delivery has the same shape.
    const supervisorId = await secondPrincipal(db, s, "sup-covered");
    await grantCodes(db, s, {
      codes: ["inventory.negative_stock.override"],
      principalId: supervisorId,
      roleCode: "sup-covered",
    });
    await postInventoryDocument(db, s, {
      documentTypeId: issueType,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-15",
      lines: [line("10.000000", "50.0000"), line("5.000000", "50.0000")],
      beforePost: async (tx, id) =>
        recordOverride(
          tx,
          { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
          {
            documentId: id,
            code: "inventory.negative_stock.override",
            reason: "authorised excursion (LEGACY-009 covered-shortfall case)",
            attributedTo: supervisorId,
          },
        ),
    });
    // The back-dated receipt that covers them: 20 @ 10 before either movement, so the replay re-costs line 2
    // at 10.0000 against replenished layers.
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-05",
      lines: [line("20.000000", "10.0000")],
    });
    expect(jobs.enqueued.map((j) => j.name)).toContain("inventory.cost.replay");
    const out = await covered.runReplay(db, s);
    expect(out.adjustmentsPosted).toHaveLength(1);

    //   receipts   10 @ 10 + 20 @ 10                                   = 300.0000
    //   issues     line 1: 10 @ 10 = 100.0000; line 2: 5 @ 0 at post, 5 @ 10 = 50.0000 after the replay
    //   layers     30 − 15 = 15 @ 10                                   = 150.0000
    //   1300       300 − 100 − 0 (as posted) − 50 (the adjustment)     = 150.0000
    const valuation = await covered.valuation(db, s, "2026-01-31");
    expect(valuation.value).toBe("150.0000");
    const [control] = await withTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ bal: string }[]>`
        select coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::numeric(19,4)::text as bal
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where a.code = '1300' and e.company_id = ${s.company}`,
    );
    expect(control!.bal).toBe(valuation.value);
  });
});

/**
 * — INV-02 (2026-11-15 full review; ADR 0038's 2026-11-15 amendment). The reversal of a sale returns the goods
 * at the sale's cost (§4.7.2 branch 1). A replay that recosted the sale restored the returned goods' layer
 * from its immutable value, so the valuation and the ledger agreed on the wrong figure and COGS kept the
 * recosted difference of a sale that was fully reversed: two answers for one cost, which is this defect.
 * Its own tenant, for the reason the block above gives.
 */
const mirrored = costingContext("009-mirror");

describe("LEGACY-009 A reversed sale and its returned goods carry one cost through a replay — INV-02", () => {
  it("re-prices the reversal's receipt from the recosted sale, so the pair nets to zero COGS", async () => {
    const { db, s, item, warehouse, receipt, issueType } = await mirrored.inventory();
    const jobs = recordingJobs();
    const post = (type: string, quantity: string, unitPrice: string, effectiveDate: string) =>
      postInventoryDocument(db, s, {
        documentTypeId: type,
        warehouseId: warehouse,
        jobs,
        effectiveDate,
        lines: [{ itemId: item, warehouseId: warehouse, quantity, unitPrice }],
      });
    await post(receipt, "1.000000", "10.0000", "2026-01-10");
    const sale = await post(issueType, "1.000000", "30.0000", "2026-01-15");
    await mirrored.reverse(db, s, sale.documentId, "2026-01-16");
    await post(receipt, "1.000000", "20.0000", "2026-01-05");
    await mirrored.runReplay(db, s);

    //   layers   01-05 1 @ 20 and 01-10 1 @ 10, AVCO 15; the sale costs 15 and its return comes back at 15
    //   value    0.5 @ 20 + 0.5 @ 10 + 1 @ 15                       = 30.0000
    //   5000     +10 (sale) −10 (reversal) +5 / −5 (the replay)      =  0.0000
    const valuation = await mirrored.valuation(db, s, "2026-01-31");
    expect(valuation.value).toBe("30.0000");
    const balances = await withTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ code: string; bal: string }[]>`
        select a.code, coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::numeric(19,4)::text as bal
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where a.code in ('1300', '5000') and e.company_id = ${s.company}
         group by a.code order by a.code`,
    );
    expect(balances).toEqual([
      { code: "1300", bal: "30.0000" },
      { code: "5000", bal: "0.0000" },
    ]);
  });
});

import { fullRegression as posCostRegression } from "../support/api";
import { computeDocumentTax } from "@dulja/db";
import { buildTicket, posFixture, syncRequest, uuidv7Sync } from "../invariants/support/pos";
posCostRegression("LEGACY-009", "POS and equivalent invoice use the same costing answer — 6A", {
  "stock-issuing paths consume identical item, lot, quantity and carrying value": async ({
    api,
  }) => {
    const f = await posFixture(api, "LEGACY009 POS");
    const ticket = buildTicket(f);
    ticket.lines[0]!.taxCodeId = null;
    ticket.lines[0]!.taxAmount.amount = "0.0000";
    const res = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: {
        terminalId: f.terminal.terminalId,
        batchId: uuidv7Sync(),
        tickets: [ticket],
        shifts: [],
        tillEvents: [],
      },
    });
    const out = (await res.json()) as { results: { status: string; documentId: string }[] };
    expect(out.results[0]!.status).toBe("accepted");
    await grantCodes(api.db, f.s, { codes: ["accounting.sales.post"] });
    const invoice = await postInventoryDocument(api.db, f.s, {
      documentTypeId: f.types.POS_EQUIV_INVOICE!,
      warehouseId: f.warehouseId,
      jobs: recordingJobs(),
      effectiveDate: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Kuala_Lumpur" }).format(
        new Date(ticket.soldAt),
      ),
      lines: [
        {
          itemId: ticket.lines[0]!.itemId,
          warehouseId: f.warehouseId,
          unitId: ticket.lines[0]!.unitId,
          quantity: "1.000000",
          unitPrice: ticket.lines[0]!.unitPrice.amount,
        },
      ],
      beforePost: async (tx, id) => {
        await tx`insert into app.document_line(tenant_id,company_id,document_id,line_no,kind,amount,custom_fields) values(${f.s.tenant},${f.s.company},${id},2,'tender',${ticket.tenders[0]!.amount.amount},${tx.json({ method: "cash", reference: null })})`;
        await computeDocumentTax(
          tx,
          { tenantId: f.s.tenant, actorId: f.s.human, requestId: "cost-equivalent" },
          id,
        );
      },
    });
    const tuples = async (id: string) =>
      (
        await api.db.admin<
          Record<string, string>[]
        >`select m.item_id,m.warehouse_id,m.lot_id,c.quantity::text,c.unit_cost::text,c.value::text from app.cost_consumption c join app.inventory_movement m on m.id=c.movement_id where m.document_id=${id}`
      )
        .map((row) => JSON.stringify(row))
        .toSorted();
    const pos = await tuples(out.results[0]!.documentId);
    expect(pos.length).toBeGreaterThan(0);
    expect(pos).toEqual(await tuples(invoice.documentId));
    // Acceptance22 carries the full human API/terminal ledger, dimensions and cost projection.
  },
});

// 8B Task 13 — the payroll analogue: LEGACY-009's root cause was three implementations of one formula. This block mints
// its OWN tenant: `payrollFixture` is not idempotent (8B Execution handoff).
describe("LEGACY-009 Three different weighted-average formulas — 8B (the payroll analogue)", () => {
  it("there is ONE payroll calculator and the run service is its only caller", () => {
    const callers = walkSources([
      "packages/db/src",
      "apps/api/src",
      "apps/worker/src",
      "apps/backoffice/src",
    ])
      .filter((file) => /payrollCalculator\s*\.\s*calculate/.test(file.text))
      .map((file) => file.path)
      .toSorted();
    expect(callers).toEqual(["packages/db/src/hr/run.ts"]);
  });

  it("a PAYROLL run posts through the one posting service — test 28's claim, restated as a defect", async () => {
    // The full multiset comparison is tests/invariants/payroll-one-posting-path.test.ts; this asserts the property
    // LEGACY-009 names: the run's ledger exists only because postDocument wrote it, under the PAYROLL policy it pinned.
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "LEGACY-009");
    const f = await payrollFixture(db, s);
    await grantCodes(db, s, { codes: ["hr.payroll.prepare"] });
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      payDate: "2026-03-05",
      effectiveDate: "2026-02-28",
    });
    const [row] = await db.admin<{ n: number; pinned: number }[]>`
      select count(*)::int as n,
             count(*) filter (where le.posting_policy_id = d.posting_policy_id)::int as pinned
        from app.ledger_entry le join app.document d on d.id = le.document_id
       where le.document_id = ${documentId}`;
    expect(row!.n).toBeGreaterThan(0);
    expect(row!.pinned).toBe(row!.n);
  });
});
