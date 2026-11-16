import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureOpenPeriods,
  postInventoryDocument,
  recordingJobs,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import { linkFulfilment, postDocument, reverseDocument } from "../../src/index";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { documentTypesLoader, type SubPack } from "../../src/seed/index";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedCurrency,
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

const PACK_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "seed", "my");

let db: Db;

const ctx = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "00000000-0000-0000-0000-00000000c0c0",
});

beforeAll(async () => {
  db = await startDb();
}, 300_000);
afterAll(async () => {
  await db.stop();
});

/**
 * Code review, stream C — finding C2, through the real `postDocument`. A foreign-currency type whose policy
 * lines do not pair line for line (revenue per line, the receivable once from the document total) leaves a
 * base residue that step 6 absorbs with a base-currency fx_rounding line; its paired cost legs are base too.
 * Step 9a's re-balance then saw that line with no partner in the base group and refused the posting — and
 * the PolicyEvaluationError it raised escaped `postDocument` untranslated.
 */
describe("C2 — a foreign-currency issue with an fx_rounding line posts through step 9a", () => {
  let s: Seed;
  let itemId: string;
  let baseUnitId: string;
  let warehouseId: string;
  let receiptType: string;

  /** The fixture's shape, test-only: one document-level debit, per-line revenue, a paired cost leg. */
  const UNPAIRED = {
    version: 1,
    documentType: "USD_ISSUE_TEST",
    direction: "outbound",
    requires: [],
    lines: [
      {
        for: "document",
        side: "debit",
        account: { code: "1200" },
        amount: "document.total_excl_tax",
      },
      {
        for: "each_line",
        side: "credit",
        account: { code: "4000" },
        amount: "line.amount",
        when: { "line.kind": "item" },
      },
      {
        for: "each_line",
        side: "debit",
        account: { from: "item.cogs_account" },
        amount: "line.cost",
        when: { "line.kind": "item" },
      },
      {
        for: "each_line",
        side: "credit",
        account: { from: "item.inventory_account" },
        amount: "line.cost",
        when: { "line.kind": "item" },
      },
    ],
    inventory: { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" },
    tax: { applies: false },
    numbering: { series: "UIT", assignAt: "issue" },
    reversal: { allowed: false, producesType: null },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    dimensions: { required: [] },
  };

  beforeAll(async () => {
    s = await seedTenantV2(db, "C2");
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    await seedAccount(db, s, { code: "1200", nameEn: "Trade receivables", type: "asset" });
    await seedCurrency(db, s, { code: "USD" });
    receiptType = await seedDocumentType(db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    ({ itemId, baseUnitId } = await seedItem(db, s, { code: "C2-ITEM", trackLots: false }));
    warehouseId = await seedWarehouse(db, s, { code: "C2-WH" });
    await postInventoryDocument(db, s, {
      documentTypeId: receiptType,
      warehouseId,
      effectiveDate: "2026-01-05",
      jobs: recordingJobs(),
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "3.0000" }],
    });
  }, 300_000);

  /** Two USD 1.0000 lines at 4.12345678: 4.1235 each, the total 8.2469 — a base residue of −0.0001. */
  async function usdIssue(documentTypeId: string, on: string): Promise<string> {
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId,
      series: "UIT",
      effectiveDate: on,
      currency: "USD",
      exchangeRate: "4.12345678",
      warehouseId,
      lines: [1, 2].map((lineNo) => ({
        lineNo,
        kind: "item" as const,
        itemId,
        unitId: baseUnitId,
        warehouseId,
        quantity: "1.000000",
        unitPrice: "1.0000",
        amount: "1.0000",
      })),
    });
    return documentId;
  }

  it("posts, with exactly one fx_rounding line, and the entry balances in base", async () => {
    const typeId = await seedDocumentType(db, s, { code: "USD_ISSUE_TEST", policy: UNPAIRED });
    const documentId = await usdIssue(typeId, "2026-01-10");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }),
    );
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; currency: string; base_debit: string; base_credit: string }[]>`
        select a.code, e.currency, e.base_debit::text as base_debit, e.base_credit::text as base_credit
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where e.document_id = ${documentId} order by e.line_no`,
    );
    expect(rows.filter((r) => r.code === "5920")).toEqual([
      { code: "5920", currency: "MYR", base_debit: "0.0001", base_credit: "0.0000" },
    ]);
    // 1200 8.2469; 4000 4.1235 × 2; the cost legs 3.0000 × 2 on each side; and the 0.0001.
    expect(rows).toHaveLength(8);
    const [sums] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ debit: string; credit: string }[]>`
        select sum(base_debit)::text as debit, sum(base_credit)::text as credit
          from app.ledger_entry where document_id = ${documentId}`,
    );
    expect(sums!.debit).toBe(sums!.credit);
  });

  it("a step-9a refusal reaches the caller as step 6's PostingError, naming the document", async () => {
    // An ill-formed policy the schema admits: the two legs of one cost pair tagged from DIFFERENT fill
    // sources, so the filled plan does not balance and step 9a refuses it.
    const skewed = {
      ...UNPAIRED,
      documentType: "SKEWED_ISSUE_TEST",
      lines: [
        {
          for: "each_line",
          side: "debit",
          account: { from: "item.cogs_account" },
          amount: "line.cost",
          when: { "line.kind": "item" },
        },
        {
          for: "each_line",
          side: "credit",
          account: { from: "item.inventory_account" },
          amount: "line.variance_value",
          when: { "line.kind": "item" },
        },
      ],
    };
    const typeId = await seedDocumentType(db, s, { code: "SKEWED_ISSUE_TEST", policy: skewed });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: typeId,
      series: "SKW",
      effectiveDate: "2026-01-11",
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "1.000000",
          unitPrice: "1.0000",
          amount: "1.0000",
        },
      ],
    });
    const refused = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }),
    ).then(
      () => null,
      (error: unknown) => error as Error & { code?: string },
    );
    expect(refused).not.toBeNull();
    expect(refused!.name).toBe("PostingError");
    expect(refused!.code).toBe("ERR_LEDGER_UNBALANCED");
    expect(refused!.message).toContain(`document ${documentId}: `);
  });
});

