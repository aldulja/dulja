import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creditNoteFrom } from "../../src/ar-ap/credit-note";
import { postDocument, reverseDocument } from "../../src/posting";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";
import {
  ensureOpenPeriods,
  recordingJobs,
} from "../../../../tests/invariants/support/post-inventory";
import { loadTypesFromPack } from "./_support";

let db: Db;
let s: Seed;
let doType: string;
let itemId: string;
let doId: string;
let reversalId: string;
let grType: string;
let customerId: string;
let vendorId: string;
let warehouseId: string;
const ctxOf = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/** Balance of an account in base, signed debit − credit, at scale 4 — `0.0000`, not `0`, on an empty account. */
async function net(code: string): Promise<string> {
  const [row] = await db.admin<{ net: string }[]>`
    select coalesce(sum(e.base_debit - e.base_credit), 0)::numeric(19,4)::text as net
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where a.company_id = ${s.company} and a.code = ${code}`;
  return row!.net;
}

async function onHand(): Promise<string> {
  const [row] = await db.admin<{ q: string }[]>`
    select coalesce(sum(quantity), 0)::numeric(19,6)::text as q from app.stock_on_hand
     where company_id = ${s.company} and item_id = ${itemId}`;
  return row!.q;
}

/** postDocument as `s.human`, with a job client (a stock post may enqueue the projection rebuild). */
const post = (documentId: string) =>
  withTenant(db.rw, s.tenant, s.human, (tx) =>
    postDocument(tx, ctxOf(s), { documentId, jobs: recordingJobs() }),
  );

/** A refused post left the document a numberless draft with no ledger row and no movement. */
async function untouched(documentId: string): Promise<void> {
  const [row] = await db.admin<
    { status: string; number: string | null; ledger: number; moves: number }[]
  >`
    select d.status::text as status, d.number::text as number,
           (select count(*)::int from app.ledger_entry e where e.document_id = d.id) as ledger,
           (select count(*)::int from app.inventory_movement m where m.document_id = d.id) as moves
      from app.document d where d.id = ${documentId}`;
  expect(row).toEqual({ status: "draft", number: null, ledger: 0, moves: 0 });
}

/** The item's movement value (signed, `value` follows `quantity`) less its inventory account's ledger net. */
async function valuationGap(): Promise<string> {
  const [row] = await db.admin<{ gap: string }[]>`
    select ((select coalesce(sum(m.value), 0) from app.inventory_movement m
              where m.company_id = ${s.company} and m.item_id = ${itemId})
            - (select coalesce(sum(e.base_debit - e.base_credit), 0)
                 from app.ledger_entry e join app.account a on a.id = e.account_id
                where a.company_id = ${s.company} and a.code = '1300'))::numeric(19,4)::text as gap`;
  return row!.gap;
}

/**
 * This file exists for one reason: 3d:2723 says the movement claim of a DELIVERY_ORDER reversal is 3D's and
 * the ledger claim is not, and that the fix "must land before Phase 4 relies on a DELIVERY_ORDER reversal to
 * clear 1250". Task 4 (ADR 0045) landed the fix; this proves it end to end on the real SEEDED types. Its
 * fixtures are its own — the credit-note suite has no warehouse and no layers on purpose.
 *
 * Both documents are drafted with 3C's `draftTypedDocument` and posted through the REAL `postDocument`: the
 * tree's `postInventoryDocument` takes a type id and drafts no party, and both pack types require one.
 */
beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "stock-return");
  await ensureOpenPeriods(db, s, 2026);
  // `1300` comes with `seedItem`, `5920` with `seedTenantV2`; `seedAccount` is idempotent. 4A seeds no account.
  for (const [code, nameEn, type] of [
    ["1250", "Goods delivered not invoiced", "asset"],
    ["1300", "Inventory control", "asset"],
    ["2150", "Goods received not invoiced", "liability"],
  ] as const) {
    await seedAccount(db, s, { code, nameEn, type });
  }
  const types = await loadTypesFromPack(db, s, ["DELIVERY_ORDER", "GOODS_RECEIPT"]);
  doType = types.deliveryOrderType!;
  // The receipt's and the delivery's post codes — the reversal posts under the delivery's own.
  await grantCodes(db, s, { codes: ["inventory.receipt.post", "inventory.transfer.post"] });
  grType = types.goodsReceiptType!;
  customerId = await seedParty(db, s, { kind: "customer", code: "CUST-RET" });
  vendorId = await seedParty(db, s, { kind: "vendor", code: "VEND-RET" });
  const partyId = customerId;
  ({ itemId } = await seedItem(db, s, { code: "IT-RET", kind: "product", trackLots: false }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-RET" });
  // Ten units at 3.0000, then deliver four.
  const grn = await draftTypedDocument(db, s, {
    documentTypeId: types.goodsReceiptType!,
    series: "GRN",
    effectiveDate: "2026-01-05",
    partyId: vendorId,
    warehouseId,
    lines: [
      {
        kind: "item",
        itemId,
        warehouseId,
        quantity: "10.000000",
        unitPrice: "3.0000",
        amount: "30.0000",
      },
    ],
  });
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    postDocument(tx, ctxOf(s), { documentId: grn.documentId, jobs: recordingJobs() }),
  );
  const delivery = await draftTypedDocument(db, s, {
    documentTypeId: doType,
    series: "DO",
    effectiveDate: "2026-01-10",
    partyId,
    warehouseId,
    lines: [
      {
        kind: "item",
        itemId,
        warehouseId,
        quantity: "4.000000",
        unitPrice: "9.0000",
        amount: "36.0000",
      },
    ],
  });
  doId = delivery.documentId;
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    postDocument(tx, ctxOf(s), { documentId: doId, jobs: recordingJobs() }),
  );
}, 240_000);
afterAll(async () => {
  await db.stop();
});

