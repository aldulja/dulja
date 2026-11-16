import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument, transitionDocument, withTenant as prodWithTenant } from "../../src";
import { computeDocumentTax } from "../../src/tax";
import { startDb, type Db } from "../harness";
import { draftTypedDocument, seedDocumentType } from "../fixtures";
import {
  postTaxedDocument,
  taxFixture,
  type TaxFixture,
} from "../../../../tests/invariants/support/tax";

let db: Db;
let f: TaxFixture;

beforeAll(async () => {
  db = await startDb();
  f = await taxFixture(db, "step11");
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

describe("postDocument step 11 — app.tax_transaction (§4.3.2, §4.9.2)", () => {
  it("one row per (line, code), carrying the SIGNED figures and the base twins", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-15",
      lines: [
        { lineNo: 1, amount: "300.0000", taxCode: "SYN-OUT-STD" },
        { lineNo: 2, amount: "70.0000", taxCode: "SYN-OUT-ZERO" },
      ],
    });
    const rows = await db.admin<
      {
        line_no: number;
        base: string;
        tax: string;
        base_base: string;
        tax_base: string;
        posting_seq: string;
        effective_date: string;
      }[]
    >`
      select line_no, base::text, tax::text, base_base::text, tax_base::text, posting_seq::text,
             effective_date::text
        from app.tax_transaction where document_id = ${documentId} order by line_no`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      line_no: 1,
      base: "300.0000",
      tax: "33.0000",
      base_base: "300.0000",
      tax_base: "33.0000",
      effective_date: "2026-01-15",
    });
    expect(rows[1]).toMatchObject({ line_no: 2, base: "70.0000", tax: "0.0000" });
    // posting_seq is assigned at step 8, BEFORE any row that carries it (§4.3.2), so it is never null.
    for (const r of rows) expect(BigInt(r.posting_seq) > 0n).toBe(true);
  });

  it("a credit note writes NEGATIVE tax — A9's one exception, read from `side` nowhere", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "SALES_CREDIT_NOTE",
      effectiveDate: "2026-01-16",
      lines: [{ lineNo: 1, amount: "-50.0000", taxCode: "SYN-OUT-STD" }],
    });
    const [r] = await db.admin<{ base: string; tax: string; tax_base: string }[]>`
      select base::text, tax::text, tax_base::text from app.tax_transaction where document_id = ${documentId}`;
    expect(r).toEqual({ base: "-50.0000", tax: "-5.5000", tax_base: "-5.5000" });
  });

  it("the ledger's tax leg and the tax_transaction agree to the cent, both directions", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-17",
      lines: [{ lineNo: 1, amount: "1000.0000", taxCode: "SYN-OUT-STD" }],
    });
    const [led] = await db.admin<{ credit: string }[]>`
      select sum(l.base_credit - l.base_debit)::text as credit from app.ledger_entry l
       where l.document_id = ${documentId} and l.account_id = ${f.accounts["2300"]!}`;
    const [txn] = await db.admin<{ tax: string }[]>`
      select sum(tax_base)::text as tax from app.tax_transaction where document_id = ${documentId}`;
    expect(led!.credit).toBe("110.0000");
    expect(txn!.tax).toBe("110.0000");
  });

  it("an INPUT code debits 1350 and its transaction carries the same figure", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "PURCHASE_INVOICE",
      effectiveDate: "2026-01-18",
      partyId: f.vendorId,
      lines: [
        {
          lineNo: 1,
          kind: "account",
          accountId: f.accounts["5900"]!,
          amount: "200.0000",
          taxCode: "SYN-IN-STD",
        },
      ],
    });
    const [led] = await db.admin<{ debit: string }[]>`
      select sum(l.base_debit - l.base_credit)::text as debit from app.ledger_entry l
       where l.document_id = ${documentId} and l.account_id = ${f.accounts["1350"]!}`;
    const [txn] = await db.admin<{ tax: string }[]>`
      select sum(tax_base)::text as tax from app.tax_transaction where document_id = ${documentId}`;
    expect(led!.debit).toBe("22.0000");
    expect(txn!.tax).toBe("22.0000");
  });

  it("an EXEMPT line writes a row with tax = 0; a CODE-LESS line writes no row at all", async () => {
    // The distinction matters to the return: an exempt supply is reported in box S3, so it must be a row
    // with a zero tax; a line with no code is not a taxable event and must not appear at all. SAH-058's
    // failure was the inverse — an uncoded voucher line was invisible to the reconciliation AND excluded
    // from the return, so nothing could tell the two apart.
    const { documentId: exempt } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-19",
      lines: [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-EXEMPT" }],
    });
    const [e] = await db.admin<{ n: number; tax: string | null }[]>`
      select count(*)::int as n, max(tax)::text as tax
        from app.tax_transaction where document_id = ${exempt}`;
    expect(e).toEqual({ n: 1, tax: "0.0000" });

    const { documentId: plain } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-21",
      lines: [{ lineNo: 1, amount: "100.0000", taxCode: null }],
    });
    const [p] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.tax_transaction where document_id = ${plain}`;
    expect(p!.n).toBe(0);
  });

  it("posting twice is impossible, so a tax transaction cannot be duplicated (SAH-041 + the unique key)", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-22",
      lines: [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-OUT-STD" }],
    });
    const c = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "again" };
    await expect(
      prodWithTenant(db.rw, c, (tx) => postDocument(tx, c, { documentId })),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL/);
  });

  it("PostResult.taxTransactionIds is filled, in plan order (§4.3.1)", async () => {
    const c = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "ids" };
    const { documentId } = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types["SALES_INVOICE"]!,
      series: "TMP",
      effectiveDate: "2026-01-23",
      partyId: f.customerId,
      lines: [
        {
          lineNo: 1,
          kind: "account",
          accountId: f.accounts["4000"]!,
          amount: "100.0000",
          taxCodeId: f.codes["SYN-OUT-STD"]!,
        },
        {
          lineNo: 2,
          kind: "account",
          accountId: f.accounts["4000"]!,
          amount: "200.0000",
          taxCodeId: f.codes["SYN-OUT-ZERO"]!,
        },
      ],
    });
    const result = await prodWithTenant(db.rw, c, async (tx) => {
      await computeDocumentTax(tx, c, documentId);
      await transitionDocument(tx, c, { documentId, to: "submitted" });
      return postDocument(tx, c, { documentId });
    });
    // Two DISTINCT codes are two `each_tax` groups, so two ids — the evaluator groups by code, not by line.
    expect(result.taxTransactionIds).toHaveLength(2);
    const stored = await db.admin<{ id: string }[]>`
      select id from app.tax_transaction where document_id = ${documentId} order by line_no`;
    expect(new Set(result.taxTransactionIds)).toEqual(new Set(stored.map((r) => r.id)));
  });
  it("an inclusive credit keeps historical tax after its source code is archived and expired", async () => {
    const historical = await taxFixture(db, "historical-credit");
    await postTaxedDocument(db, historical, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-15",
      taxInclusive: true,
      lines: [{ lineNo: 1, amount: "111.0000", taxCode: "SYN-OUT-STD" }],
    });
    const ctx = {
      tenantId: historical.s.tenant,
      actorId: historical.s.human,
      requestId: "archive-before-credit",
    };
    await prodWithTenant(db.rw, ctx, async (tx) => {
      await tx`update app.tax_code set archived_at = now(), effective_to = '2026-01-16' where id = ${historical.codes["SYN-OUT-STD"]!}`;
    });
    const { documentId } = await postTaxedDocument(db, historical, {
      typeCode: "SALES_CREDIT_NOTE",
      effectiveDate: "2026-01-20",
      taxInclusive: true,
      lines: [{ lineNo: 1, amount: "-55.5000", taxCode: "SYN-OUT-STD" }],
    });
    const [row] = await prodWithTenant(
      db.rw,
      ctx,
      (tx) => tx<{ tax_inclusive: boolean; base: string; tax: string }[]>`
      select d.tax_inclusive, t.base::text, t.tax::text from app.tax_transaction t join app.document d on d.id = t.document_id where d.id = ${documentId}`,
    );
    expect(row).toEqual({ tax_inclusive: true, base: "-50.0000", tax: "-5.5000" });
    await expect(
      postTaxedDocument(db, historical, {
        typeCode: "SALES_INVOICE",
        effectiveDate: "2026-01-20",
        lines: [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-OUT-STD" }],
      }),
    ).rejects.toMatchObject({ code: "ERR_TAX_REGIME_MISMATCH" });
  });

  it("a reverse-charge pair of `each_tax` rules posts both legs and ONE row per code (PR 11 review, round 3)", async () => {
    // Two `each_tax` rules over one code — debit the input account, credit the output account — are the
    // shape a reverse-charge purchase takes, and posting-policy.schema.json admits any number of them. Step 11
    // writes `plan.taxLines`, and (document_id, line_no, tax_code_id) is the table's unique key: planned once
    // per RULE, the pair inserted the same row twice and the post failed. The tax fact is the document's,
    // planned once; the ledger keeps one leg per rule.
    const typeId = await seedDocumentType(db, f.s, {
      code: "RC_PURCHASE",
      policy: {
        version: 1,
        documentType: "RC_PURCHASE",
        direction: "inbound",
        requires: ["party"],
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { from: "line.account" },
            amount: "line.amount",
          },
          {
            for: "each_line",
            side: "credit",
            account: { from: "party.payable_account" },
            amount: "line.amount",
          },
          {
            for: "each_tax",
            side: "debit",
            account: { from: "tax_code.input_account" },
            amount: "tax.amount",
          },
          { for: "each_tax", side: "credit", account: { code: "2300" }, amount: "tax.amount" },
        ],
        inventory: { effect: "none" },
        tax: { applies: true, inclusive: false },
        numbering: { series: "RCP", assignAt: "issue" },
        reversal: { allowed: false, producesType: null },
        approval: {
          required: false,
          approve: null,
          post: "accounting.purchase.post",
          create: "accounting.purchase.create",
        },
        fxRoundingAccount: { from: "company.fx_rounding_account_id" },
        dimensions: { required: ["BRANCH"] },
      },
    });
    const c = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "reverse-charge" };
    const { documentId } = await draftTypedDocument(db, f.s, {
      documentTypeId: typeId,
      series: "TMP",
      effectiveDate: "2026-01-24",
      partyId: f.vendorId,
      lines: [
        {
          lineNo: 1,
          kind: "account",
          accountId: f.accounts["5900"]!,
          amount: "100.0000",
          taxCodeId: f.codes["SYN-IN-STD"]!,
        },
        {
          lineNo: 2,
          kind: "account",
          accountId: f.accounts["5900"]!,
          amount: "200.0000",
          taxCodeId: f.codes["SYN-IN-STD"]!,
        },
      ],
    });
    const result = await prodWithTenant(db.rw, c, async (tx) => {
      await computeDocumentTax(tx, c, documentId);
      await transitionDocument(tx, c, { documentId, to: "submitted" });
      return postDocument(tx, c, { documentId });
    });
    expect(result.taxTransactionIds).toHaveLength(1);
    const rows = await db.admin<{ line_no: number; base: string; tax: string }[]>`
      select line_no, base::text, tax::text from app.tax_transaction where document_id = ${documentId}`;
    expect(rows).toEqual([{ line_no: 1, base: "300.0000", tax: "33.0000" }]);
    const legs = await db.admin<{ account_id: string; debit: string; credit: string }[]>`
      select account_id, sum(base_debit)::text as debit, sum(base_credit)::text as credit
        from app.ledger_entry
       where document_id = ${documentId} and account_id in (${f.accounts["1350"]!}, ${f.accounts["2300"]!})
       group by account_id`;
    expect(new Map(legs.map((l) => [l.account_id, [l.debit, l.credit]]))).toEqual(
      new Map([
        [f.accounts["1350"]!, ["33.0000", "0.0000"]],
        [f.accounts["2300"]!, ["0.0000", "33.0000"]],
      ]),
    );
  });
});
