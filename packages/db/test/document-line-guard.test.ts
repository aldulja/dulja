// packages/db/test/document-line-guard.test.ts — code review 2 (Phase 4), finding P1: app.document_line is
// frozen once its document leaves draft (migration 0113). spec:574 (LEGACY-041) "issued financial documents are
// immutable"; spec:501, 2223 (LEGACY-031) "the whole document aggregate (header + lines + projections)";
// spec:2049 "Financial rows: never — reversal only"; spec:2173 the data layer is the control. Every case runs
// as `app_rw` inside `withTenant`, the role every route and job writes through, so a refusal here is a
// refusal for every path. Each red case fails on e8df83b, where 0023 guarded DELETE only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { issueDocument, postDocument, reverseDocument, transitionDocument } from "../src/posting";
import { withTenant, type TenantContext } from "../src/with-tenant";
import { recordCounts, snapshotCountSheet } from "../src/inventory/count";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "./index";
import {
  arApFixture,
  postFromPack,
  seedTypeFromPack,
  type ArApFixture,
} from "../../../tests/invariants/support/ar-ap";
import { recordingJobs, secondPrincipal } from "../../../tests/invariants/support/post-inventory";

let db: Db;
let s: Seed;
let f: ArApFixture;
let checker: string;

const ctxOf = async (actorId: string): Promise<TenantContext> => ({
  tenantId: s.tenant,
  actorId,
  requestId: await uuidv7(db.admin),
});

/** ONE production transaction as `actor` (the maker, `s.human`, by default). */
const as = async <T>(
  fn: (tx: Sql, c: TenantContext) => Promise<T>,
  actor: string = s.human,
): Promise<T> => {
  const c = await ctxOf(actor);
  return withTenant(db.rw, c, (tx) => fn(tx, c));
};

/** A POSTED SALES_INVOICE of 100.0000 on one account line to 4000, through the generic insert → issue → post. */
const postedSale = async (): Promise<{ documentId: string; lineId: string }> => {
  const { documentId } = await postFromPack(db, s, {
    code: "SALES_INVOICE",
    effectiveDate: "2026-01-10",
    partyId: f.partyIds.customer,
    lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "100.0000" }],
  });
  const [line] = await db.admin<{ id: string }[]>`
    select id from app.document_line where document_id = ${documentId} and line_no = 1`;
  return { documentId, lineId: line!.id };
};

/** A DRAFT SALES_INVOICE of `amount`, with the derived total and the rate provenance a drafting service writes. */
const draftSale = async (amount: string): Promise<{ documentId: string; lineId: string }> => {
  const { documentId, lineIds } = await draftTypedDocument(db, s, {
    documentTypeId: f.documentTypeIds["SALES_INVOICE"]!,
    series: "INV",
    effectiveDate: "2026-01-10",
    partyId: f.partyIds.customer,
    lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount }],
  });
  await as(async (tx) => {
    await tx`update app.document_line set total_incl_tax = ${amount} where id = ${lineIds[0]!}`;
    await tx`update app.document set rate_source = 'unit' where id = ${documentId}`;
  });
  return { documentId, lineId: lineIds[0]! };
};

