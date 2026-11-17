import { describe, expect, it } from "vitest";
import { linkFulfilment, openQuantity, withTenant } from "@dulja/db";
import {
  draftTypedDocument,
  grantCodes,
  seedItem,
  seedParty,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { repoFile, sharedDb } from "../support/regression";
import { costingContext, type CostingFixture } from "./support/costing";

const ctx = costingContext("017"); // ← this file's own LEGACY number

describe("LEGACY-017 Delivery tracking double-added on edit and never reversed on re-pointing — 3B", () => {
  // first proven by spec:361, spec:1204
  it("every quantity aggregate in this slice is a SUM over append-only rows, never an incremental +=", async () => {
    const files = await ctx.sourceFiles(["packages/db/src/costing"]);
    for (const f of files) {
      // No statement adds a delta to a stored quantity; the two that write one write a computed total.
      expect(f.text).not.toMatch(/set\s+qty_remaining\s*=\s*qty_remaining\s*[+-]/);
    }
  });
});

/** This file's 3C context. Module scope, not inside the `describe`: it captures nothing from that closure
 *  and `unicorn/consistent-function-scoping` refuses the inner form (the same reason `costing.ts` gives). */
const ctxOf = (s: { tenant: string; human: string }) => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: "legacy-017-3c",
});

