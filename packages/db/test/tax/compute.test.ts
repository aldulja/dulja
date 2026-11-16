import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant as prodWithTenant } from "../../src";
import { computeDocumentTax, resolveInclusive } from "../../src/tax";
import { startDb, withTenant, type Db } from "../harness";
import { draftTypedDocument } from "../fixtures";
import {
  postTaxedDocument,
  taxFixture,
  type TaxFixture,
} from "../../../../tests/invariants/support/tax";

let db: Db;
let f: TaxFixture;
const ctx = () => ({ tenantId: f.s.tenant, actorId: f.s.human, requestId: "compute-test" });

beforeAll(async () => {
  db = await startDb();
  f = await taxFixture(db, "compute");
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

/** `series` is a REQUIRED member of 3C's `DraftTypedDocumentOptions` (phase-3c:404-416) and every direct
 *  call in this slice passes `"TMP"`, exactly as 4B's `postFromPack` does (phase-4b:1946): the value never
 *  survives, because `issueDocument` overwrites it from `policy.numbering.series` and nothing here posts a
 *  document whose series it asserts. */
async function draft(
  taxInclusive: boolean,
  lines: { lineNo: number; amount: string; taxCode: string }[],
) {
  const { documentId } = await draftTypedDocument(db, f.s, {
    documentTypeId: f.types["SALES_INVOICE"]!,
    series: "TMP",
    effectiveDate: "2026-01-15",
    partyId: f.customerId,
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      kind: "account",
      accountId: f.accounts["4000"]!,
      amount: l.amount,
      taxCodeId: f.codes[l.taxCode]!,
    })),
  });
  await withTenant(
    db.rw,
    f.s.tenant,
    f.s.human,
    (tx) => tx`update app.document set tax_inclusive = ${taxInclusive} where id = ${documentId}`,
  );
  return documentId;
}

const p = (inclusive: unknown) => ({ tax: { applies: true, inclusive } }) as never;

describe("computeDocumentTax (spec:2228, ADR 0050)", () => {
  it("resolveInclusive is ONE rule: a boolean literal, or the header field", () => {
    expect(resolveInclusive(p(true), false)).toBe(true);
    expect(resolveInclusive(p(false), true)).toBe(false);
    expect(resolveInclusive(p("header.tax_inclusive"), true)).toBe(true);
    expect(resolveInclusive(p("header.tax_inclusive"), false)).toBe(false);
    expect(resolveInclusive(p(undefined), true)).toBe(false); // absent means exclusive
    expect(resolveInclusive({ tax: { applies: false } } as never, true)).toBe(false);
  });

  it("exclusive: tax_amount = amount x rate and total_incl_tax = amount + tax", async () => {
    const id = await draft(false, [{ lineNo: 1, amount: "300.0000", taxCode: "SYN-OUT-STD" }]);
    const written = await prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id));
    expect(written).toEqual([
      {
        lineId: expect.any(String),
        lineNo: 1,
        amount: "300.0000",
        taxAmount: "33.0000",
        totalInclTax: "333.0000",
      },
    ]);
    const [row] = await db.admin<{ tax_amount: string; total_incl_tax: string }[]>`
      select tax_amount::text, total_incl_tax::text from app.document_line where document_id = ${id}`;
    expect(row).toEqual({ tax_amount: "33.0000", total_incl_tax: "333.0000" });
  });

  it("inclusive: amount is REWRITTEN to the extracted base and total_incl_tax keeps the entered figure", async () => {
    const id = await draft(true, [{ lineNo: 1, amount: "333.0000", taxCode: "SYN-OUT-STD" }]);
    const [w] = await prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id));
    expect(w).toMatchObject({ amount: "300.0000", taxAmount: "33.0000", totalInclTax: "333.0000" });
    // §4.3.4 defines `amount` as "excl. tax, document currency" — so an inclusive entry MUST be rewritten,
    // or the each_line revenue leg would credit the tax-inclusive figure and the invoice would not balance.
  });

  it("is idempotent: computing twice writes the same figures and never taxes a tax", async () => {
    const id = await draft(true, [{ lineNo: 1, amount: "333.0000", taxCode: "SYN-OUT-STD" }]);
    const first = await prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id));
    const second = await prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id));
    expect(second).toEqual(first);
  });

  it("a line with no tax code is zeroed, not skipped — SAH-011's NULL arithmetic cannot start", async () => {
    const { documentId } = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types["SALES_INVOICE"]!,
      series: "TMP",
      effectiveDate: "2026-01-15",
      partyId: f.customerId,
      lines: [{ lineNo: 1, kind: "account", accountId: f.accounts["4000"]!, amount: "100.0000" }],
    });
    const [w] = await prodWithTenant(db.rw, ctx(), (tx) =>
      computeDocumentTax(tx, ctx(), documentId),
    );
    expect(w).toMatchObject({ taxAmount: "0.0000", totalInclTax: "100.0000" });
  });

  it("zero-rated and exempt codes yield zero tax and the full total", async () => {
    const id = await draft(false, [
      { lineNo: 1, amount: "70.0000", taxCode: "SYN-OUT-ZERO" },
      { lineNo: 2, amount: "80.0000", taxCode: "SYN-EXEMPT" },
    ]);
    const w = await prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id));
    expect(w.map((l) => l.taxAmount)).toEqual(["0.0000", "0.0000"]);
    expect(w.map((l) => l.totalInclTax)).toEqual(["70.0000", "80.0000"]);
  });

  it("two codes of DIFFERENT regimes on one document is a refusal (SAH-020)", async () => {
    const second = await prodWithTenant(db.rw, ctx(), async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                    name_en, source)
        values (${f.s.tenant}, ${f.s.company}, 'SYNTH-MY-v2', 'MY', 1, '2026-01-01',
                'Second synthetic regime', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
        returning id`;
      const [c] = await tx<{ id: string }[]>`
        insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, rate, kind, rounding_mode,
                                  output_account_id, effective_from)
        values (${f.s.tenant}, ${f.s.company}, ${r!.id}, 'SYN-OTHER', 'Other regime code', 0.04500000,
                'output', 'HALF_AWAY_FROM_ZERO', ${f.accounts["2300"]!}, '2026-01-01')
        returning id`;
      return c!.id;
    });
    const { documentId } = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types["SALES_INVOICE"]!,
      series: "TMP",
      effectiveDate: "2026-01-15",
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
          amount: "100.0000",
          taxCodeId: second,
        },
      ],
    });
    await expect(
      prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), documentId)),
    ).rejects.toThrow(
      /ERR_TAX_REGIME_MISMATCH: document .* spans two tax regimes: SYNTH-MY-v1 and SYNTH-MY-v2/,
    );
  });

  it("an archived code cannot be computed against — the loud half of spec:2049's archival", async () => {
    const id = await draft(false, [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-OUT-STD" }]);
    await prodWithTenant(
      db.rw,
      ctx(),
      (tx) => tx`update app.tax_code set archived_at = now() where id = ${f.codes["SYN-OUT-STD"]!}`,
    );
    await expect(
      prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id)),
    ).rejects.toThrow(/ERR_TAX_REGIME_MISMATCH: line 1: tax code SYN-OUT-STD is archived/);
    await prodWithTenant(
      db.rw,
      ctx(),
      (tx) => tx`update app.tax_code set archived_at = null where id = ${f.codes["SYN-OUT-STD"]!}`,
    );
  });

  it("a non-draft document refuses recomputation (spec:2049, SAH-041)", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-20",
      lines: [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-OUT-STD" }],
    });
    await expect(
      prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), documentId)),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: document .* is posted, not draft/);
  });
});
