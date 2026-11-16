// tests/regression/sah-058.test.ts
// SAH-058 (M) — `procGetTaxItems` applies contradictory filters to the two halves of its union
// (spec:708). The failure: an uncoded manual journal is invisible to the reconciliation AND excluded
// from the return. Created by slice 5A.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { createTaxReturn, generateTaxReturn } from "@dulja/db";
import { startDb, type Db } from "@dulja/db/test";
import { postJournal } from "../invariants/support/post-journal"; // 1B's helper — the "manual voucher" half
import { postTaxedDocument, taxFixture } from "../invariants/support/tax";

describe("SAH-058 procGetTaxItems applies contradictory filters to the two halves of its union — 5A", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("an uncoded line behaves identically on a sale, on a purchase and on a manual journal", async () => {
    const f = await taxFixture(db, "sah058");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "sah058" };

    // One sale and one purchase, each with a CODED line and an UNCODED line. In the legacy system the
    // bill half and the voucher half of the union disagreed about what `uncoded` even meant, and the
    // voucher seed carried `ItmTaxCode is not null`, a contradiction that always returned zero rows.
    const sale = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-10",
      taxInclusive: false,
      lines: [
        { lineNo: 1, accountId: f.accounts["4000"]!, amount: "1000.0000", taxCode: "SYN-OUT-STD" },
        { lineNo: 2, accountId: f.accounts["4000"]!, amount: "500.0000", taxCode: null },
      ],
    });
    const purchase = await postTaxedDocument(db, f, {
      typeCode: "PURCHASE_INVOICE",
      effectiveDate: "2026-01-11",
      partyId: f.vendorId,
      taxInclusive: false,
      lines: [
        { lineNo: 1, accountId: f.accounts["5900"]!, amount: "200.0000", taxCode: "SYN-IN-STD" },
        { lineNo: 2, accountId: f.accounts["5900"]!, amount: "300.0000", taxCode: null },
      ],
    });
    // A manual journal: JOURNAL's policy declares `tax: { applies: false }` (§4.3.7) and its lines carry
    // no tax code at all. It must post, it must appear in the ledger, and it must contribute nothing.
    const journal = await postJournal(
      db,
      f.s,
      [
        { account: f.accounts["5900"]!, debit: "75.0000", credit: "0.0000" },
        { account: f.accounts["1100"]!, debit: "0.0000", credit: "75.0000" },
      ],
      { effectiveDate: "2026-01-12" },
    );

    const counts = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ doc: string; n: number }[]>`
      select d.id::text as doc, count(t.id)::int as n
        from app.document d
        left join app.tax_transaction t on t.document_id = d.id
       where d.id in (${sale.documentId}, ${purchase.documentId}, ${journal.documentId})
       group by d.id order by d.id`,
    );
    const byDoc = Object.fromEntries(counts.map((r) => [r.doc, r.n]));
    expect(byDoc[sale.documentId]).toBe(1); // the coded line only
    expect(byDoc[purchase.documentId]).toBe(1); // the coded line only — the SAME rule, both directions
    expect(byDoc[journal.documentId]).toBe(0); // and nothing at all for the manual voucher

    // All three are still in the ledger. The legacy failure was that the journal DISAPPEARED — from the
    // reconciliation and from the return — and the ledger was the only place it survived.
    const entries = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry
       where document_id in (${sale.documentId}, ${purchase.documentId}, ${journal.documentId})`,
    );
    expect(entries[0]!.n).toBeGreaterThanOrEqual(8);

    // And the uncoded lines were ZEROED, not left stale — T7's rule, and SAH-011's neighbour.
    const zeroed = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ tax_amount: string; total: string }[]>`
      select tax_amount::text, total_incl_tax::text as total from app.document_line
       where document_id = ${sale.documentId} and line_no = 2`,
    );
    expect(zeroed[0]).toEqual({ tax_amount: "0.0000", total: "500.0000" });
  }, 180_000);

  it("the uncoded value reaches the return through no box, and the coded value through exactly one", async () => {
    const f = await taxFixture(db, "sah058-boxes");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "sah058-b" };
    await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-10",
      taxInclusive: false,
      lines: [
        { lineNo: 1, accountId: f.accounts["4000"]!, amount: "1000.0000", taxCode: "SYN-OUT-STD" },
        { lineNo: 2, accountId: f.accounts["4000"]!, amount: "500.0000", taxCode: null },
      ],
    });
    const boxes = await withTenant(db.rw, ctx, async (tx) => {
      const d = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      });
      return (await generateTaxReturn(tx, ctx, d.id)).boxes;
    });
    // 1000 in S1, 110 in S2, and the 500 nowhere: an uncoded line is out of scope of the return by
    // construction, which is a decision the operator can see rather than a filter that lost it.
    expect(boxes.map((b) => [b.code, b.amount.toString()])).toEqual([
      ["S1", "1000.0000"],
      ["S2", "110.0000"],
      ["S3", "0.0000"],
      ["P1", "0.0000"],
      ["P2", "0.0000"],
    ]);
  }, 180_000);
});
