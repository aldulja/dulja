import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  ageingRows,
  ageingTieOut,
  openBalance,
  outstandingRevaluation,
  partyBalance,
  revalueAtPeriodEnd,
  reverseRevaluation,
  settleWithFx,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import {
  seedCurrency,
  seedRate,
  seedTenantV2,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { arApFixture, postFromPack, type ArApFixture } from "./support/ar-ap";

/**
 * Acceptance test 8 (spec:2426; SAH-011, 012, 014) — "Multi-currency round-trip. Invoice EUR, part-pay USD,
 * settle in base, revalue at period end. FX gain/loss posts correctly; party balance correct in all three
 * currencies; `base = round(value × rate)` holds on every line."
 *
 * The sequence is invoice EUR → part-pay USD → revalue → reverse → settle in MYR. Each settlement pays the EUR
 * invoice in ANOTHER currency, so each allocation line states both figures — `amount` in the invoice's EUR,
 * `settlementAmount` in the receipt's own currency (ADR 0047 decision 9, a proposal). Every allocation goes
 * through `settleWithFx`, the route's one-transaction path, so no committed state ever holds an allocation
 * whose realised difference is unposted.
 *
 * Every rate is an invented round figure with source 'manual:test' (hazard 18). A RECEIPT is ONE bank line
 * posted against the party's control account (4A's pack policy), so a line names 1100 and the amount only.
 */
const EUR = currency("EUR");
const USD = currency("USD");
const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: ArApFixture;
let invoiceId: string;
let usdReceiptId: string;
let myrReceiptId: string;
let revaluationId: string;
const fxDocuments: string[] = [];

const ctxFor = async (): Promise<TenantContext> => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: await uuidv7(db.admin),
});

/** 1200's base balance — the whole AR control account, un-flipped, straight off account_balance. */
const controlBase = async (): Promise<string> =>
  withTenant(db.rw, await ctxFor(), async (tx) => {
    const [row] = await tx<{ base: string }[]>`
      select coalesce(sum(base_debit) - sum(base_credit), 0)::numeric(19,4)::text as base
        from app.account_balance where company_id = ${s.company} and account_id = ${f.accountIds["1200"]!}`;
    return row!.base;
  });

const tie1200 = async (asOf: string) => {
  const rows = await withTenant(db.rw, await ctxFor(), (tx) =>
    ageingTieOut(tx, { companyId: s.company, asOf }),
  );
  return rows.find((r) => r.accountCode === "1200")!;
};

/** Σ (credit − debit) on 4900 up to `asOf`: the FX GAIN the ledger carries. */
const gainAsOf = async (asOf: string): Promise<string> =>
  withTenant(db.rw, await ctxFor(), async (tx) => {
    const [row] = await tx<{ gain: string }[]>`
      select coalesce(sum(base_credit - base_debit), 0)::numeric(19,4)::text as gain
        from app.ledger_entry
       where company_id = ${s.company} and account_id = ${f.accountIds["4900"]!}
         and effective_date <= ${asOf}::date`;
    return row!.gain;
  });