const ledgerOf = (documentId: string) =>
  db.admin<{ code: string; debit: string; credit: string }[]>`
    select a.code, e.debit::text as debit, e.credit::text as credit
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = ${documentId}
     order by a.code`;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "line-guard");
  f = await arApFixture(db, s);
  checker = await secondPrincipal(db, s, "line-guard-checker");
  await grantCodes(db, s, {
    codes: ["accounting.payment.approve", "accounting.payment.post"],
    principalId: checker,
    roleCode: "line-guard-checker",
  });
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("P1 — a document's lines are frozen once it leaves draft (0113, LEGACY-041, LEGACY-031)", () => {
  it("a POSTED line's amount, total, description and account cannot be rewritten", async () => {
    const { documentId, lineId } = await postedSale();
    await expect(
      as(
        (tx) => tx`
          update app.document_line
             set amount = 1000.0000, total_incl_tax = 1000.0000, description = 'tampered',
                 account_id = ${f.accountIds["5900"]!}
           where id = ${lineId}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is posted; its line 1 cannot be changed/);
    const [line] = await db.admin<{ amount: string; account_id: string }[]>`
      select amount::text as amount, account_id from app.document_line where id = ${lineId}`;
    expect(line).toEqual({ amount: "100.0000", account_id: f.accountIds["4000"]! });
    expect(await ledgerOf(documentId)).toEqual([
      { code: "1200", debit: "100.0000", credit: "0.0000" },
      { code: "4000", debit: "0.0000", credit: "100.0000" },
    ]);
    // Not only the money: a column no one would think to list is frozen too, because the guard compares rows.
    await expect(
      as(
        (tx) =>
          tx`update app.document_line set custom_fields = '{"x":1}'::jsonb where id = ${lineId}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  });

  it("a reversal after a refused tamper mirrors the ledger that posted, not a rewritten line", async () => {
    const { documentId, lineId } = await postedSale();
    await expect(
      as(
        (tx) =>
          tx`update app.document_line set amount = 1000.0000, total_incl_tax = 1000.0000 where id = ${lineId}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    const { reversalDocumentId } = await as((tx, c) =>
      reverseDocument(tx, c, { documentId, effectiveDate: "2026-01-11", reason: "line-guard" }),
    );
    expect(await ledgerOf(reversalDocumentId)).toEqual([
      { code: "1200", debit: "0.0000", credit: "100.0000" },
      { code: "4000", debit: "100.0000", credit: "0.0000" },
    ]);
  });

  it("an ISSUED, not yet posted, line cannot be rewritten either", async () => {
    const { documentId, lineId } = await draftSale("40.0000");
    await as((tx, c) => issueDocument(tx, c, { documentId }));
    await expect(
      as(
        (tx) =>
          tx`update app.document_line set amount = 4000.0000, total_incl_tax = 4000.0000 where id = ${lineId}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is issued/);
  });

  it("maker ≠ checker holds: the maker cannot re-key an APPROVED payment, and the post books what was approved", async () => {
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId: f.documentTypeIds["PAYMENT"]!,
      series: "PAY-OUT",
      effectiveDate: "2026-01-12",
      partyId: f.partyIds.vendor,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount: "300.0000" }],
    });
    await as(async (tx) => {
      await tx`update app.document_line set total_incl_tax = 300.0000 where id = ${lineIds[0]!}`;
      await tx`update app.document set rate_source = 'unit' where id = ${documentId}`;
    });
    await as((tx, c) => transitionDocument(tx, c, { documentId, to: "submitted" }));
    await as((tx, c) => transitionDocument(tx, c, { documentId, to: "approved" }), checker);

    await expect(
      as(
        (tx) => tx`
          update app.document_line set amount = 3000.0000, total_incl_tax = 3000.0000
           where id = ${lineIds[0]!}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is approved/);

    await as(async (tx, c) => {
      await issueDocument(tx, c, { documentId });
      await postDocument(tx, c, { documentId });
    }, checker);
    expect(await ledgerOf(documentId)).toEqual([
      { code: "1100", debit: "0.0000", credit: "300.0000" },
      { code: "2100", debit: "300.0000", credit: "0.0000" },
    ]);
  });

  it("no line can be ADDED to a posted document", async () => {
    const { documentId } = await postedSale();
    await expect(
      as(
        (tx) => tx`
          insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, amount, total_incl_tax)
          values (${s.tenant}, ${s.company}, ${documentId}, 2, 'account', ${f.accountIds["4000"]!}, 5.0000, 5.0000)`,
      ),
    ).rejects.toThrow(
      /ERR_DOC_NOT_DRAFT: document .* is posted; a line can be added only to a draft/,
    );
  });

  it("a draft line cannot be moved onto a posted document", async () => {
    const posted = await postedSale();
    const draft = await draftSale("7.0000");
    await expect(
      as(
        (tx) => tx`
          update app.document_line set document_id = ${posted.documentId}, line_no = 9
           where id = ${draft.lineId}`,
      ),
    ).rejects.toThrow(
      /ERR_DOC_NOT_DRAFT: a line moves from document .* \(draft\) to document .* \(posted\)/,
    );
  });

  it("cost is written only at the statuses its writers run: refused at submitted", async () => {
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId: f.documentTypeIds["PAYMENT"]!,
      series: "PAY-OUT",
      effectiveDate: "2026-01-12",
      partyId: f.partyIds.vendor,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount: "30.0000" }],
    });
    await as((tx, c) => transitionDocument(tx, c, { documentId, to: "submitted" }));
    await expect(
      as((tx) => tx`update app.document_line set cost = 1.0000 where id = ${lineIds[0]!}`),
    ).rejects.toThrow(
      /ERR_DOC_NOT_DRAFT: document .* is submitted; document_line.cost is written only/,
    );
  });

  it("control: the cost replay's write — cost alone, on a POSTED line — is still admitted", async () => {
    const { lineId } = await postedSale();
    await as((tx) => tx`update app.document_line set cost = 12.5000 where id = ${lineId}`);
    const [line] = await db.admin<{ cost: string }[]>`
      select cost::text as cost from app.document_line where id = ${lineId}`;
    expect(line!.cost).toBe("12.5000");
  });

  it("control: a draft's lines stay freely editable, and a draft's line can be deleted", async () => {
    const { documentId, lineId } = await draftSale("8.0000");
    await as(
      (tx) =>
        tx`update app.document_line set amount = 9.0000, total_incl_tax = 9.0000 where id = ${lineId}`,
    );
    await as(
      (tx) => tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, amount, total_incl_tax)
        values (${s.tenant}, ${s.company}, ${documentId}, 2, 'account', ${f.accountIds["4000"]!}, 1.0000, 1.0000)`,
    );
    await as(
      (tx) => tx`delete from app.document_line where document_id = ${documentId} and line_no = 2`,
    );
    const rows = await db.admin<{ amount: string }[]>`
      select amount::text as amount from app.document_line where document_id = ${documentId} order by line_no`;
    expect(rows).toEqual([{ amount: "9.0000" }]);
  });
});