/** An ISSUED 10-unit order of its own item, drafted and issued through the data layer. */
async function issuedOrderOf(
  f: CostingFixture,
  code: string,
): Promise<{
  documentId: string;
  lineId: string;
  itemId: string;
  baseUnitId: string;
  partyId: string;
}> {
  const { db, s } = f;
  await grantCodes(db, s, {
    codes: ["accounting.purchase.create", "inventory.receipt.create", "inventory.receipt.post"],
  });
  const partyId = await seedParty(db, s, { kind: "vendor", code: `${code}-VEND` });
  const { itemId, baseUnitId } = await seedItem(db, s, { code: `${code}-ITEM` });
  const [orderType] = await withTenant(
    db.rw,
    ctxOf(s),
    (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = 'PURCHASE_ORDER'`,
  );
  const order = await draftTypedDocument(db, s, {
    documentTypeId: orderType!.id,
    series: "PO",
    partyId,
    lines: [
      {
        kind: "item",
        itemId,
        unitId: baseUnitId,
        quantity: "10.000000",
        unitPrice: "1.0000",
        amount: "10.0000",
      },
    ],
  });
  // Straight to `issued` with an UPDATE rather than through `transitionDocument`: this file is asserting
  // the link invariant, and an order's numbering path is Task 5's subject, tested there.
  await withTenant(
    db.rw,
    ctxOf(s),
    (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`,
  );
  return { documentId: order.documentId, lineId: order.lineIds[0]!, itemId, baseUnitId, partyId };
}

/** A DRAFT 10-unit goods receipt of the same item, ready to be linked at any of the orders above. */
async function draftReceipt(
  f: CostingFixture,
  o: { itemId: string; baseUnitId: string; partyId: string },
): Promise<{ documentId: string; lineId: string }> {
  const { db, s, warehouse } = f;
  const [receiptType] = await withTenant(
    db.rw,
    ctxOf(s),
    (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = 'GOODS_RECEIPT'`,
  );
  const receipt = await draftTypedDocument(db, s, {
    documentTypeId: receiptType!.id,
    series: "GRN",
    partyId: o.partyId,
    warehouseId: warehouse,
    lines: [
      {
        kind: "item",
        itemId: o.itemId,
        unitId: o.baseUnitId,
        warehouseId: warehouse,
        quantity: "10.000000",
      },
    ],
  });
  return { documentId: receipt.documentId, lineId: receipt.lineIds[0]! };
}

/** `open_quantity` of one order line, as text. */
async function openOf(db: Db, s: Seed, orderDocumentId: string): Promise<string> {
  const rows = await withTenant(db.rw, ctxOf(s), (tx) => openQuantity(tx, orderDocumentId));
  return rows[0]!.openQuantity;
}

/** Link `quantity` of a draft receipt against one order line. */
async function linkTo(
  db: Db,
  s: Seed,
  order: { documentId: string; lineId: string },
  receipt: { documentId: string; lineId: string },
  quantity: string,
): Promise<void> {
  await withTenant(db.rw, ctxOf(s), (tx) =>
    linkFulfilment(tx, ctxOf(s), {
      sourceDocumentId: order.documentId,
      targetDocumentId: receipt.documentId,
      linkKind: "receives_against",
      lines: [{ sourceLineId: order.lineId, targetLineId: receipt.lineId, quantity }],
    }),
  );
}

describe("LEGACY-017 — 3C: open quantity is a view over links, and there is no counter to double-add", () => {
  it("no table in the schema carries a fulfilled, delivered or received quantity column", async () => {
    const { db } = await ctx.inventory();
    const columns = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app'
         and (column_name like '%fulfilled%' or column_name like '%delivered_quantity%'
              or column_name like '%received_quantity%' or column_name like '%returned_quantity%')
       order by 1, 2`;
    expect(columns).toEqual([]);
    // …and the one place the figure exists is a VIEW, so it cannot be written to at all.
    const [kind] = await db.admin<{ relkind: string }[]>`
      select relkind::text as relkind from pg_class where oid = 'app.document_open_quantity'::regclass`;
    expect(kind!.relkind).toBe("v");
    // The EXACT grant list. Plan 0A's default privileges (plan0A:2564) cover views too, so this passes only
    // because migration 0037 issues `revoke insert, update on app.document_open_quantity from app_rw`.
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'document_open_quantity' order by 1`;
    expect(grants.map((g) => g.privilege_type)).toEqual(["SELECT"]);
  });

  it("the guard takes an advisory lock on the source line BEFORE it sums, so the sum cannot be stale", async () => {
    const { db } = await ctx.inventory();
    // Structural, and deliberately so: an interleaved two-transaction race is not deterministically
    // reproducible in a test (you cannot await "the other transaction is now blocked"), while the ORDER of
    // the two statements inside the trigger is exactly what closes the window. This is the shape 3B uses for
    // legacy-010, which asserts an ordering clause rather than trying to provoke the wrong answer.
    const [fn] = await db.admin<{ def: string }[]>`
      select pg_get_functiondef('app.assert_document_link_within_open_quantity()'::regprocedure) as def`;
    const def = fn!.def;
    const lockAt = def.indexOf("pg_advisory_xact_lock");
    // 0127 (ADR 0095): the sum is the company-wide lookup the guard calls after the lock; the lookup sums.
    const sumAt = def.indexOf("source_line_linked_quantity");
    const [lookup] = await db.admin<{ def: string }[]>`
      select pg_get_functiondef('app.source_line_linked_quantity(uuid, uuid, uuid)'::regprocedure) as def`;
    expect(lookup!.def).toContain("sum(x.quantity)");
    expect(lockAt).toBeGreaterThan(-1);
    expect(sumAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(sumAt);
    // The key is the SOURCE LINE, which is what the sum is over. A lock on the document, or on the tenant,
    // would either be too coarse (serialising unrelated lines) or too narrow to protect the sum.
    expect(def).toContain("'document_link:' || new.source_line_id::text");
  });

  it("a second transaction linking against the same line reads the FIRST one's committed sum and is refused", async () => {
    const f = await ctx.inventory();
    const order = await issuedOrderOf(f, "LEGACY017A");
    const r1 = await draftReceipt(f, order);
    const r2 = await draftReceipt(f, order);

    await linkTo(f.db, f.s, order, r1, "6.000000");
    // 6 + 6 = 12 against 10 ordered. The second transaction is a separate `withTenant`, so it sees the
    // first's COMMITTED row — which is the property the advisory lock guarantees for the interleaved case
    // too, because at READ COMMITTED the post-lock read takes a fresh snapshot (3a:68).
    await expect(linkTo(f.db, f.s, order, r2, "6.000000")).rejects.toThrow(
      /ERR_DOC_LINK_OVER_FULFILLED/,
    );
    expect(await openOf(f.db, f.s, order.documentId)).toBe("4.000000");
  });

  it("re-pointing a fulfilment releases the first order's quantity with no compensating write", async () => {
    const f = await ctx.inventory();
    // Two orders for the same item; one draft receipt linked to the first, then deleted and linked to the
    // second. In the legacy system the first order's counter stayed incremented forever.
    const first = await issuedOrderOf(f, "LEGACY017B");
    const second = await issuedOrderOf(f, "LEGACY017C");
    const receipt = await draftReceipt(f, first);

    await linkTo(f.db, f.s, first, receipt, "10.000000");
    expect(await openOf(f.db, f.s, first.documentId)).toBe("0.000000");

    await withTenant(
      f.db.rw,
      ctxOf(f.s),
      (tx) => tx`delete from app.document where id = ${receipt.documentId}`,
    );
    expect(await openOf(f.db, f.s, first.documentId)).toBe("10.000000"); // released, by deletion alone

    const again = await draftReceipt(f, second);
    await linkTo(f.db, f.s, second, again, "10.000000");
    expect(await openOf(f.db, f.s, second.documentId)).toBe("0.000000");
    expect(await openOf(f.db, f.s, first.documentId)).toBe("10.000000"); // and never re-decremented
  });
});

/**
 * 3B created this file and 3C appended to it; this is the third block and it edits neither. A plain
 * `describe` beside the existing blocks — **not** a `thinRegression` call: that wrapper runs its body inside
 * a single `it` (0b:5317-5326), which is a nested-test error. This block needs no database at all, so it
 * destructures nothing from `sharedDb()`; the walk is `ctx.sourceFiles`, the same accessor the 3B block
 * above uses, so no second import of the walker enters this file.
 */
describe("LEGACY-017 Open quantity defined once — 3D", () => {
  it("the SALES_ORDER side reads the same view the PURCHASE_ORDER side does", async () => {
    // One definition serves both directions: exactly one file in `packages/db/src` READS the view, and no
    // file computes open quantity a second way. 3D's `convertOrderToDelivery` returns the remaining
    // quantity, and it gets it by CALLING 3C's `openQuantity` — it does not re-select the view.
    //
    // The predicate is the `from` clause and NOT `/open_quantity/`, deliberately. 3C ships a second file
    // whose text contains the column name — `packages/db/src/schema/document-open-quantity.ts`, the Drizzle
    // mirror `pgView("document_open_quantity", { … openQuantity: numeric("open_quantity", …) }).existing()`
    // (3c:975-989). That mirror is a **declaration of the migration's view, not a second definition**, and
    // `.existing()` means Drizzle never emits DDL for it. A future slice must not delete it to make this
    // test pass — narrow the predicate instead, exactly as this line does.
    const files = await ctx.sourceFiles(["packages/db/src"]);
    const readers = files.filter((f) => /from app\.document_open_quantity/.test(f.text));
    expect(readers.map((f) => f.path).toSorted()).toEqual(["packages/db/src/documents/link.ts"]);
    // …and nothing anywhere re-derives it. The view's own expression is `ordered_quantity − coalesce(Σ
    // link.quantity, 0)`; that shape appearing in `src` at all would be the second definition LEGACY-017 names.
    const rederivers = files.filter((f) => /ordered_quantity\s*-\s*coalesce\(/.test(f.text));
    expect(rederivers.map((f) => f.path)).toEqual([]);
  });
});

/**
 * 4A — the fourth block; it edits none of the three above. The same defect shape in the clearing corridors:
 * the legacy system ADDED where it should have subtracted, in one of three inconsistent branches. A plain
 * `describe`, for the reason the 3D block gives.
 */
describe("LEGACY-017 A reversal relieves what it posted, and never adds to it — 4A", () => {
  it("the two cost amount references are resolved through ONE function, with the sign from the quantity", () => {
    const src = repoFile("packages/domain/src/posting/evaluate.ts");
    // The legacy defect was `X = X + old + new` — adding where it should have subtracted, in one of three
    // inconsistent branches. The structural fix is that there is exactly ONE place a cost becomes a signed
    // amount, and it reads the quantity rather than the caller's intent (ADR 0045).
    expect(src).toMatch(/function resolveCostAmount/);
    expect((src.match(/resolveCostAmount\(/g) ?? []).length).toBeGreaterThanOrEqual(2); // declaration + one call site
    expect(src).toMatch(/line\.quantity !== null && line\.quantity\.isNegative\(\)/);
  });

  it("delivered and returned quantity are PROJECTIONS of document_link, never stored counters", async () => {
    const { db } = await sharedDb();
    // LEGACY-017's root cause was a maintained counter (`OdtTransferredBonus`) updated by three triggers.
    // Here the figure is a view over the links, so there is nothing to double-add and nothing to forget.
    const [v] = await db.admin<{ kind: string }[]>`
      select c.relkind::text as kind from pg_class c
       where c.relname = 'document_open_quantity' and c.relnamespace = 'app'::regnamespace`;
    expect(v!.kind).toBe("v");
  });
});

// ─── code review 3 (R9, migration 0116) ──────────────────────────────────────────────────────────────────
// Appended; it edits none of the blocks above. The bound, by the reversal chain: a reversed return releases its
// claim on the receipt only while its chain NETS, and a claim that comes back — the return's reversal reversed
// — is bounded exactly as a new link is, so a receipt never carries more returned than it received. The races
// and the view's rollback are in `packages/db/test/open-quantity-reversal-chain.test.ts`.
import { postDocument, reverseDocument } from "@dulja/db";
import { seedTenantV2, seedWarehouse, uuidv7 } from "@dulja/db/test";
import { arApFixture, seedTypeFromPack } from "../invariants/support/ar-ap";
import { recordingJobs } from "../invariants/support/post-inventory";

describe("LEGACY-017 The over-fulfilment bound follows the reversal chain — code review 3", () => {
  it("a return's claim comes back with the reversal of its reversal, and is refused once it no longer fits", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "LEGACY017-CR3");
    const f = await arApFixture(db, s);
    const receiptType = await seedTypeFromPack(db, s, "GOODS_RECEIPT");
    const returnType = await seedTypeFromPack(db, s, "PURCHASE_RETURN");
    const { itemId, baseUnitId } = await seedItem(db, s, {
      code: "LEGACY017-CR3",
      trackLots: false,
    });
    const warehouseId = await seedWarehouse(db, s, { code: "LEGACY017-CR3" });
    const c = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const drafted = (
      documentTypeId: string,
      series: string,
      quantity: string,
      amount: string,
      effectiveDate: string,
    ) =>
      draftTypedDocument(db, s, {
        documentTypeId,
        series,
        partyId: f.partyIds.vendor,
        warehouseId,
        effectiveDate,
        lines: [
          {
            kind: "item",
            itemId,
            unitId: baseUnitId,
            warehouseId,
            quantity,
            unitPrice: "12.0000",
            amount,
          },
        ],
      });
    const post = (documentId: string) =>
      withTenant(db.rw, c, (tx) => postDocument(tx, c, { documentId, jobs: recordingJobs() }));
    const reverse = (documentId: string, effectiveDate: string) =>
      withTenant(db.rw, c, (tx) =>
        reverseDocument(tx, c, {
          documentId,
          effectiveDate,
          reason: "LEGACY-017",
          jobs: recordingJobs(),
        }),
      );

    // GR1 is what the returns are against; GR2 keeps stock positive, so no negative-stock refusal intervenes.
    const gr1 = await drafted(receiptType, "GRN", "10.000000", "120.0000", "2026-06-01");
    await post(gr1.documentId);
    const gr2 = await drafted(receiptType, "GRN", "5.000000", "60.0000", "2026-06-01");
    await post(gr2.documentId);
    const returned = async (quantity: string, amount: string, effectiveDate: string) => {
      const ret = await drafted(returnType, "PR", quantity, amount, effectiveDate);
      await withTenant(db.rw, c, (tx) =>
        linkFulfilment(tx, c, {
          sourceDocumentId: gr1.documentId,
          targetDocumentId: ret.documentId,
          linkKind: "returns",
          lines: [{ sourceLineId: gr1.lineIds[0]!, targetLineId: ret.lineIds[0]!, quantity }],
        }),
      );
      await post(ret.documentId);
      return ret;
    };

    // Return 3, then net it (R1): its claim is released and all ten read open again.
    const first = await returned("3.000000", "36.0000", "2026-06-10");
    const r1 = await reverse(first.documentId, "2026-06-11");
    expect(await openOf(db, s, gr1.documentId)).toBe("10.000000");
    // A second return takes eight of the released ten.
    await returned("8.000000", "96.0000", "2026-06-12");
    expect(await openOf(db, s, gr1.documentId)).toBe("2.000000");
    // Reversing R1 would put the first return's three back on top: 11 returned against 10 received.
    await expect(reverse(r1.reversalDocumentId, "2026-06-13")).rejects.toThrow(
      /ERR_DOC_LINK_OVER_FULFILLED: source line .* would carry 11\.000000 linked against 10\.000000 ordered/,
    );
    expect(await openOf(db, s, gr1.documentId)).toBe("2.000000");
  });
});

// ─── code review 4 (item 4, migration 0116 amended) ──────────────────────────────────────────────────────
// Appended; it edits none of the blocks above. A new link is bounded twice — by the quantity and by its
// source's status (only an issued or posted document can be fulfilled) — and a claim a reversal brings back
// was bounded by the quantity alone. Return 3 against GR1, net it (R1), fully reverse GR1 (admitted: the
// return's chain nets), then reverse R1: the return's claim stood again against a receipt that no longer
// exists, and the three units went back to the vendor a second time. The void half and the INSERT path are in
// `packages/db/test/open-quantity-reversal-chain.test.ts`.
describe("LEGACY-017 A reinstated return is bounded by its source's status too — code review 4", () => {
  it("reversing a netted return's reversal is refused once the receipt it returned against is reversed", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "LEGACY017-CR4");
    const f = await arApFixture(db, s);
    const receiptType = await seedTypeFromPack(db, s, "GOODS_RECEIPT");
    const returnType = await seedTypeFromPack(db, s, "PURCHASE_RETURN");
    const { itemId, baseUnitId } = await seedItem(db, s, {
      code: "LEGACY017-CR4",
      trackLots: false,
    });
    const warehouseId = await seedWarehouse(db, s, { code: "LEGACY017-CR4" });
    const c = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    // FIFO consumes the older GR2, keeping the linked GR1 untouched for its full cancellation.
    await withTenant(
      db.migrator,
      c,
      (tx) => tx`update app.company set costing_method = 'fifo' where id = ${s.company}`,
    );
    const drafted = (
      documentTypeId: string,
      series: string,
      quantity: string,
      amount: string,
      effectiveDate: string,
    ) =>
      draftTypedDocument(db, s, {
        documentTypeId,
        series,
        partyId: f.partyIds.vendor,
        warehouseId,
        effectiveDate,
        lines: [
          {
            kind: "item",
            itemId,
            unitId: baseUnitId,
            warehouseId,
            quantity,
            unitPrice: "12.0000",
            amount,
          },
        ],
      });
    const post = (documentId: string) =>
      withTenant(db.rw, c, (tx) => postDocument(tx, c, { documentId, jobs: recordingJobs() }));
    const reverse = (documentId: string, effectiveDate: string) =>
      withTenant(db.rw, c, (tx) =>
        reverseDocument(tx, c, {
          documentId,
          effectiveDate,
          reason: "LEGACY-017",
          jobs: recordingJobs(),
        }),
      );
    const onHand = async () => {
      const [row] = await withTenant(
        db.rw,
        c,
        (tx) => tx<{ q: string }[]>`
          select coalesce(sum(quantity), 0)::numeric(19,6)::text as q from app.stock_on_hand
           where company_id = ${s.company} and item_id = ${itemId}`,
      );
      return row!.q;
    };
    const statusOf = async (documentId: string) => {
      const [row] = await withTenant(
        db.rw,
        c,
        (tx) => tx<{ status: string }[]>`
          select status::text as status from app.document where id = ${documentId}`,
      );
      return row!.status;
    };

    // GR1 is what the return is against; GR2 keeps stock positive, so no negative-stock refusal intervenes.
    const gr2 = await drafted(receiptType, "GRN", "5.000000", "60.0000", "2026-06-01");
    await post(gr2.documentId);
    const gr1 = await drafted(receiptType, "GRN", "10.000000", "120.0000", "2026-06-01");
    await post(gr1.documentId);
    const ret = await drafted(returnType, "PR", "3.000000", "36.0000", "2026-06-10");
    await withTenant(db.rw, c, (tx) =>
      linkFulfilment(tx, c, {
        sourceDocumentId: gr1.documentId,
        targetDocumentId: ret.documentId,
        linkKind: "returns",
        lines: [
          { sourceLineId: gr1.lineIds[0]!, targetLineId: ret.lineIds[0]!, quantity: "3.000000" },
        ],
      }),
    );
    await post(ret.documentId);
    const r1 = await reverse(ret.documentId, "2026-06-11"); // nets the return
    await reverse(gr1.documentId, "2026-06-12"); // the whole receipt, admitted because the return nets
    expect(await onHand()).toBe("5.000000");

    await expect(reverse(r1.reversalDocumentId, "2026-06-13")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: .* reinstates the returns claim of document .* against source document .*, which is reversed/,
    );
    // Nothing moved: R1 still nets the return, and the three units did not leave a second time.
    expect(await statusOf(r1.reversalDocumentId)).toBe("posted");
    expect(await onHand()).toBe("5.000000");
  });
});