/**
 * Finding C4. `reverseDocument`'s full-reversal guard counted every `returns` target (and every document
 * pointing `reverses_document_id` at the original) unless it was VOID. A target that was itself REVERSED has
 * already released its claim — `app.document_open_quantity` excludes it — yet it blocked the original's
 * reversal for good, with no remedy.
 */
describe("C4 — a reversed return no longer blocks reversing the receipt it returned against", () => {
  let s: Seed;
  let partyId: string;
  let warehouseId: string;

  const loaderCtx = (seed: Seed, only: readonly SubPack[]) => ({
    config: {
      tenantId: seed.tenant,
      only,
      packRoot: PACK_ROOT,
      appEnv: "dev" as const,
      tenantName: "c4",
      ownerEmail: "owner@example.invalid",
      companyCode: "HQ",
      companyName: "c4 HQ",
      baseCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      fiscalYearStartMonth: 1,
      fiscalYear: 2026,
    },
    tenantId: seed.tenant,
    companyId: seed.company,
    systemPrincipalId: seed.system,
    packRoot: PACK_ROOT,
  });

  beforeAll(async () => {
    s = await seedTenantV2(db, "C4");
    // Older FIFO stock supplies the return chains, leaving the linked purchase untouched.
    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`update app.company set costing_method = 'fifo' where id = ${s.company}`,
    );
    await grantCodes(db, s, {
      codes: [
        "accounting.purchase.create",
        "accounting.purchase.post",
        "inventory.receipt.create",
        "inventory.receipt.post",
      ],
    });
    // chart-of-accounts before document-types and before `seedParty` (the vendor's 2100 resolves from it).
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      chartOfAccountsLoader.load(tx, loaderCtx(s, ["chart-of-accounts"])),
    );
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      documentTypesLoader.load(tx, loaderCtx(s, ["document-types"])),
    );
    partyId = await seedParty(db, s, { kind: "vendor", code: "C4-VEND" });
    warehouseId = await seedWarehouse(db, s, { code: "C4-WH" });
    // Every date below is in May, which `seedTenantV2` has no period for.
    await ensureOpenPeriods(db, s, 2026);
  }, 300_000);

  async function typeId(code: string): Promise<string> {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.document_type where company_id = ${s.company} and code = ${code}`,
    );
    return row!.id;
  }

  const reverse = (documentId: string, effectiveDate: string) =>
    withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctx(s), {
        documentId,
        effectiveDate,
        reason: "C4",
        jobs: recordingJobs(),
      }),
    );

  it("GOODS_RECEIPT 10 → PURCHASE_RETURN 3 → reverse the return → the untouched receipt reverses and older stock remains", async () => {
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "C4-ITEM", trackLots: false });
    const older = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("GOODS_RECEIPT"),
      series: "GRN",
      partyId,
      warehouseId,
      effectiveDate: "2026-05-01",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "3.000000",
          unitPrice: "12.0000",
          amount: "36.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: older.documentId, jobs: recordingJobs() }),
    );
    const receipt = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("GOODS_RECEIPT"),
      series: "GRN",
      partyId,
      warehouseId,
      effectiveDate: "2026-05-01",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "12.0000",
          amount: "120.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: receipt.documentId, jobs: recordingJobs() }),
    );
    const ret = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_RETURN"),
      series: "PR",
      partyId,
      warehouseId,
      effectiveDate: "2026-05-10",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "3.000000",
          unitPrice: "12.0000",
          amount: "36.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await linkFulfilment(tx, ctx(s), {
        sourceDocumentId: receipt.documentId,
        targetDocumentId: ret.documentId,
        linkKind: "returns",
        lines: [
          {
            sourceLineId: receipt.lineIds[0]!,
            targetLineId: ret.lineIds[0]!,
            quantity: "3.000000",
          },
        ],
      });
      await postDocument(tx, ctx(s), { documentId: ret.documentId, jobs: recordingJobs() });
    });

    // While the return stands, the guard holds: mirroring all ten on top of it would return three twice.
    await expect(reverse(receipt.documentId, "2026-05-11")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: .*already been partly credited or returned against/,
    );

    // Reverse the return: its three units come back and its claim on the receipt is released.
    await reverse(ret.documentId, "2026-05-12");
    const [released] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string; open: string }[]>`
        select d.status::text as status, oq.open_quantity::text as open
          from app.document d join app.document_open_quantity oq on oq.document_id = d.id
         where d.id = ${receipt.documentId}`,
    );
    expect(released).toEqual({ status: "posted", open: "10.000000" });

    // …so the receipt itself now reverses, and the stock it brought in goes back out.
    await reverse(receipt.documentId, "2026-05-13");
    const [after] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string; on_hand: string }[]>`
        select (select status::text from app.document where id = ${receipt.documentId}) as status,
               (select coalesce(sum(quantity), 0)::numeric(19,6)::text from app.stock_on_hand
                 where company_id = ${s.company} and item_id = ${itemId}) as on_hand`,
    );
    expect(after).toEqual({ status: "reversed", on_hand: "3.000000" });
  });

  // Code review 2 (F1). C4's fix counted every REVERSED target as released, but a reversal chain releases its
  // claim only while it NETS: reversing the return's reversal (depth 2 — 0048's "an ordinary live document of
  // its kind") takes the three units out again while the original return still reads 'reversed'. The guard
  // must see that live even-depth member and refuse, or the receipt's reversal takes those units out twice.
  // Reversing the reinstated return once more (depth 3) nets the chain again and releases it.
  it("… but a reinstated return (the reversal of its reversal) blocks again until its chain nets", async () => {
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "C4-ITEM-2", trackLots: false });
    const line = (quantity: string, amount: string) => ({
      kind: "item" as const,
      itemId,
      unitId: baseUnitId,
      warehouseId,
      quantity,
      unitPrice: "12.0000",
      amount,
    });
    const receive = async (quantity: string, amount: string, effectiveDate: string) => {
      const doc = await draftTypedDocument(db, s, {
        documentTypeId: await typeId("GOODS_RECEIPT"),
        series: "GRN",
        partyId,
        warehouseId,
        effectiveDate,
        lines: [line(quantity, amount)],
      });
      await withTenant(db.rw, s.tenant, s.human, (tx) =>
        postDocument(tx, ctx(s), { documentId: doc.documentId, jobs: recordingJobs() }),
      );
      return doc;
    };
    // GR1 is the receipt the return is against; GR2 keeps stock positive throughout, so no negative-stock
    // refusal can stand in for the guard's.
    await receive("10.000000", "120.0000", "2026-06-01");
    const gr1 = await receive("10.000000", "120.0000", "2026-06-01");
    const ret = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_RETURN"),
      series: "PR",
      partyId,
      warehouseId,
      effectiveDate: "2026-06-10",
      lines: [line("3.000000", "36.0000")],
    });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await linkFulfilment(tx, ctx(s), {
        sourceDocumentId: gr1.documentId,
        targetDocumentId: ret.documentId,
        linkKind: "returns",
        lines: [
          { sourceLineId: gr1.lineIds[0]!, targetLineId: ret.lineIds[0]!, quantity: "3.000000" },
        ],
      });
      await postDocument(tx, ctx(s), { documentId: ret.documentId, jobs: recordingJobs() });
    });
    const onHand = async () => {
      const [row] = await withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ on_hand: string; gr1: string }[]>`
          select (select coalesce(sum(quantity), 0)::numeric(19,6)::text from app.stock_on_hand
                   where company_id = ${s.company} and item_id = ${itemId}) as on_hand,
                 (select status::text from app.document where id = ${gr1.documentId}) as gr1`,
      );
      return row;
    };
    expect(await onHand()).toEqual({ on_hand: "17.000000", gr1: "posted" });

    // R1 (depth 1) nets the return; R2 (depth 2) reinstates it — the three units go back to the vendor.
    const r1 = await reverse(ret.documentId, "2026-06-11");
    const r2 = await reverse(r1.reversalDocumentId, "2026-06-12");
    const [chain] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ ret: string; r1: string; r2: string; depth: number }[]>`
        select (select status::text from app.document where id = ${ret.documentId}) as ret,
               (select status::text from app.document where id = ${r1.reversalDocumentId}) as r1,
               (select status::text from app.document where id = ${r2.reversalDocumentId}) as r2,
               app.document_reversal_depth(${r2.reversalDocumentId}) as depth`,
    );
    expect(chain).toEqual({ ret: "reversed", r1: "reversed", r2: "posted", depth: 2 });
    expect(await onHand()).toEqual({ on_hand: "17.000000", gr1: "posted" });

    // The reinstated return still stands against GR1, so GR1's full reversal is refused and nothing moves.
    await expect(reverse(gr1.documentId, "2026-06-13")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: .*already been partly credited or returned against/,
    );
    expect(await onHand()).toEqual({ on_hand: "17.000000", gr1: "posted" });

    // R3 (depth 3) nets the chain again; GR1's claim is released and its ten units go back out.
    await reverse(r2.reversalDocumentId, "2026-06-14");
    expect(await onHand()).toEqual({ on_hand: "20.000000", gr1: "posted" });
    await reverse(gr1.documentId, "2026-06-15");
    expect(await onHand()).toEqual({ on_hand: "10.000000", gr1: "reversed" });
  });
});