describe("the DELIVERY_ORDER reversal — 3d:2723's deferred proof, ADR 0045, §4.7.2 branch 1", () => {
  it("the delivery filled the corridor and took the stock out — the starting state", async () => {
    expect(await net("1250")).toBe("12.0000"); // 4 × 3.0000, the cost the layer gave up
    expect(await net("1300")).toBe("18.0000"); // 30.0000 in, 12.0000 out
    expect(await onHand()).toBe("6.000000");
  });

  it("a PARTIAL stock return has no path through creditNoteFrom: a stock document is refused by policy shape", async () => {
    // A partial negated delivery would be a fourth writer of document_line.cost (contracts §4.7.2 amendment 5).
    // 4A ships the whole-document reversal below and nothing else (Task 8's decision).
    const [line] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${doId} order by line_no`;
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        creditNoteFrom(tx, ctxOf(s), {
          companyId: s.company,
          settledDocumentId: doId,
          targetDocumentTypeId: doType,
          targetSeries: "DO",
          effectiveDate: "2026-01-11",
          reason: "two units back",
          lines: [{ settledLineId: line!.id, quantity: "2.000000" }],
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .*is a stock document \(DELIVERY_ORDER\)/);
  });

  it("reverseDocument produces a DELIVERY_ORDER with negated quantities and the cost copied UNNEGATED", async () => {
    ({ reversalDocumentId: reversalId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctxOf(s), {
        documentId: doId,
        effectiveDate: "2026-01-11",
        reason: "customer returned the whole delivery",
        jobs: recordingJobs(),
      }),
    ));
    const [head] = await db.admin<{ code: string }[]>`
      select t.code from app.document d join app.document_type t on t.id = d.document_type_id
       where d.id = ${reversalId}`;
    expect(head!.code).toBe("DELIVERY_ORDER");
    const [line] = await db.admin<{ quantity: string; cost: string }[]>`
      select quantity::text as quantity, cost::text as cost from app.document_line
       where document_id = ${reversalId} order by line_no`;
    expect(line!.quantity).toBe("-4.000000");
    expect(line!.cost).toBe("12.0000"); // 3c:219 — a magnitude, copied and not negated
  });

  it("A2 flips the issue into a RECEIPT: one movement, POSITIVE quantity, valued at branch 1's copied cost", async () => {
    const movements = await db.admin<{ quantity: string; value: string }[]>`
      select quantity::text as quantity, value::text as value from app.inventory_movement
       where document_id = ${reversalId} order by movement_no`;
    expect(movements).toHaveLength(1);
    expect(movements[0]!.quantity).toBe("4.000000"); // + is a receipt (3A's column comment, spec:2043)
    // NOT 36.0000: branch 1 read the copied cost, not branch 3's toBase(line.amount, rate).
    expect(movements[0]!.value).toBe("12.0000");
  });

  it("and ADR 0045 sends the ledger the other way: 1250 CREDITED, 1300 DEBITED, corridor back to zero", async () => {
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text as debit, e.credit::text as credit
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${reversalId} order by a.code`;
    expect(rows).toEqual([
      { code: "1250", debit: "0.0000", credit: "12.0000" },
      { code: "1300", debit: "12.0000", credit: "0.0000" },
    ]);
    expect(await net("1250")).toBe("0.0000"); // the corridor is empty again — the invariant
    expect(await net("1300")).toBe("30.0000"); // every unit is back on the books at its own cost
    expect(await onHand()).toBe("10.000000");
  });

  it("the returned units come back as their OWN layer at the cost they left at — 3.0000, never 9.0000", async () => {
    // `cost_layer` carries `unique (movement_id)` (3B), so a receipt movement always makes a layer; the
    // reversal does not reopen the layer it consumed. Two layers, both at the receipt cost, ten units.
    const layers = await db.admin<{ unit_cost: string; qty_remaining: string }[]>`
      select unit_cost::text as unit_cost, qty_remaining::text as qty_remaining
        from app.cost_layer
       where company_id = ${s.company} and item_id = ${itemId} and invalidated_at is null
       order by sequence`;
    expect(layers.map((l) => l.unit_cost)).toEqual(["3.0000", "3.0000"]);
    expect(layers.map((l) => l.qty_remaining)).toEqual(["6.000000", "4.000000"]);
    // …and the ledger agrees with the layers to the cent: 6 × 3 + 4 × 3 = 30.0000 = net("1300").
    expect(await net("1300")).toBe("30.0000");
  });

  // The plan's sixth case — "a HAND-DRAFTED negated delivery cannot be accepted on the wire" — asserts 2A's
  // `DocumentLineInput` schema, which lives in `@dulja/contracts`, and this directory may not import that
  // package (dependency-rule). It is asserted where it can be: `tests/regression/sah-018.test.ts`'s 4A block.
  // The schema bounds the money fields only — a quantity is signed — so the data-layer half, a negated
  // delivery drafted by any path and refused at post, is the M1-X block below (code review 2).
});