describe("LEGACY-017 A transfer dispatch is received at most once — full review 2026-11-15 (INV-01, INV-05)", () => {
  // The over-fulfilment control is a bound on SUM(link.quantity), and a NULL link adds nothing to the sum. A
  // total-loss receipt linked NULL, and a short one linked only what arrived, so a dispatch stayed open after
  // a receipt had taken its whole quantity out of transit, and a second receipt took it out again — out of
  // another dispatch's goods. Behaviour: packages/db/test/inventory/transfer-receipt.test.ts ("full review
  // INV-01/INV-05").
  it("each receipt line expects and links the dispatch line's OPEN quantity, never a NULL or a counted figure", () => {
    const src = repoFile("packages/db/src/inventory/transfer.ts");
    expect(src).toMatch(/await openQuantity\(tx, input\.transferDocumentId\)/);
    expect(src).toMatch(/const expected = openOf\.get\(dispatchLine\.id\)!;/);
    expect(src).toMatch(
      /links\.push\(\{ sourceLineId: dispatchLine\.id, targetLineId: row!\.id, quantity: expected \}\)/,
    );
    expect(src).not.toMatch(/nullif\(least\(/);
  });

  it("recordCounts refuses a transfer document or a fulfilment target, so no count is rewritten behind a link", () => {
    const src = repoFile("packages/db/src/inventory/count.ts");
    expect(src).toMatch(/definition\.inventory\.effect === "transfer" \|\| doc\.linked/);
  });
});

// ─── full review 2026-11-15: DBS-07 = INV-08 (migration 0127, ADR 0095) ───────────────────────────────────
// Appended. The bound is company-wide: before 0127 the guard summed a source line's links joined to
// app.document under the caller's RLS, so a principal restricted to the source's branch did not see a
// fulfilment drafted in another branch and linked the same quantity again. The sum is now
// app.source_line_linked_quantity, a company-bound definer lookup returning the quantity only.
// The full case, with the view, is `packages/db/test/open-quantity-branch-isolation.test.ts`.
import { issueDocument } from "@dulja/db";
import { seedAccount, seedBranch, seedDocumentType } from "@dulja/db/test";
import { secondPrincipal } from "../invariants/support/post-inventory";

describe("LEGACY-017 The over-fulfilment bound counts every branch — full review 2026-11-15 (0127)", () => {
  it("a principal restricted to the source's branch cannot re-link what another branch fulfilled", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "LEGACY017-0127");
    await seedAccount(db, s, { code: "1200", nameEn: "Trade receivables", type: "asset" });
    await seedAccount(db, s, { code: "4000", nameEn: "Sales", type: "income" });
    await grantCodes(db, s, { codes: ["accounting.sales.post"] });
    const typeId = await seedDocumentType(db, s, {
      code: "LEGACY017_0127",
      policy: {
        version: 1,
        documentType: "LEGACY017_0127",
        direction: "outbound",
        requires: ["party"],
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { from: "party.receivable_account" },
            amount: "line.total_incl_tax",
            when: { "line.kind": "item" },
          },
          {
            for: "each_line",
            side: "credit",
            account: { code: "4000" },
            amount: "line.amount",
            when: { "line.kind": "item" },
          },
        ],
        inventory: { effect: "none" },
        tax: { applies: false },
        numbering: { series: "S17", assignAt: "issue" },
        reversal: { allowed: false, producesType: null },
        approval: { required: false, approve: null, post: "accounting.sales.post" },
        fxRoundingAccount: { from: "company.fx_rounding_account_id" },
        dimensions: { required: [] },
      },
    });
    const brb = await seedBranch(db, s, { code: "BRB" });
    const partyId = await seedParty(db, s, { kind: "customer", code: "LEGACY017-0127" });
    const hqClerk = await secondPrincipal(db, s, "legacy017-hq-clerk");
    await grantCodes(db, s, { principalId: hqClerk, roleCode: "legacy017-hq", branchIds: [s.hq] });
    const draft = (branchId: string) =>
      draftTypedDocument(db, s, {
        documentTypeId: typeId,
        series: "S17",
        partyId,
        branchId,
        lines: [
          {
            kind: "item",
            description: "w",
            amount: "10.0000",
            unitPrice: "1.0000",
            quantity: "10.000000",
          },
        ],
      });
    const as = (actor: string) => ({
      tenantId: s.tenant,
      actorId: actor,
      requestId: "legacy-017-0127",
    });
    const link = (
      actor: string,
      src: { documentId: string; lineIds: string[] },
      tgt: { documentId: string; lineIds: string[] },
    ) =>
      withTenant(
        db.rw,
        as(actor),
        (tx) => tx`
        insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id,
                                       target_document_id, target_line_id, link_kind, quantity)
        values (${s.tenant}, ${s.company}, ${src.documentId}, ${src.lineIds[0]!},
                ${tgt.documentId}, ${tgt.lineIds[0]!}, 'fulfils', ${"10.000000"})`,
      );

    const order = await draft(s.hq);
    await withTenant(db.rw, as(s.human), (tx) =>
      issueDocument(tx, as(s.human), { documentId: order.documentId }),
    );
    await link(s.human, order, await draft(brb)); // all 10 fulfilled from branch BRB
    await expect(link(hqClerk, order, await draft(s.hq))).rejects.toThrow(
      /ERR_DOC_LINK_OVER_FULFILLED/,
    );
  });
});