describe("code review 3, R2 — an ISSUED line's cost is written only inside the posting transaction (0113)", () => {
  let countType: string;
  let countChecker: string;
  beforeAll(async () => {
    // The seed pack's STOCK_COUNT under R1: the maker drafts, counts and submits; a second principal
    // approves, issues and posts.
    await seedAccount(db, s, { code: "5110", nameEn: "Stock-count variance", type: "expense" });
    countType = await seedTypeFromPack(db, s, "STOCK_COUNT");
    await grantCodes(db, s, { codes: ["inventory.count.create"] });
    countChecker = await secondPrincipal(db, s, "line-guard-count-checker");
    await grantCodes(db, s, {
      codes: ["inventory.adjustment.approve"],
      principalId: countChecker,
      roleCode: "line-guard-count-checker",
    });
  }, 120_000);

  /**
   * 10 on hand at 3.0000, through the seed pack's GOODS_RECEIPT, on an item and warehouse of their own, and a
   * STOCK_COUNT sheet of them counted at 12 by the maker and left in draft: a surplus of 2 whose layer
   * average is 3.0000, so 6.0000.
   */
  const countedSurplus = async (
    tag: string,
  ): Promise<{ documentId: string; lineId: string; receiptId: string }> => {
    const vendor = await seedParty(db, s, { kind: "vendor", code: `${tag}-VEND` });
    const { itemId, baseUnitId: unitId } = await seedItem(db, s, {
      code: `${tag}-ITEM`,
      trackLots: false,
    });
    const warehouseId = await seedWarehouse(db, s, { code: `${tag}-WH` });
    const { documentId: receiptId } = await postFromPack(db, s, {
      code: "GOODS_RECEIPT",
      effectiveDate: "2026-01-05",
      partyId: vendor,
      warehouseId,
      jobs: recordingJobs(),
      lines: [
        {
          kind: "item",
          itemId,
          unitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "3.0000",
          amount: "30.0000",
        },
      ],
    });
    const sheet = await as((tx, c) =>
      snapshotCountSheet(tx, c, {
        documentTypeId: countType,
        series: "SC",
        effectiveDate: "2026-01-20",
        warehouseId,
        itemIds: [itemId],
      }),
    );
    const documentId = sheet.documentId;
    const lineId = sheet.lines[0]!.documentLineId;
    await as((tx, c) =>
      recordCounts(tx, c, {
        documentId,
        counts: [{ documentLineId: lineId, countedQuantity: "12.000000" }],
      }),
    );
    return { documentId, lineId, receiptId };
  };

  /** The maker submits; the checker approves and issues. */
  const submitApproveIssue = async (documentId: string): Promise<void> => {
    await as((tx, c) => transitionDocument(tx, c, { documentId, to: "submitted" }));
    await as(async (tx, c) => {
      await transitionDocument(tx, c, { documentId, to: "approved" });
      await issueDocument(tx, c, { documentId });
    }, countChecker);
  };

  /** The checker's post, and what it booked: the surplus of 2 at the layer average, 6.0000. */
  const expectPostedAtLayerAverage = async (documentId: string, lineId: string): Promise<void> => {
    await as((tx, c) => postDocument(tx, c, { documentId, jobs: recordingJobs() }), countChecker);
    expect(await ledgerOf(documentId)).toEqual([
      { code: "1300", debit: "6.0000", credit: "0.0000" },
      { code: "5110", debit: "0.0000", credit: "6.0000" },
    ]);
    const movements = await db.admin<{ quantity: string; value: string }[]>`
      select quantity::text as quantity, value::text as value
        from app.inventory_movement where document_id = ${documentId}`;
    expect(movements).toEqual([{ quantity: "2.000000", value: "6.0000" }]);
    const [line] = await db.admin<{ cost: string }[]>`
      select cost::text as cost from app.document_line where id = ${lineId}`;
    expect(line!.cost).toBe("6.0000");
  };

  it("the maker cannot re-key an approved, issued STOCK_COUNT surplus, and the checker's post values it at the layer average", async () => {
    const { documentId, lineId } = await countedSurplus("R2");
    await submitApproveIssue(documentId);

    // The maker's write, in a transaction of its own, on the approved and issued line: refused.
    await expect(
      as((tx) => tx`update app.document_line set cost = 5000.0000 where id = ${lineId}`),
    ).rejects.toThrow(
      /ERR_DOC_NOT_DRAFT: document .* is issued; document_line.cost is written at issued only inside the posting transaction/,
    );
    // …and not opened by forging step 8's mark first: the line has no movement until step 9 inserts it.
    await expect(
      as(async (tx) => {
        await tx`update app.document set posting_seq = nextval('app.posting_seq') where id = ${documentId}`;
        await tx`update app.document_line set cost = 5000.0000 where id = ${lineId}`;
      }),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);

    // The checker's post values the surplus of 2 at the layer average, 3.0000: 6.0000, not the maker's figure.
    await expectPostedAtLayerAverage(documentId, lineId);
  });

  it("a cost the maker writes on the counted line while it is still a DRAFT does not price the checker's post either", async () => {
    // One status earlier than the case above, where 0113 admits every change: the maker, as `app_rw`, sets
    // `cost` on the counted line before submitting it. `cost` is not writable through the API
    // (packages/contracts/src/accounting/document.ts), so this is the raw session the brief's evidence uses.
    // Before this fix applyMovements' receipt-value branch 1 (`line.cost` set → the layer's value) ran ahead
    // of branch 2b and the checker's post booked 1300 Dr 5000.0000 / 5110 Cr 5000.0000 for a 2-unit surplus.
    const { documentId, lineId } = await countedSurplus("R2D");
    await as((tx) => tx`update app.document_line set cost = 5000.0000 where id = ${lineId}`);
    await submitApproveIssue(documentId);
    await expectPostedAtLayerAverage(documentId, lineId);
  });

  // The case above holds only while the line stays COUNTED, and at draft the maker owns every column of the
  // line, the two count columns included. Clearing either one in the same UPDATE that writes `cost` (or
  // `amount`) turned the line into an uncounted receipt: applyMovements priced it by branch 1 (or branch 3)
  // from the maker's figure, and readCountSheet (`where expected_quantity is not null`) stopped showing it to
  // the checker. Red before the fix: each post below booked 1300 Dr 5000.0000 / 5110 Cr 5000.0000.

  /** The checker's post is refused before step 7, and nothing is booked: no ledger, no movement, no cost. */
  const expectPostRefused = async (documentId: string, lineId: string): Promise<void> => {
    await expect(
      as((tx, c) => postDocument(tx, c, { documentId, jobs: recordingJobs() }), countChecker),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 1: an approval-required STOCK_COUNT line .* must carry both count columns/,
    );
    expect(await ledgerOf(documentId)).toEqual([]);
    const movements = await db.admin`
      select 1 from app.inventory_movement where document_id = ${documentId}`;
    expect(movements).toHaveLength(0);
    const [doc] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${documentId}`;
    expect(doc!.status).toBe("issued");
    const [line] = await db.admin<{ cost: string }[]>`
      select cost::text as cost from app.document_line where id = ${lineId}`;
    expect(line!.cost).toBe("5000.0000");
  };

  it("a maker who clears expected_quantity at DRAFT while writing cost cannot have the checker post it", async () => {
    const { documentId, lineId } = await countedSurplus("R2E");
    await as(
      (tx) =>
        tx`update app.document_line set expected_quantity = null, cost = 5000.0000 where id = ${lineId}`,
    );
    await submitApproveIssue(documentId);
    await expectPostRefused(documentId, lineId);
  });

  it("a maker who clears counted_quantity at DRAFT while writing cost cannot have the checker post it", async () => {
    const { documentId, lineId } = await countedSurplus("R2C");
    await as(
      (tx) =>
        tx`update app.document_line set counted_quantity = null, cost = 5000.0000 where id = ${lineId}`,
    );
    await submitApproveIssue(documentId);
    await expectPostRefused(documentId, lineId);
  });

  it("clearing a count column and writing amount instead (branch 3's input) is refused the same way", async () => {
    const { documentId, lineId } = await countedSurplus("R2A");
    await as(
      (tx) =>
        tx`update app.document_line set expected_quantity = null, amount = 5000.0000 where id = ${lineId}`,
    );
    await submitApproveIssue(documentId);
    await expect(
      as((tx, c) => postDocument(tx, c, { documentId, jobs: recordingJobs() }), countChecker),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 1: an approval-required STOCK_COUNT line .* must carry both count columns/,
    );
    expect(await ledgerOf(documentId)).toEqual([]);
  });

  it("a reversal pointer the maker writes on the draft's header does not exempt the uncounted line", async () => {
    // A reversal mirror is the one legitimate writer of a pre-set cost (reverse.ts copies it and not the
    // count columns), but `reverses_document_id` is a draft column like any other, and no approval-required
    // type's mirror can post (reverseDocument posts it at once; §4.5.1 forbids draft → issued under approval).
    const { documentId, lineId, receiptId } = await countedSurplus("R2P");
    await as(async (tx) => {
      await tx`update app.document set reverses_document_id = ${receiptId} where id = ${documentId}`;
      await tx`update app.document_line set expected_quantity = null, cost = 5000.0000 where id = ${lineId}`;
    });
    await submitApproveIssue(documentId);
    await expectPostRefused(documentId, lineId);
  });
});