// ── Code review 2 (Phase 4), finding M1-X: a hand-drafted negative line on a stock policy is refused ────────
// A return is reverseDocument of the original (the case above). Drafted by hand, the negative line has no
// cost at step 6 and a non-negative amount, so the ledger kept the policy's FORWARD side while the movement
// flipped: each case below posted on e8df83b, with the stock and the ledger disagreeing.
describe("M1-X — a negative-quantity line on a stock-moving policy is a return, and only reverseDocument makes one", () => {
  const negatedDelivery = async (amount: string) =>
    (
      await draftTypedDocument(db, s, {
        documentTypeId: doType,
        series: "DO",
        effectiveDate: "2026-01-12",
        partyId: customerId,
        warehouseId,
        lines: [
          {
            kind: "item",
            itemId,
            warehouseId,
            quantity: "-2.000000",
            unitPrice: "20.0000",
            amount,
          },
        ],
      })
    ).documentId;

  it("a DELIVERY_ORDER drafted at -2 / 40.0000 is refused, not posted as a receipt at the sale price", async () => {
    const before = [await net("1250"), await net("1300"), await onHand()];
    const id = await negatedDelivery("40.0000");
    await expect(post(id)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 1: a negative-quantity DELIVERY_ORDER line is a return; a return is POST …\/reverse of the original/,
    );
    await untouched(id);
    expect([await net("1250"), await net("1300"), await onHand()]).toEqual(before);
  });

  it("the same at amount 0 is refused, not posted with no ledger at all", async () => {
    const id = await negatedDelivery("0.0000");
    await expect(post(id)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: .*negative-quantity DELIVERY_ORDER/,
    );
    await untouched(id);
  });

  it("the mirror, a GOODS_RECEIPT drafted at -2 / 20.0000, is refused, not posted as an issue on the receipt's sides", async () => {
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: grType,
      series: "GRN",
      effectiveDate: "2026-01-12",
      partyId: vendorId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          quantity: "-2.000000",
          unitPrice: "10.0000",
          amount: "20.0000",
        },
      ],
    });
    await expect(post(documentId)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: .*negative-quantity GOODS_RECEIPT line is a return/,
    );
    await untouched(documentId);
  });

  // The verification of M1-X's first fix: `planMovements` moves a line by its `item_id`, while every seeded
  // stock policy matches its rules on `line.kind: "item"`. A negative line of kind `account` that carries an
  // item met NO rule, so the predicate admitted it vacuously — and it was still planned as a flipped
  // movement: a +2 receipt valued through §4.7.2 branch 3 at the line amount, with no ledger behind it.
  it("an ACCOUNT line carrying an item at -2 / 40.0000 is refused too: meeting no rule is not choosing a sign", async () => {
    const corridorId = await seedAccount(db, s, {
      code: "1250",
      nameEn: "Goods delivered not invoiced",
      type: "asset",
    });
    const before = [await net("1250"), await net("1300"), await onHand(), await valuationGap()];
    expect(before[3]).toBe("0.0000"); // the valuation and the ledger agree before the attempt
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: doType,
      series: "DO",
      effectiveDate: "2026-01-12",
      partyId: customerId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          quantity: "1.000000",
          unitPrice: "20.0000",
          amount: "20.0000",
        },
        {
          kind: "account",
          accountId: corridorId,
          itemId,
          warehouseId,
          quantity: "-2.000000",
          unitPrice: "20.0000",
          amount: "40.0000",
        },
      ],
    });
    await expect(post(documentId)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 2: a negative-quantity DELIVERY_ORDER line is a return/,
    );
    await untouched(documentId);
    expect([await net("1250"), await net("1300"), await onHand(), await valuationGap()]).toEqual(
      before,
    );
  });
});