const fxLines = async (documentId: string) =>
  withTenant(
    db.rw,
    await ctxFor(),
    (tx) => tx<{ account_id: string; debit: string; credit: string }[]>`
      select account_id::text as account_id, debit::text as debit, credit::text as credit
        from app.document_line where document_id = ${documentId} order by line_no`,
  );

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "test08");
  f = await arApFixture(db, s);
  for (const code of ["EUR", "USD"]) await seedCurrency(db, s, { code });
  for (const [from, on, rate] of [
    ["EUR", "2026-01-01", "5.00000000"],
    ["USD", "2026-01-20", "4.00000000"],
    ["EUR", "2026-01-20", "5.20000000"],
    ["EUR", "2026-01-31", "5.50000000"],
    ["EUR", "2026-02-01", "5.10000000"],
  ] as const) {
    await seedRate(db, s, { from, to: "MYR", on, rate, source: "manual:test" });
  }
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("acceptance test 8 — multi-currency round-trip (spec:2426; SAH-011, 012, 014)", () => {
  it("1. a EUR 1,000 invoice at 5.0000 carries base 5,000 and ages in EUR", async () => {
    ({ documentId: invoiceId } = await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-05",
      partyId: f.partyIds.customer,
      currency: "EUR",
      exchangeRate: "5.00000000",
      rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "1000.0000" }],
    }));
    expect(await controlBase()).toBe("5000.0000");
    const rows = await withTenant(db.rw, await ctxFor(), (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    expect(rows).toEqual([
      {
        partyId: f.partyIds.customer,
        currency: "EUR",
        bucket: "current",
        amount: "1000.0000",
        baseAmount: "5000.0000",
      },
    ]);
  });

  it("2. a USD 260 receipt at 4.0000 part-pays EUR 200 of it and realises 40 base of gain; the tie-out holds", async () => {
    ({ documentId: usdReceiptId } = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-01-20",
      partyId: f.partyIds.customer,
      currency: "USD",
      exchangeRate: "4.00000000",
      rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount: "260.0000" }],
    }));
    const c = await ctxFor();
    const settled = await withTenant(db.rw, c, (tx) =>
      settleWithFx(tx, c, {
        companyId: s.company,
        settlementDocumentId: usdReceiptId,
        lines: [
          {
            settledDocumentId: invoiceId,
            amount: Money.of("200.0000", EUR),
            settlementAmount: Money.of("260.0000", USD),
          },
        ],
      }),
    );
    // settlement base 260 × 4.0 = 1040; settled base 200 × 5.0 = 1000; the difference +40.
    expect(settled.fxDifference.toString()).toBe("40.0000");
    expect(settled.fxDocumentIds).toHaveLength(1);
    fxDocuments.push(...settled.fxDocumentIds);
    // FX gain posts correctly: the control account is debited back what the receipt over-relieved, and a
    // credit to the result account is a gain.
    expect(
      (await fxLines(settled.fxDocumentIds[0]!)).map((l) => [l.account_id, l.debit, l.credit]),
    ).toEqual([
      [f.accountIds["1200"], "40.0000", "0.0000"],
      [f.accountIds["4900"], "0.0000", "40.0000"],
    ]);
    expect(await controlBase()).toBe("4000.0000"); // 5000 − 1040 + 40
    expect((await tie1200("2026-01-31")).difference).toBe("0.0000");
    // The FX document names the party, so the party's ledger balance is the control account's.
    const balance = await withTenant(db.rw, await ctxFor(), (tx) =>
      partyBalance(tx, { companyId: s.company, partyId: f.partyIds.customer, asOf: "2026-01-31" }),
    );
    expect(balance.base.toString()).toBe("4000.0000");
  });

  it("2b. the ageing shows EUR 800 open and NO USD row — per currency it is an open-item view, not the ledger", async () => {
    const rows = await withTenant(db.rw, await ctxFor(), (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    expect(rows.map((r) => [r.currency, r.amount, r.baseAmount])).toEqual([
      ["EUR", "800.0000", "4000.0000"],
    ]);
    // The USD receipt is fully applied in its OWN currency — settlement_amount 260 of 260 — so it contributes no
    // row. account_balance still carries its USD credit on 1200; ADR 0046 says why that is not an open item.
    const open = await withTenant(db.rw, await ctxFor(), (tx) =>
      openBalance(tx, { companyId: s.company, documentId: usdReceiptId }),
    );
    expect([open.document.toString(), open.document.currency, open.base.toString()]).toEqual([
      "0.0000",
      "USD",
      "0.0000",
    ]);
  });

  it("3. the period-end revaluation at 5.5000 posts 400 of unrealised gain, and the tie-out still holds", async () => {
    const [period] = await withTenant(
      db.rw,
      await ctxFor(),
      (tx) => tx<{ id: string }[]>`
        select id::text as id from app.fiscal_period
         where company_id = ${s.company} and starts_on = '2026-01-01'`,
    );
    const c = await ctxFor();
    const result = await withTenant(db.rw, c, (tx) =>
      revalueAtPeriodEnd(tx, c, { companyId: s.company, fiscalPeriodId: period!.id }),
    );
    revaluationId = result.documentId!;
    // One exposure: the invoice's open EUR 800. The USD receipt is consumed, and 1100 — holding USD rows but
    // not denominated in USD — is not revalued (ADR 0047 decision 7).
    expect(result.lines).toEqual([
      {
        accountId: f.accountIds["1200"],
        accountCode: "1200",
        currency: "EUR",
        amountCcy: "800.0000",
        carriedBase: "4000.0000",
        revaluedBase: "4400.0000",
        delta: "400.0000",
        rate: "5.50000000",
      },
    ]);
    expect(await controlBase()).toBe("4400.0000");
    expect(await tie1200("2026-01-31")).toMatchObject({
      ageingBase: "4000.0000",
      ledgerBase: "4400.0000",
      revaluationBase: "400.0000",
      difference: "0.0000",
    });
    // The tie-out's own term and the exported reader are one figure.
    await withTenant(db.rw, await ctxFor(), async (tx) => {
      expect(
        await outstandingRevaluation(tx, {
          companyId: s.company,
          accountId: f.accountIds["1200"]!,
          asOf: "2026-01-31",
        }),
      ).toBe("400.0000");
    });
    expect(await gainAsOf("2026-01-31")).toBe("440.0000"); // 40 realised + 400 unrealised
  });

  it("4. the reversal on 2026-02-01 returns the control account to 4,000 and zeroes the outstanding term", async () => {
    const c = await ctxFor();
    await withTenant(db.rw, c, (tx) =>
      reverseRevaluation(tx, c, {
        companyId: s.company,
        documentId: revaluationId,
        effectiveDate: "2026-02-01",
      }),
    );
    expect(await controlBase()).toBe("4000.0000");
    await withTenant(db.rw, await ctxFor(), async (tx) => {
      expect(
        await outstandingRevaluation(tx, {
          companyId: s.company,
          accountId: f.accountIds["1200"]!,
          asOf: "2026-02-28",
        }),
      ).toBe("0.0000");
    });
    expect((await tie1200("2026-02-28")).difference).toBe("0.0000");
    expect((await tie1200("2026-01-31")).difference).toBe("0.0000");
  });

  it("5. settling the remaining EUR 800 in BASE — MYR 4,080 at 5.1 — realises 80 more and closes the invoice", async () => {
    ({ documentId: myrReceiptId } = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-02-05",
      partyId: f.partyIds.customer,
      currency: "MYR",
      exchangeRate: "1.00000000",
      rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount: "4080.0000" }],
    }));
    const c = await ctxFor();
    const settled = await withTenant(db.rw, c, (tx) =>
      settleWithFx(tx, c, {
        companyId: s.company,
        settlementDocumentId: myrReceiptId,
        lines: [
          {
            settledDocumentId: invoiceId,
            amount: Money.of("800.0000", EUR),
            settlementAmount: Money.of("4080.0000", MYR),
          },
        ],
      }),
    );
    expect(settled.fxDifference.toString()).toBe("80.0000"); // 4080 − 800 × 5.0
    fxDocuments.push(...settled.fxDocumentIds);
    expect(
      (await fxLines(settled.fxDocumentIds[0]!)).map((l) => [l.account_id, l.debit, l.credit]),
    ).toEqual([
      [f.accountIds["1200"], "80.0000", "0.0000"],
      [f.accountIds["4900"], "0.0000", "80.0000"],
    ]);
    expect(await controlBase()).toBe("0.0000"); // 4000 − 4080 + 80
    expect(await gainAsOf("2026-02-28")).toBe("120.0000"); // 40 + 80 realised; the 400 reversed
    await withTenant(db.rw, await ctxFor(), async (tx) => {
      expect(await ageingRows(tx, { companyId: s.company, asOf: "2026-02-28" })).toEqual([]);
    });
    expect(await tie1200("2026-02-28")).toMatchObject({
      ageingBase: "0.0000",
      ledgerBase: "0.0000",
      difference: "0.0000",
    });
  });

  it("6. the party balance is right in all three currencies (spec:2426's clause)", async () => {
    await withTenant(db.rw, await ctxFor(), async (tx) => {
      // The open-item view, per currency: nothing outstanding in EUR, USD or MYR.
      expect(await ageingRows(tx, { companyId: s.company, asOf: "2026-02-28" })).toEqual([]);
      const open = async (documentId: string) => {
        const o = await openBalance(tx, { companyId: s.company, documentId });
        return [o.document.currency, o.document.toString(), o.base.toString()];
      };
      expect(await open(invoiceId)).toEqual(["EUR", "0.0000", "0.0000"]);
      expect(await open(usdReceiptId)).toEqual(["USD", "0.0000", "0.0000"]);
      expect(await open(myrReceiptId)).toEqual(["MYR", "0.0000", "0.0000"]);
      // 4A's ledger-derived base figure agrees: the two realised FX documents name the party, so the party
      // owes nothing in base. (byCurrency is the LEDGER per currency — EUR +1000, USD −260, MYR −3960 — and on
      // a cross-currency month is not an open-item view: ADR 0046, contracts §4.8.2 amendment 4.)
      const balance = await partyBalance(tx, {
        companyId: s.company,
        partyId: f.partyIds.customer,
        asOf: "2026-02-28",
      });
      expect(balance.base.toString()).toBe("0.0000");
    });
  });

  it("7. base = round(value × rate, 4) holds on EVERY ledger line of the fixture (SAH-012)", async () => {
    await withTenant(db.rw, await ctxFor(), async (tx) => {
      const [bad] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.ledger_entry
         where company_id = ${s.company}
           and (base_debit <> round(debit * exchange_rate, 4)
             or base_credit <> round(credit * exchange_rate, 4))`;
      expect(bad!.n).toBe(0);
      const [rows] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.ledger_entry where company_id = ${s.company}`;
      // Not vacuous: seven documents, two legs each — the invoice, two receipts, two realised FX documents,
      // the revaluation and its reversal — entered in three currencies (the FX lines in base, MYR).
      expect(rows!.n).toBe(14);
      const [currencies] = await tx<{ list: string }[]>`
        select string_agg(distinct currency::text, ',' order by currency::text) as list
          from app.ledger_entry where company_id = ${s.company}`;
      expect(currencies!.list).toBe("EUR,MYR,USD");
    });
  });

  it("8. every ORIGINATING document of the fixture records its rate SOURCE (SAH-012, spec:1762)", async () => {
    await withTenant(db.rw, await ctxFor(), async (tx) => {
      const [missing] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.document
         where company_id = ${s.company} and status in ('posted', 'reversed')
           and reverses_document_id is null
           and (rate_source is null or rate_source = '')`;
      expect(missing!.n).toBe(0);
      // Not vacuous, and exact — SIX originating documents:
      //   1. the EUR 1,000 SALES_INVOICE               (clause 1)
      //   2. the USD 260 RECEIPT                       (clause 2)
      //   3. its realised FX_REVALUATION               (clause 2, settleWithFx)
      //   4. the period-end unrealised FX_REVALUATION  (clause 3)
      //   5. the MYR 4,080 RECEIPT                     (clause 5)
      //   6. its realised FX_REVALUATION               (clause 5)
      const [total] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.document
         where company_id = ${s.company} and status in ('posted', 'reversed')
           and reverses_document_id is null`;
      expect(total!.n).toBe(6);
      // The reversal from clause 4 is the seventh document, and reverseDocument copies its original's source.
      const [reversal] = await tx<{ n: number; source: string | null }[]>`
        select count(*)::int as n, max(rate_source) as source from app.document
         where company_id = ${s.company} and reverses_document_id is not null`;
      expect(reversal).toEqual({ n: 1, source: "unit" });
    });
    expect(fxDocuments).toHaveLength(2);
  });
});
