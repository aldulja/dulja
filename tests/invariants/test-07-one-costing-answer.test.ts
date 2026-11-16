import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts";
import {
  allocateLandedCostForDocument,
  convertOrderToDelivery,
  draftTransfer,
  draftTransferReceipt,
  issueDocument,
  openLayersFor,
  postDocument,
  recordCounts,
  recordOverride,
  replay,
  salesByItem,
  snapshotCountSheet,
  stockOnHand,
  stockOnHandTotals,
  transitionDocument,
  valuationAsOf,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import { loadDocumentTypes } from "@dulja/db/seed";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedBranch,
  seedItem,
  seedLot,
  seedParty,
  seedTenantV2,
  seedUnit,
  seedWarehouse,
  startDb,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { currency, Money, Quantity } from "@dulja/domain";
import { ensureOpenPeriods, recordingJobs, secondPrincipal } from "./support/post-inventory";
import { REPO_ROOT } from "../support/source";

/** Every figure in this suite is a `Money` or a `Quantity`, never a `number`: the three tie-outs are the
 *  slice's "to the cent" claim and an accumulation through binary doubles can decide them either way. */
const MYR = currency("MYR");

/** The seed pack this suite configures its tenant from. Nine of its files are the story's document types and
 *  the tenth, `COST_ADJUSTMENT`, is what the back-dated recost posts: `replay` calls
 *  `resolveAdjustmentAccounts` unconditionally and raises `ERR_NOT_FOUND` on a missing type before any
 *  arithmetic. The path is absolute because Vitest runs this workspace from `tests/`. */
const PACK_DIR = join(REPO_ROOT, "packages", "db", "seed", "my", "document-types");

/**
 * Acceptance test 7 (spec:2425) — "Stock valuation and profit reports tie to the cent for an item that has
 * been transferred, gone negative, and had a supplier return." LEGACY-009.
 *
 * At Phase 3 "profit" is the COST side only: quantity times unit cost from `cost_consumption`. No document
 * type posts revenue before 4A's SALES_INVOICE, so there is no sales value to tie to (hazard 4, and the 3D
 * card says so in the same words). 7B re-runs this test against the revenue-bearing `item_profitability`
 * projection once 4A and 4B exist, under the same report codes.
 *
 * **Hazard 17 is the binding constraint on how "gone negative" is produced.** F-6 admits exactly one route:
 * an issue that exceeds the open layers, authorised by an `inventory.negative_stock.override`
 * `document_event` written by a SECOND principal (§4.5.3). Nothing below toggles a flag, writes a movement
 * directly or relaxes a trigger.
 */
describe("acceptance test 7 — one costing answer (spec:2425, LEGACY-009)", () => {
  let db: Db;
  let ctx: TenantContext;
  let s: Seed;
  let jobs: ReturnType<typeof recordingJobs>;
  let branchB: string;
  let whHq: string;
  let whBr2: string;
  let whTransit: string;
  let unitId: string;
  let itemId: string;
  let lotA: string;
  let lotB: string;
  let supplierId: string;
  let customerId: string;
  /** Every document type of the seed pack, by code — 3D's six, 3C's three and `COST_ADJUSTMENT`. */
  const typeIds: Record<string, string> = {};
  let shipmentId: string;
  let transfer: { documentId: string; receiptId: string };
  let delivery: { documentId: string };
  let supplierReturn: { documentId: string };
  let count: { documentId: string };
  /** Keeps `countShort`'s two principals and their two role codes distinct across repeat calls. */
  let countShortCalls = 0;

  /** A GOODS_RECEIPT of `qty` at `unitCost` into `warehouseId`/`lotId` — the only way stock legitimately
   *  exists (hazard 22). `amount` is computed with `Money`, never `Number(qty) * Number(cost)`. `jobs` is
   *  passed on every post in this file: `postDocument` step 14 REFUSES a back-dated document whose caller
   *  supplied no `JobClient` (LEGACY-005), and the last case back-dates one deliberately. */
  async function receive(
    warehouseId: string,
    lotId: string,
    qty: string,
    unitCost: string,
    effectiveDate: string,
  ): Promise<string> {
    const amount = Money.of(unitCost, MYR).multiply(
      Quantity.of(qty).toDecimal(),
      "HALF_AWAY_FROM_ZERO",
    );
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: typeIds.GOODS_RECEIPT!,
      series: "GRN",
      effectiveDate,
      partyId: supplierId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          lotId,
          unitId,
          quantity: qty,
          unitPrice: unitCost,
          amount: amount.toString(),
        },
      ],
    });
    await withTenant(db.rw, ctx, async (tx) => {
      await issueDocument(tx, ctx, { documentId });
      await postDocument(tx, ctx, { documentId, jobs });
    });
    return documentId;
  }

  /** A SHIPMENT carrying the goods line **and** the freight line, allocated `by_value` before it posts, so
   *  the layer's unit cost is `unitCost + freight ÷ qty`.
   *
   *  **This is 3C's mechanism, and it is not a link.** Landed cost is ONE document: the freight arrives as
   *  an `account` line on the same SHIPMENT, and `allocateLandedCostForDocument` upserts the (cost line ×
   *  goods line) shares while the document is still a DRAFT — `receiptValue(line, landedCost, rate)` is what
   *  turns `line.amount + Σ allocated` into the layer's value, so an allocation written after the post
   *  would change nothing at all. `app.document_link` has no allocation `LinkKind`.
   *
   *  The freight line's account is `5900` other operating expense — the account `seedItem` already creates
   *  — because the SHIPMENT policy debits `1300` and credits `line.account` for every `account` line, so
   *  the credit needs an account that resolves. */
  async function receiveWithLandedCost(
    warehouseId: string,
    lotId: string,
    qty: string,
    unitCost: string,
    freight: string,
    effectiveDate: string,
  ): Promise<string> {
    const goods = Money.of(unitCost, MYR).multiply(
      Quantity.of(qty).toDecimal(),
      "HALF_AWAY_FROM_ZERO",
    );
    const [freightAccount] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ id: string }[]>`
        select id::text as id from app.account
         where company_id = ${s.company} and code = '5900'`,
    );
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId: typeIds.SHIPMENT!,
      series: "SHP",
      effectiveDate,
      partyId: supplierId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          lotId,
          unitId,
          quantity: qty,
          unitPrice: unitCost,
          amount: goods.toString(),
        },
        {
          kind: "account",
          accountId: freightAccount!.id,
          description: "ocean freight and duty",
          amount: freight,
        },
      ],
    });
    await withTenant(db.rw, ctx, async (tx) => {
      await allocateLandedCostForDocument(tx, ctx, {
        documentId,
        allocations: [{ costLineId: lineIds[1]!, method: "by_value" }],
      });
      await issueDocument(tx, ctx, { documentId });
      await postDocument(tx, ctx, { documentId, jobs });
    });
    return documentId;
  }

  /** Dispatch `dispatched` from `from` to `to`, then receive `received` — the two-step transfer end to end.
   *  **`lotId` is explicit.** `TransferInput.lines[].lotId` is optional and `applyMovements` resolves a null
   *  lot to the item's `NONE` sentinel (LEGACY-050), which holds nothing, so a lot-tracked item transferred
   *  without a lot raises ERR_STOCK_INSUFFICIENT before step 4 of the story is ever reached. */
  async function dispatchAndReceive(
    fromWarehouseId: string,
    toWarehouseId: string,
    dispatched: string,
    received: string,
    dispatchDate: string,
    receiveDate: string,
  ): Promise<{ documentId: string; receiptId: string }> {
    return withTenant(db.rw, ctx, async (tx) => {
      const d = await draftTransfer(tx, ctx, {
        fromWarehouseId,
        toWarehouseId,
        effectiveDate: dispatchDate,
        series: "TRF",
        documentTypeId: typeIds.TRANSFER!,
        lines: [{ itemId, unitId, lotId: lotA, quantity: dispatched }],
      });
      await issueDocument(tx, ctx, { documentId: d.documentId });
      await postDocument(tx, ctx, { documentId: d.documentId, jobs });

      const r = await draftTransferReceipt(tx, ctx, {
        transferDocumentId: d.documentId,
        documentTypeId: typeIds.TRANSFER_RECEIPT!,
        series: "TRR",
        effectiveDate: receiveDate,
        received: [{ transferLineId: d.lineIds[0]!, countedQuantity: received }],
      });
      await issueDocument(tx, ctx, { documentId: r.documentId });
      await postDocument(tx, ctx, { documentId: r.documentId, jobs });
      return { documentId: d.documentId, receiptId: r.documentId };
    });
  }

  /** A DELIVERY_ORDER of `qty` out of WH-HQ, admitted past `assert_stock_available` by an
   *  `inventory.negative_stock.override` event attributed to `supervisor`.
   *
   *  Three things this must get exactly right, each of which fails the suite in a way that looks like a
   *  different bug:
   *  1. The ctx is the SAME `s.human` ctx the document was created under, and the supervisor is the
   *     ATTRIBUTED principal. `document_event.actor_id` defaults to `app.current_actor()`, so it is
   *     `s.human` however the ctx is flavoured, and `assert_override_authorised` refuses when
   *     `coalesce(attributed_to, actor_id)` equals `created_by` (§4.5.3). A supervisor-flavoured ctx with no
   *     `attributedTo` raises ERR_OVERRIDE_NOT_AUTHORISED and step 4 never happens.
   *  2. The event is inserted BEFORE `postDocument`: `assert_stock_available` fires inside it.
   *  3. It drafts through `draftTypedDocument` + `convertOrderToDelivery`, NOT through 3B's
   *     `postInventoryDocument` — that helper takes no `partyId` and DELIVERY_ORDER declares
   *     `requires: ["party", "warehouse"]`, so `validateRequires` would refuse at post. */
  async function deliverWithOverride(
    qty: string,
    supervisor: string,
    effectiveDate: string,
  ): Promise<{ documentId: string }> {
    const extended = Money.of("9.0000", MYR).multiply(
      Quantity.of(qty).toDecimal(),
      "HALF_AWAY_FROM_ZERO",
    );
    const order = await draftTypedDocument(db, s, {
      documentTypeId: typeIds.SALES_ORDER!,
      series: "SO",
      effectiveDate,
      partyId: customerId,
      warehouseId: whHq,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId: whHq,
          unitId,
          quantity: qty,
          unitPrice: "9.0000",
          amount: extended.toString(),
        },
      ],
    });
    return withTenant(db.rw, ctx, async (tx) => {
      await issueDocument(tx, ctx, { documentId: order.documentId });
      const { documentId } = await convertOrderToDelivery(tx, ctx, {
        sourceDocumentId: order.documentId,
        targetDocumentTypeId: typeIds.DELIVERY_ORDER!,
        targetSeries: "DO",
        effectiveDate,
        warehouseId: whHq,
        fefo: true,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: qty }],
      });
      await issueDocument(tx, ctx, { documentId });
      await recordOverride(tx, ctx, {
        documentId,
        code: "inventory.negative_stock.override",
        reason: "customer collection, count pending",
        attributedTo: supervisor,
      });
      await postDocument(tx, ctx, { documentId, jobs });
      return { documentId };
    });
  }

  /** 3C's PURCHASE_RETURN of `qty` from `warehouseId` — an issue against that warehouse's own layers. */
  async function returnToSupplier(
    warehouseId: string,
    qty: string,
    effectiveDate: string,
  ): Promise<{ documentId: string }> {
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: typeIds.PURCHASE_RETURN!,
      series: "PR",
      effectiveDate,
      partyId: supplierId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          lotId: lotA,
          unitId,
          quantity: qty,
          unitPrice: "4.0000",
          amount: "0.0000",
        },
      ],
    });
    await withTenant(db.rw, ctx, async (tx) => {
      await issueDocument(tx, ctx, { documentId });
      await postDocument(tx, ctx, { documentId, jobs });
    });
    return { documentId };
  }

  /** A STOCK_COUNT at `warehouseId` finding the first sheet line `short` units light. The R1 pair is real:
   *  the counter drafts and submits, a second principal approves, issues and posts. */
  async function countShort(
    warehouseId: string,
    short: string,
    effectiveDate: string,
  ): Promise<{ documentId: string }> {
    // A monotonic counter, not the date: a `roleCode` is a slug, and embedding `2026-02-25` in one bets on
    // whatever pattern `grantCodes` applies to it. The label is only there to keep repeat calls apart.
    countShortCalls += 1;
    const n = countShortCalls;
    const counter = await secondPrincipal(db, s, `count-maker-${n}`);
    const checker = await secondPrincipal(db, s, `count-checker-${n}`);
    await grantCodes(db, s, {
      codes: ["inventory.count.create"],
      principalId: counter,
      roleCode: `count-maker-${n}`,
    });
    await grantCodes(db, s, {
      codes: ["inventory.adjustment.approve"],
      principalId: checker,
      roleCode: `count-checker-${n}`,
    });
    const counterCtx: TenantContext = {
      tenantId: s.tenant,
      actorId: counter,
      requestId: `count-${n}`,
    };
    const checkerCtx: TenantContext = {
      tenantId: s.tenant,
      actorId: checker,
      requestId: `approve-${n}`,
    };

    const sheet = await withTenant(db.rw, counterCtx, (tx) =>
      snapshotCountSheet(tx, counterCtx, {
        documentTypeId: typeIds.STOCK_COUNT!,
        series: "SC",
        effectiveDate,
        warehouseId,
      }),
    );
    const line = sheet.lines[0]!;
    const counted = Quantity.of(line.expectedQuantity).subtract(Quantity.of(short));
    await withTenant(db.rw, counterCtx, (tx) =>
      recordCounts(tx, counterCtx, {
        documentId: sheet.documentId,
        counts: [{ documentLineId: line.documentLineId, countedQuantity: counted.toString() }],
      }),
    );
    await withTenant(db.rw, counterCtx, (tx) =>
      transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" }),
    );
    await withTenant(db.rw, checkerCtx, async (tx) => {
      await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" });
      await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "issued" });
      await postDocument(tx, checkerCtx, { documentId: sheet.documentId, jobs });
    });
    return { documentId: sheet.documentId };
  }

  /** What is on ONE warehouse's shelves for this item, through Task 10's report rather than a second
   *  arithmetic. `stockOnHandTotals` below is company-wide by design, so it is NOT the figure a delivery out
   *  of WH-HQ is sized against: after the transfer the company holds 148 and head office 120. */
  async function onShelvesAt(warehouseId: string): Promise<Quantity> {
    const rows = await withTenant(db.rw, ctx, (tx) =>
      stockOnHand(tx, { companyId: s.company, itemId, warehouseId, limit: 100 }),
    );
    return rows.reduce((q, r) => q.add(Quantity.of(r.quantity)), Quantity.zero());
  }

  /** THREE figures from ONE query (Task 10), so `onShelves` and `total` cannot be read at two different
   *  instants and report a total that never existed. Company-wide, which is what the definition-of-done
   *  clause's second half is about. */
  async function totals(): Promise<{ onShelves: string; inTransit: string; total: string }> {
    return withTenant(db.rw, ctx, (tx) => stockOnHandTotals(tx, { companyId: s.company, itemId }));
  }

  /**
   * TIE-OUT A, as a pair of strings. Every tie-out in this suite sums EXACTLY: the SQL side at `numeric`
   * precision returned as `::text`, the report side through `Money.add` / `Quantity.add`. A
   * `reduce((n, r) => n + Number(r.value), 0)` over many `numeric(19,4)` values can differ from the exact
   * total in the fourth decimal place, and `.toFixed(4)` then rounds two accumulations to two different
   * strings — a test whose contract is "to the cent" must not be able to pass or fail on accumulation order
   * (Global Constraints 1 and 4, and §3.7.5's `no-number-money`).
   */
  async function tieOutA(): Promise<{ valued: string; ledger: string }> {
    return withTenant(db.rw, ctx, async (tx) => {
      const rows = await valuationAsOf(tx, {
        companyId: s.company,
        asOf: "2026-12-31",
        limit: 500,
      });
      const [bal] = await tx<{ bal: string }[]>`
        select coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::text as bal
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where a.code in ('1300', '1310') and e.company_id = ${s.company}`;
      return {
        valued: rows.reduce((m, r) => m.add(Money.of(r.value, MYR)), Money.zero(MYR)).toString(),
        ledger: Money.of(bal!.bal, MYR).toString(),
      };
    });
  }

  /** TIE-OUT B, as four strings: the layers' quantity, the non-negative projection, the negative residue
   *  and the raw projection total. Which of the last two the layers equal is the whole point — see the case. */
  async function tieOutB(): Promise<{
    valued: string;
    nonNegative: string;
    negative: string;
    raw: string;
  }> {
    return withTenant(db.rw, ctx, async (tx) => {
      const rows = await valuationAsOf(tx, {
        companyId: s.company,
        asOf: "2026-12-31",
        limit: 500,
      });
      const [p] = await tx<{ non_negative: string; negative: string; raw: string }[]>`
        select coalesce(sum(greatest(h.quantity, 0)), 0)::numeric(19,6)::text as non_negative,
               coalesce(sum(least(h.quantity, 0)), 0)::numeric(19,6)::text    as negative,
               coalesce(sum(h.quantity), 0)::numeric(19,6)::text              as raw
          from app.stock_on_hand h
         where h.company_id = ${s.company} and h.item_id = ${itemId}`;
      return {
        valued: rows.reduce((q, r) => q.add(Quantity.of(r.quantity)), Quantity.zero()).toString(),
        nonNegative: Quantity.of(p!.non_negative).toString(),
        negative: Quantity.of(p!.negative).toString(),
        raw: Quantity.of(p!.raw).toString(),
      };
    });
  }

  /** TIE-OUT C, as four strings: the report's cost and delivered quantity, the consumptions on the one
   *  delivery, the `1250` control balance and the delivery’s attributed replay correction. */
  async function tieOutC(): Promise<{
    reported: string;
    deliveredQuantity: string;
    consumed: string;
    control: string;
    adjustment: string;
  }> {
    return withTenant(db.rw, ctx, async (tx) => {
      const rows = await salesByItem(tx, {
        companyId: s.company,
        fromDate: "2026-01-01",
        toDate: "2026-12-31",
        limit: 50,
      });
      const [c] = await tx<{ v: string }[]>`
        select coalesce(sum(c.value), 0)::text as v
          from app.cost_consumption c
          join app.inventory_movement m on m.id = c.movement_id
         where m.document_id = ${delivery.documentId} and c.invalidated_at is null`;
      const [a] = await tx<{ bal: string }[]>`
        select coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::text as bal
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where a.code = '1250' and e.company_id = ${s.company}`;
      // A replay groups every issue's adjustment, including transfers, returns and counts, in 5000.
      // Attribute only this delivery's booked correction to the delivered-cost report, and separately
      // prove that all movement corrections reconcile to the complete adjustment ledger.
      const [g] = await tx<{ bal: string; total: string }[]>`
        select coalesce(sum(b.booked_value - abs(m.value)) filter (where m.document_id = ${delivery.documentId}), 0)::text as bal,
               coalesce(sum(b.booked_value - abs(m.value)), 0)::text as total
          from app.cost_booking b join app.inventory_movement m on m.tenant_id = b.tenant_id and m.id = b.movement_id
         where b.company_id = ${s.company} and b.pending is null`;
      const [ledger] = await tx<{ bal: string }[]>`
        select coalesce(sum(e.base_debit - e.base_credit), 0)::text as bal
          from app.ledger_entry e join app.account a on a.id = e.account_id
          join app.document d on d.id = e.document_id
          join app.document_type t on t.id = d.document_type_id
         where a.code = '5000' and e.company_id = ${s.company} and t.code = 'COST_ADJUSTMENT'`;
      expect(Money.of(g!.total, MYR).toString()).toBe(Money.of(ledger!.bal, MYR).toString());
      return {
        reported: Money.of(rows[0]!.cost, MYR).toString(),
        deliveredQuantity: rows[0]!.deliveredQuantity,
        consumed: Money.of(c!.v, MYR).toString(),
        control: Money.of(a!.bal, MYR).toString(),
        adjustment: Money.of(g!.bal, MYR).toString(),
      };
    });
  }

  /** Drains the `inventory.cost.replay` jobs `recordingJobs()` captured, through 3B's own `replay`, until
   *  none is left — the reason this suite needs no worker process. `replay` runs as many short transactions
   *  (spec:1368) and may enqueue a continuation, so this is a loop and not one call.
   *
   *  Three shapes taken from 3B rather than assumed. (1) `recordingJobs()` returns
   *  `JobClient & { readonly enqueued: readonly RecordedJob[] }` and a `RecordedJob` is
   *  `{ name, payload, singletonKey }` — readonly, with no place to mark one drained, so the drained set is
   *  a local `Set` of indices. (2) `replay(sql, job, ctx)` takes a JobEnvelope, not a bare payload.
   *  (3) It is handed the POOL, not a transaction: it opens its own `withTenant` per batch, and the
   *  production `withTenant` raises ERR_TENANT_CONTEXT_NESTED on a transaction handle. */
  async function runReplayToCompletion(): Promise<void> {
    const drained = new Set<number>();
    const replayCtx: TenantContext = {
      tenantId: s.tenant,
      actorId: s.system,
      requestId: "test-07-replay",
    };
    for (let guard = 0; guard < 50; guard += 1) {
      const index = jobs.enqueued.findIndex(
        (j, i) => j.name === "inventory.cost.replay" && !drained.has(i),
      );
      if (index === -1) return;
      drained.add(index);
      const job = jobs.enqueued[index]!;
      await replay(
        db.rw,
        {
          tenantId: s.tenant,
          requestId: `replay-${index}`,
          payload: job.payload as { companyId: string },
        },
        replayCtx,
      );
    }
    throw new Error(
      "inventory.cost.replay did not converge in 50 batches — that is 3B's bounded-time clause",
    );
  }

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-test-07");
    await ensureOpenPeriods(db, s, 2026);
    // `seedTenant` grants `s.human` NOTHING (§4.1) and 2B's R2 evaluates `approval.post` INSIDE the posting
    // transaction, so without these six every post below is an ERR_RBAC_FORBIDDEN. `grantCodes(db, s)` with
    // no `codes` grants nothing at all — it is not "every code".
    await grantCodes(db, s, {
      codes: [
        "inventory.receipt.create",
        "inventory.receipt.post",
        "inventory.transfer.create",
        "inventory.transfer.post",
        "accounting.purchase.create",
        "accounting.purchase.post",
        "accounting.sales.create",
      ],
    });
    jobs = recordingJobs();
    ctx = { tenantId: s.tenant, actorId: s.human, requestId: "test-07" };

    for (const a of [
      { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" as const },
      { code: "1300", nameEn: "Inventory control", type: "asset" as const },
      { code: "1310", nameEn: "Goods in transit", type: "asset" as const },
      { code: "2150", nameEn: "Goods received not invoiced", type: "liability" as const },
      { code: "5000", nameEn: "Cost of goods sold", type: "expense" as const },
      { code: "5100", nameEn: "Inventory write-off — expiry loss", type: "expense" as const },
      { code: "5110", nameEn: "Stock-count variance", type: "expense" as const },
    ]) {
      await seedAccount(db, s, a);
    }
    branchB = await seedBranch(db, s, { code: "BR-2", nameEn: "Branch 2" });
    whHq = await seedWarehouse(db, s, { code: "WH-HQ", kind: "stock", branchId: s.hq });
    whBr2 = await seedWarehouse(db, s, { code: "WH-BR2", kind: "stock", branchId: branchB });
    whTransit = await seedWarehouse(db, s, {
      code: "WH-BR2-TR",
      kind: "in_transit",
      branchId: branchB,
    });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, { code: "SKU-07", trackLots: true, baseUnitId: unitId }));
    lotA = await seedLot(db, s, { itemId, code: "LOT-A", expiresOn: "2027-01-31" });
    lotB = await seedLot(db, s, { itemId, code: "LOT-B", expiresOn: "2027-06-30" });
    supplierId = await seedParty(db, s, { code: "SUP-1", kind: "vendor" });
    customerId = await seedParty(db, s, { code: "CUST-1", kind: "customer" });
    // Every policy comes from the SEED PACK, loaded by 0C's own loader rather than re-read file by file:
    // it validates each envelope and policy against the shipped schema and the permission catalogue, seeds
    // all ten types (the story's nine plus `COST_ADJUSTMENT`, which the replay needs), and returns their
    // ids. By Task 11 all nine story files exist, so this suite is the last place a drift between a shipped
    // pack file and a test constant could hide — there is no test constant left.
    const seeded = await loadDocumentTypes(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: "test-07-pack" },
      PACK_DIR,
      PERMISSIONS.map((p) => p.code),
    );
    for (const row of seeded) typeIds[row.code] = row.documentTypeId;

    // ── 1. base stock: 100 @ 4.0000 ──────────────────────────────────────
    await receive(whHq, lotA, "100.000000", "4.0000", "2026-02-01");

    // ── 2. a landed-cost receipt: 50 @ 5.0000 plus 100.0000 of freight ───
    // ONE SHIPMENT carrying both lines, allocated `by_value` while it is still a draft, so layer B's unit
    // cost is 5.0000 + 100.0000/50 = 7.0000. This slice does not compute that — it asserts the figure it
    // inherits from 3C's `allocateLandedCostForDocument` and `receiptValue`.
    shipmentId = await receiveWithLandedCost(
      whHq,
      lotB,
      "50.000000",
      "5.0000",
      "100.0000",
      "2026-02-05",
    );

    // ── 3. transfer 30, receive 28 ───────────────────────────────────────
    transfer = await dispatchAndReceive(
      whHq,
      whBr2,
      "30.000000",
      "28.000000",
      "2026-02-10",
      "2026-02-11",
    );

    // ── 4. deliver everything at WH-HQ plus five, through the override ───
    const hqOnHand = await onShelvesAt(whHq); // 100 + 50 − 30 = 120, at head office only
    const supervisor = await secondPrincipal(db, s, "supervisor");
    await grantCodes(db, s, {
      codes: ["inventory.negative_stock.override"],
      principalId: supervisor,
      roleCode: "ovr",
    });
    delivery = await deliverWithOverride(
      hqOnHand.add(Quantity.of("5.000000")).toString(),
      supervisor,
      "2026-02-15",
    );

    // ── 5. supplier return of 10 from the branch ─────────────────────────
    supplierReturn = await returnToSupplier(whBr2, "10.000000", "2026-02-20");

    // ── 6. a stock count at the branch finding one unit short ────────────
    count = await countShort(whBr2, "1.000000", "2026-02-25");
  }, 300_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("no replay was enqueued — every document above is forward-dated, so these are first-pass figures", () => {
    expect(jobs.enqueued.filter((j) => j.name === "inventory.cost.replay")).toEqual([]);
  });

  it("TIE-OUT A — Σ valuationAsOf value = the 1300 + 1310 ledger balances, to the cent", async () => {
    const { valued, ledger } = await tieOutA();
    expect(valued).toBe(ledger);
  });

  it("TIE-OUT B — Σ valuationAsOf quantity = Σ max(stock_on_hand.quantity, 0), and the negative is the override's", async () => {
    // **Why this identity is over the NON-NEGATIVE projection, and why a later pass must not "fix" it back
    // to `stockOnHandTotals(...).total`.** `valuationAsOf` is derived from the layers (3B), and
    // `app.cost_layer.qty_remaining` carries `check (qty_remaining >= 0)` (§4.7.3). A negative on-hand
    // therefore has NO layer that can represent it: the five units the override admitted at WH-HQ are a
    // quantity the ledger and the projection both show and the layers structurally cannot. Comparing Σ
    // layers to the raw Σ `stock_on_hand` would be short by exactly those five units — the same asymmetry
    // tie-out C handles on the value side, where the uncovered quantity has no `cost_consumption` row. So
    // the identity is stated over `greatest(quantity, 0)` and the excursion is asserted beside it, rather
    // than hidden inside a figure that cannot balance.
    const { valued, nonNegative, negative } = await tieOutB();
    expect(valued).toBe(nonNegative);
    expect(negative).toBe("-5.000000"); // the override's uncovered five units, and nothing else
  });

  it("TIE-OUT C — the delivered cost report = Σ cost_consumption on the delivery = the 1250 balance", async () => {
    const { reported, consumed, control, adjustment } = await tieOutC();
    expect(reported).toBe(consumed);
    expect(reported).toBe(control);
    // Non-vacuous: before any recost the COGS account has moved by nothing at all, so the two-term form the
    // last case re-asserts (`control + adjustment`) is the same statement as this one here.
    expect(adjustment).toBe("0.0000");
  });

  it("the override's uncovered five units carry quantity but NO cost, on both sides of tie-out C", async () => {
    // `cost_consumption.layer_id` is NOT NULL (§4.7.3), so the five units no layer covered have no
    // consumption row. They therefore contribute to `deliveredQuantity` and not to `cost`, and the 1250
    // debit is the covered value alone — which is why tie-out C holds rather than being off by five units'
    // worth of a cost that does not exist.
    const { deliveredQuantity } = await tieOutC();
    expect(deliveredQuantity).toBe("125.000000"); // 120 covered + 5 uncovered
    const layersLeft = await withTenant(db.rw, ctx, (tx) =>
      // `baseCurrency` is the branded `CurrencyCode` 3B's signature declares, not a bare "MYR" —
      // `currency("MYR")` is what makes it assignable.
      openLayersFor(tx, { companyId: s.company, itemId, warehouseId: whHq, baseCurrency: MYR }),
    );
    expect(layersLeft.every((l) => l.qtyRemaining.isZero())).toBe(true);
    // Task 5's FEFO split put the uncovered five units on their own line against the item's `NONE` sentinel
    // lot, so WH-HQ has one `stock_on_hand` row per lot (LOT-A 0, LOT-B 0, NONE −5). Sum them: a single-row
    // read would return whichever key the planner produced first.
    const [soh] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ q: string }[]>`
        select coalesce(sum(quantity), 0)::numeric(19,6)::text as q from app.stock_on_hand
         where company_id = ${s.company} and item_id = ${itemId} and warehouse_id = ${whHq}`,
    );
    expect(soh!.q).toBe("-5.000000"); // genuinely negative, and visibly so
  });

  it("the landed cost is IN the tie-out — layer B's unit cost is 7.0000, not 5.0000 (3C's DoD clause)", async () => {
    const layers = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ unit_cost: string; qty_in: string }[]>`
        select l.unit_cost::text as unit_cost, l.qty_in::text as qty_in
          from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
         where m.document_id = ${shipmentId} order by l.sequence`,
    );
    expect(layers.map((l) => l.unit_cost)).toEqual(["7.0000"]);
  });

  it("the transfer's shortfall is in 5110 and the corridor cleared to zero", async () => {
    const { variance, transit } = await withTenant(db.rw, ctx, async (tx) => {
      const [v] = await tx<{ bal: string }[]>`
        select coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::text as bal
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where a.code = '5110' and e.document_id = ${transfer.receiptId}`;
      const [t] = await tx<{ q: string }[]>`
        select coalesce(sum(quantity), 0)::numeric(19,6)::text as q from app.stock_on_hand
         where company_id = ${s.company} and item_id = ${itemId} and warehouse_id = ${whTransit}`;
      return { variance: Money.of(v!.bal, MYR), transit: Quantity.of(t!.q) };
    });
    expect(transit.isZero()).toBe(true);
    expect(variance.isPositive()).toBe(true); // a loss, debited — the exact figure is the AVCO unit cost × 2
    // The definition-of-done clause's second half, through Task 10's one-query totals: once the corridor is
    // clear the company total IS the shelves, and neither warehouse ever carried the goods in between.
    const t = await totals();
    expect(t.inTransit).toBe("0.000000");
    expect(t.total).toBe(t.onShelves);
  });

  it("the supplier return consumed the BRANCH's layers, not head office's", async () => {
    const rows = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ warehouse_id: string; quantity: string }[]>`
        select m.warehouse_id::text as warehouse_id, m.quantity::text as quantity
          from app.inventory_movement m where m.document_id = ${supplierReturn.documentId}`,
    );
    expect(rows).toEqual([{ warehouse_id: whBr2, quantity: "-10.000000" }]);
  });

  it("the stock count posted ONE movement and did not disturb either tie-out", async () => {
    const movements = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.inventory_movement where document_id = ${count.documentId}`,
    );
    expect(movements[0]!.n).toBe(1);
    // …and tie-outs A and B are re-asserted here, after the count, by calling the same two helpers.
    const a = await tieOutA();
    expect(a.valued).toBe(a.ledger);
    const b = await tieOutB();
    expect(b.valued).toBe(b.nonNegative);
    expect(b.negative).toBe("-5.000000");
  });

  it("a BACK-DATED purchase recosts forward only, and all three tie-outs hold again afterwards", async () => {
    // 3B's DoD clause, and the reason test 7 is the LAST costing test: the answer must survive a replay.
    await receive(whHq, lotA, "20.000000", "9.0000", "2026-02-03"); // before steps 3-6
    const replayJobs = jobs.enqueued.filter((j) => j.name === "inventory.cost.replay");
    expect(replayJobs).toHaveLength(1);
    expect(replayJobs[0]!.singletonKey).toBe(s.company);
    await runReplayToCompletion(); // drains the recorded job through 3B's `replay`
    const adjustments = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document d
          join app.document_type t on t.id = d.document_type_id
         where t.code = 'COST_ADJUSTMENT' and d.status = 'posted'`,
    );
    expect(adjustments[0]!.n).toBeGreaterThan(0); // the "visible adjustment entry"

    // TIE-OUT A, verbatim. The adjustment is what makes it hold: the replay rewrites the layers and posts
    // the difference to 1300/5000, so the valuation and the control account move together.
    const a = await tieOutA();
    expect(a.valued).toBe(a.ledger);

    // TIE-OUT B, in its RAW form — and the change of form is the finding, not a relaxation. Twenty units
    // arriving BEFORE the delivery means the layers now cover all 125 of it, so there is no uncovered
    // quantity left for the `greatest(quantity, 0)` form to exclude, and Σ layers equals the raw projection
    // total. The five-unit NONE row is still negative, because a movement is immutable and the recost does
    // not rewrite where the goods went — only what they cost. Asserting the non-negative form here would
    // fail by exactly those five units, and "fixing" it by deleting the movement would be the one thing
    // this suite exists to forbid.
    const b = await tieOutB();
    expect(b.valued).toBe(b.raw);
    expect(b.negative).toBe("-5.000000");

    // TIE-OUT C, in the two-term form the pre-replay case already proved equal to the one-term form. The
    // replay posts the COGS difference to 5000 and NEVER to 1250 (`resolveAdjustmentAccounts` resolves
    // exactly 1300 and 5000), so the delivered cost the report now reports is the original 1250 debit plus
    // the adjustment. Expecting `reported === control` alone here would assert that a recost silently
    // rewrote a posted control account, which is the LEGACY-005 behaviour Phase 3 exists to refuse.
    const c = await tieOutC();
    expect(c.reported).toBe(c.consumed);
    expect(c.reported).toBe(Money.of(c.control, MYR).add(Money.of(c.adjustment, MYR)).toString());
  });
});