// ── Code review 3 (Phase 4), R4: only a line the policy accounts for moves stock ─────────────────────────────
// `planMovements` moves a line by its `item_id`, whatever its kind and whatever rule it meets, and the API's
// DocumentLineInput accepts `itemId`, `warehouseId` and `quantity` on any kind. M1-X's step 6d refused the
// NEGATIVE case only, so the positive one still posted on 381bb34 — each case below did, with the stock and
// the ledger disagreeing or with units conjured from a line that is not a stock line.
describe("R4 — a line that moves stock is an item line that its policy accounts for", () => {
  it("a POSITIVE account line on 1250 carrying an item, 2 at 18.0000, is refused: its stock would leave with no 1300 leg", async () => {
    const corridorId = await seedAccount(db, s, {
      code: "1250",
      nameEn: "Goods delivered not invoiced",
      type: "asset",
    });
    const before = [await net("1250"), await net("1300"), await onHand(), await valuationGap()];
    expect(before[3]).toBe("0.0000");
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: doType,
      series: "DO",
      effectiveDate: "2026-01-12",
      partyId: customerId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          quantity: "1.000000",
          unitPrice: "9.0000",
          amount: "9.0000",
        },
        {
          kind: "account",
          accountId: corridorId,
          itemId,
          warehouseId,
          quantity: "2.000000",
          unitPrice: "9.0000",
          amount: "18.0000",
        },
      ],
    });
    await expect(post(documentId)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 2: a line of kind 'account' carrying item .* would move stock; only an item line moves stock/,
    );
    await untouched(documentId);
    expect([await net("1250"), await net("1300"), await onHand(), await valuationGap()]).toEqual(
      before,
    );
  });

  it("an account line carrying an item is refused even where it MEETS a rule: GOODS_RECEIPT's landed-cost rule is not a stock rule", async () => {
    // The receipt's `line.kind: account` rule is the landed-cost pair (Dr 1300 / Cr the line's account), so
    // "meets a rule" alone admitted this freight line — and it received 2 units of the item that no one
    // delivered, valued at the freight charge, on top of the goods line.
    const freightId = await seedAccount(db, s, {
      code: "2160",
      nameEn: "Freight clearing",
      type: "liability",
    });
    const before = [await net("1300"), await onHand(), await valuationGap()];
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: grType,
      series: "GRN",
      effectiveDate: "2026-01-12",
      partyId: vendorId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          quantity: "1.000000",
          unitPrice: "3.0000",
          amount: "3.0000",
        },
        {
          kind: "account",
          accountId: freightId,
          itemId,
          warehouseId,
          quantity: "2.000000",
          amount: "18.0000",
        },
      ],
    });
    await expect(post(documentId)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 2: a line of kind 'account' carrying item .* would move stock; only an item line moves stock/,
    );
    await untouched(documentId);
    expect([await net("1300"), await onHand(), await valuationGap()]).toEqual(before);
  });

  it("an ITEM line that meets no each_line rule of its stock policy is refused: the movement would have no ledger leg", async () => {
    // A zero-code stock policy (acceptance test 15's route) whose only rules are account rules: the item line
    // moved 2 units out at cost with nothing in the ledger behind them.
    const typeId = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: {
        version: 1,
        documentType: "STOCK_ISSUE_TEST",
        direction: "internal",
        requires: [],
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { from: "line.account" },
            amount: "line.debit",
            when: { "line.kind": "account" },
          },
          {
            for: "each_line",
            side: "credit",
            account: { from: "line.account" },
            amount: "line.credit",
            when: { "line.kind": "account" },
          },
        ],
        inventory: { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" },
        tax: { applies: false },
        numbering: { series: "SIT", assignAt: "issue" },
        reversal: { allowed: true, producesType: "STOCK_ISSUE_TEST" },
        approval: { required: false, approve: null, post: "inventory.transfer.post" },
        fxRoundingAccount: { from: "company.fx_rounding_account_id" },
        dimensions: { required: [] },
      },
    });
    const before = [await net("1300"), await onHand(), await valuationGap()];
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: typeId,
      series: "SIT",
      effectiveDate: "2026-01-12",
      warehouseId,
      lines: [
        { kind: "account", accountId: s.sales, debit: "1.0000" },
        { kind: "account", accountId: s.cash, credit: "1.0000" },
        { kind: "item", itemId, warehouseId, quantity: "2.000000", amount: "0.0000" },
      ],
    });
    await expect(post(documentId)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 3: no each_line rule of the STOCK_ISSUE_TEST policy meets this item line/,
    );
    await untouched(documentId);
    expect([await net("1300"), await onHand(), await valuationGap()]).toEqual(before);
  });
});
