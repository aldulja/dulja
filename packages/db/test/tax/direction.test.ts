import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant as prodWithTenant } from "../../src";
import { createTaxCode, createTaxReturn, generateTaxReturn, taxReturnTieOut } from "../../src/tax";
import { startDb, type Db } from "../harness";
import {
  postTaxedDocument,
  taxFixture,
  type TaxFixture,
} from "../../../../tests/invariants/support/tax";
import { postFromPack } from "../../../../tests/invariants/support/ar-ap";
import { postJournal } from "../../../../tests/invariants/support/post-journal";

// MON-04 and MON-06 (2026-11-15 full review). A tax fact's side — output for a sale, input for a purchase — is
// the DOCUMENT's (its policy's `each_tax` accounts), never the code's kind alone; and a return's tie-out reads
// only the ledger legs of the documents that carry its tax facts (ADR 0050, the 2026-11-15 amendment).

let db: Db;
let f: TaxFixture;
let inputZeroId: string;
const ctx = () => ({ tenantId: f.s.tenant, actorId: f.s.human, requestId: "tax-direction" });

async function boxesFor(periodStart: string, periodEnd: string): Promise<Record<string, string>> {
  const r = await prodWithTenant(db.rw, ctx(), (tx) =>
    createTaxReturn(tx, ctx(), {
      companyId: f.s.company,
      regimeId: f.regimeId,
      periodStart,
      periodEnd,
    }),
  );
  const { boxes } = await prodWithTenant(db.rw, ctx(), (tx) => generateTaxReturn(tx, ctx(), r.id));
  return { id: r.id, ...Object.fromEntries(boxes.map((b) => [b.code, b.amount.toString()])) };
}

beforeAll(async () => {
  db = await startDb();
  f = await taxFixture(db, "tax-direction");
  // A tenant-made zero-rated INPUT code: the mirror of `SYN-EXEMPT` on a purchase.
  const row = await prodWithTenant(db.rw, ctx(), (tx) =>
    createTaxCode(tx, ctx(), {
      companyId: f.s.company,
      regimeId: f.regimeId,
      code: "SYN-IN-ZERO",
      nameEn: "Zero-rated purchase (synthetic)",
      rate: "0.00000000",
      kind: "input",
      roundingMode: "HALF_AWAY_FROM_ZERO",
      accountCode: "1350",
      effectiveFrom: "2026-01-01",
    }),
  );
  inputZeroId = row.id;
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("MON-04 — a tax fact is boxed on its document's side", () => {
  it("an exempt-coded PURCHASE_INVOICE lands in no supplies box", async () => {
    await postTaxedDocument(db, f, {
      typeCode: "PURCHASE_INVOICE",
      effectiveDate: "2026-01-20",
      partyId: f.vendorId,
      lines: [
        {
          lineNo: 1,
          kind: "account",
          accountId: f.accounts["5900"]!,
          amount: "400.0000",
          taxCode: "SYN-EXEMPT",
        },
      ],
    });
    // A zero-rated purchase declares no side either and is not a supply.
    await postTaxedDocument(db, f, {
      typeCode: "PURCHASE_INVOICE",
      effectiveDate: "2026-01-20",
      partyId: f.vendorId,
      lines: [
        {
          lineNo: 1,
          kind: "account",
          accountId: f.accounts["5900"]!,
          amount: "70.0000",
          taxCode: "SYN-OUT-ZERO",
        },
      ],
    });
    // And a genuine exempt SALE still does: S3 is the supplies side's box.
    await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-21",
      lines: [{ lineNo: 1, amount: "150.0000", taxCode: "SYN-EXEMPT" }],
    });
    const b = await boxesFor("2026-01-01", "2026-01-31");
    expect(b.S3).toBe("150.0000");
    expect(b.P1).toBe("0.0000");
  });

  it("an input code on a SALES_INVOICE is refused at draft (computeDocumentTax)", async () => {
    await expect(
      postFromPack(db, f.s, {
        code: "SALES_INVOICE",
        effectiveDate: "2026-02-10",
        partyId: f.customerId,
        computeTax: true,
        lines: [
          {
            lineNo: 1,
            kind: "account",
            quantity: "1.000000",
            accountId: f.accounts["4000"]!,
            amount: "300.0000",
            taxCodeId: inputZeroId,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "ERR_VALIDATION_FAILED" });
  });

  it("an input code on a SALES_INVOICE is refused at post, even when the draft's tax was never computed", async () => {
    await expect(
      postFromPack(db, f.s, {
        code: "SALES_INVOICE",
        effectiveDate: "2026-02-11",
        partyId: f.customerId,
        computeTax: false,
        lines: [
          {
            lineNo: 1,
            kind: "account",
            quantity: "1.000000",
            accountId: f.accounts["4000"]!,
            amount: "300.0000",
            taxCodeId: inputZeroId,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "ERR_POLICY_REQUIRES_MISSING" });
    // Nothing reached the return: P1 for February is empty.
    const b = await boxesFor("2026-02-01", "2026-02-28");
    expect(b.P1).toBe("0.0000");
    expect(b.S3).toBe("0.0000");
  });

  it("an output code on a PURCHASE_INVOICE is refused at draft (it used to fail only at post)", async () => {
    await expect(
      postFromPack(db, f.s, {
        code: "PURCHASE_INVOICE",
        effectiveDate: "2026-02-12",
        partyId: f.vendorId,
        computeTax: true,
        lines: [
          {
            lineNo: 1,
            kind: "account",
            quantity: "1.000000",
            accountId: f.accounts["5900"]!,
            amount: "300.0000",
            taxCodeId: f.codes["SYN-OUT-STD"]!,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "ERR_VALIDATION_FAILED" });
  });
});

describe("MON-06 — the tie-out does not count the remittance of an earlier period's tax", () => {
  it("Q2's output tie-out is clean after Q1's tax is paid in Q2", async () => {
    await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-03-10",
      lines: [{ lineNo: 1, amount: "1000.0000", taxCode: "SYN-OUT-STD" }],
    });
    const [april] = await db.admin<{ id: string }[]>`
      select id from app.fiscal_period
       where company_id = ${f.s.company} and starts_on <= '2026-04-15' and ends_on >= '2026-04-15'`;
    // The remittance of Q1's output tax: Dr 2300 / Cr 1100, a JOURNAL that carries no tax fact.
    await postJournal(
      db,
      f.s,
      [
        { account: f.accounts["2300"]!, debit: "110.0000" },
        { account: f.accounts["1100"]!, credit: "110.0000" },
      ],
      { effectiveDate: "2026-04-15", periodId: april!.id },
    );
    await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-05-05",
      lines: [{ lineNo: 1, amount: "500.0000", taxCode: "SYN-OUT-STD" }],
    });
    const b = await boxesFor("2026-04-01", "2026-06-30");
    expect(b.S2).toBe("55.0000");
    const tie = await prodWithTenant(db.rw, ctx(), (tx) => taxReturnTieOut(tx, b.id!));
    const output = tie.find((t) => t.accountCode === "2300")!;
    expect(output).toMatchObject({
      boxBase: "55.0000",
      ledgerBase: "55.0000",
      difference: "0.0000",
    });
  });
});
