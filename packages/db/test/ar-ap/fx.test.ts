import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  ageingRows,
  ageingTieOut,
  allocateSettlement,
  listAllocations,
  outstandingRevaluation,
  postSettlementFxDifference,
  resolveFxAccounts,
  revalueAtPeriodEnd,
  reverseRevaluation,
  settleWithFx,
  unallocate,
  withTenant as prodWithTenant,
  type TenantContext,
} from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  grantCodes,
  seedAccount,
  seedCurrency,
  seedParty,
  seedRate,
  seedTenantV2,
  type Seed,
} from "../fixtures";
import {
  arApFixture,
  postFromPack,
  seedTypeFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";

/**
 * 4B Task 5 — FX on settlement and at period end as the one FX_REVALUATION type (contracts §4.14, ADR 0047).
 *
 * The settlements here are in the SAME currency as the document they settle, at a different rate — a EUR
 * invoice at 5.0 paid by a EUR receipt at 5.2 realises the plan's 200 × 5.2 − 200 × 5.0 = 40.0000. The
 * cross-currency pair (a USD receipt paying the EUR invoice, ADR 0047 decision 9) is acceptance test 8's,
 * in tests/invariants/test-08-multi-currency.test.ts.
 *
 * The AR/AP pack policies take ONE account line carrying the amount and derive the control leg from the
 * party (Task 3's finding), so an invoice line names 4000, a receipt's 1100 and a bill's 5900.
 */
const EUR = currency("EUR");
let db: Db;
let s: Seed;
let f: ArApFixture;
let invoiceId: string;
let depositParty: string;
let depositId: string;
let depositInvoiceId: string;
let januaryId: string;
let revaluationId: string;

const line = (fixture: ArApFixture, code: string, amount: string) => ({
  kind: "account" as const,
  accountId: fixture.accountIds[code]!,
  amount,
});
const ctxOf = async (seed: Seed): Promise<TenantContext> => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: await uuidv7(db.admin),
});
/** Run `fn` in ONE production transaction as `seed.human`, the way a route handler does. */
const asHuman = async <T>(seed: Seed, fn: (tx: Sql, ctx: TenantContext) => Promise<T>) => {
  const ctx = await ctxOf(seed);
  return prodWithTenant(db.rw, ctx, (tx) => fn(tx, ctx));
};
const tieOut = async (seed: Seed, asOf: string) =>
  new Map(
    (
      await withTenant(db.rw, seed.tenant, seed.human, (tx) =>
        ageingTieOut(tx, { companyId: seed.company, asOf }),
      )
    ).map((r) => [r.accountCode, r]),
  );
const fxLines = (documentId: string) =>
  withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<
      { account_id: string; debit: string; credit: string; custom_fields: Record<string, string> }[]
    >`
      select account_id::text as account_id, debit::text as debit, credit::text as credit, custom_fields
        from app.document_line where document_id = ${documentId} order by line_no`,
  );
const periodOf = async (seed: Seed, startsOn: string) => {
  const [p] = await withTenant(
    db.rw,
    seed.tenant,
    seed.human,
    (tx) => tx<{ id: string }[]>`
    select id::text as id from app.fiscal_period
     where company_id = ${seed.company} and starts_on = ${startsOn}::date`,
  );
  return p!.id;
};

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "fx");
  f = await arApFixture(db, s);
  await seedTypeFromPack(db, s, "FX_REVALUATION");
  await seedCurrency(db, s, { code: "EUR" });
  // Invented figures, source 'manual:test' (hazard 18 — no real rate anywhere). The documents carry their
  // own rates; these four are what the revaluation reads through app.rate_for.
  for (const [on, rate] of [
    ["2026-01-01", "5.00000000"],
    ["2026-01-20", "5.20000000"],
    ["2026-01-31", "5.50000000"],
    ["2026-02-01", "5.10000000"],
  ] as const) {
    await seedRate(db, s, { from: "EUR", to: "MYR", on, rate, source: "manual:test" });
  }
  januaryId = await periodOf(s, "2026-01-01");
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("resolveFxAccounts (hazard 33)", () => {
  it("4900, 5910 and 5920 all resolve for the seeded company, and this slice seeds none of them", async () => {
    const accounts = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      resolveFxAccounts(tx, s.company),
    );
    expect(accounts.gainAccountId).toBe(f.accountIds["4900"]);
    expect(accounts.lossAccountId).toBe(f.accountIds["5910"]);
    const [rounding] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string }[]>`
      select code from app.account where id = ${accounts.roundingAccountId}`,
    );
    expect(rounding!.code).toBe("5920");
    // company.fx_rounding_account_id is 0C's wiring (spec:2001); seedTenantV2 sets it and this slice reads it.
    // The pack assertion that 0c-base.json still carries 4900/5910 is Task 2 Step 5's (one reader of the pack).
    const dir = fileURLToPath(new URL("../../seed/my/chart-of-accounts/", import.meta.url));
    expect(existsSync(`${dir}4b-fx.json`)).toBe(false);
  });

  it("a company missing 4900 raises ERR_POLICY_REQUIRES_MISSING naming the code, never a null account", async () => {
    const bare = await seedTenantV2(db, "fx-bare");
    await expect(
      withTenant(db.rw, bare.tenant, bare.human, (tx) => resolveFxAccounts(tx, bare.company)),
    ).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING.*4900/);
  });
});

describe("postSettlementFxDifference — the realised half (ADR 0047)", () => {
  it("a settlement at the settled document's own rate realises nothing, and posts nothing", async () => {
    ({ documentId: invoiceId } = await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-05",
      partyId: f.partyIds.customer,
      currency: "EUR",
      exchangeRate: "5.00000000",
      rateSource: "manual:test",
      lines: [line(f, "4000", "1000.0000")],
    }));
    const receipt = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-01-06",
      partyId: f.partyIds.customer,
      currency: "EUR",
      exchangeRate: "5.00000000",
      rateSource: "manual:test",
      lines: [line(f, "1100", "100.0000")],
      allocate: [{ settledDocumentId: invoiceId, amount: Money.of("100.0000", EUR) }],
    });
    expect(
      await asHuman(s, (tx, ctx) =>
        postSettlementFxDifference(tx, ctx, {
          companyId: s.company,
          settlementDocumentId: receipt.documentId,
        }),
      ),
    ).toBeNull();
    expect((await tieOut(s, "2026-01-31")).get("1200")!.difference).toBe("0.0000");
  });

  it("a EUR receipt at 5.2 for a EUR invoice at 5.0 posts ONE FX document: 1200 debit and 4900 credit, 40.0000 each", async () => {
    const receipt = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-01-20",
      partyId: f.partyIds.customer,
      currency: "EUR",
      exchangeRate: "5.20000000",
      rateSource: "manual:test",
      lines: [line(f, "1100", "200.0000")],
      allocate: [{ settledDocumentId: invoiceId, amount: Money.of("200.0000", EUR) }],
    });
    // 4A stored it and posted nothing: the ageing relieves the receipt at its own base (1040) while the
    // ledger relieved the invoice's 200 EUR at 5.0 (1000), so the tie-out is out by exactly the difference.
    expect((await tieOut(s, "2026-01-31")).get("1200")!.difference).toBe("40.0000");

    const posted = await asHuman(s, (tx, ctx) =>
      postSettlementFxDifference(tx, ctx, {
        companyId: s.company,
        settlementDocumentId: receipt.documentId,
      }),
    );
    expect(posted!.difference.toString()).toBe("40.0000"); // 200 × 5.2 − 200 × 5.0
    expect(posted!.fxDocumentIds).toHaveLength(1);
    const fxId = posted!.fxDocumentIds[0]!;

    const [doc] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<
        {
          party_id: string | null;
          currency: string;
          exchange_rate: string;
          rate_source: string;
          series: string;
          status: string;
          effective_date: string;
        }[]
      >`
      select party_id, currency::text as currency, exchange_rate::text as exchange_rate, rate_source,
             series, status::text as status, to_char(effective_date, 'YYYY-MM-DD') as effective_date
        from app.document where id = ${fxId}`,
    );
    expect(doc).toEqual({
      party_id: f.partyIds.customer, // ADR 0047 decision 3: the party's, and still no open item (0048 rule 5)
      currency: "MYR", // the base currency at the identity rate: the lines ARE base amounts
      exchange_rate: "1.00000000",
      rate_source: "unit",
      series: "FXR", // §4.14's series, written back by issueDocument
      status: "posted",
      effective_date: "2026-01-20", // the later of the receipt's and the invoice's dates
    });

    const lines = await fxLines(fxId);
    expect(lines.map((l) => [l.account_id, l.debit, l.credit])).toEqual([
      [f.accountIds["1200"], "40.0000", "0.0000"], // the receipt over-relieved 1200 by 40
      [f.accountIds["4900"], "0.0000", "40.0000"], // a credit to the result account is a GAIN
    ]);
    for (const l of lines) {
      expect(l.custom_fields).toEqual({
        fxKind: "realised",
        settlementDocumentId: receipt.documentId,
        settledDocumentId: invoiceId,
        partyId: f.partyIds.customer,
      });
    }
    expect((await tieOut(s, "2026-01-31")).get("1200")!.difference).toBe("0.0000");
    // It names the party, so the party's ledger balance carries it — and the ageing still does not age it.
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    expect(open.filter((r) => r.currency === "MYR")).toEqual([]);
    // Nor is it an open item to allocation: nothing may settle it, and it settles nothing.
    await expect(
      asHuman(s, (tx, ctx) =>
        allocateSettlement(tx, ctx, {
          companyId: s.company,
          settlementDocumentId: receipt.documentId,
          lines: [{ settledDocumentId: fxId, amount: Money.of("1.0000", currency("MYR")) }],
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .*FX_REVALUATION/);
  });

  it("is idempotent: a second call for the same settlement posts nothing", async () => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
      select settlement_document_id::text as id from app.allocation
       where company_id = ${s.company} and fx_difference <> 0 limit 1`,
    );
    expect(
      await asHuman(s, (tx, ctx) =>
        postSettlementFxDifference(tx, ctx, {
          companyId: s.company,
          settlementDocumentId: row!.id,
        }),
      ),
    ).toBeNull();
    const [n] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
      select count(distinct l.document_id)::int as n from app.document_line l
       where l.custom_fields->>'settlementDocumentId' = ${row!.id}`,
    );
    expect(n!.n).toBe(1);
  });

  it("a VENDOR payment whose base exceeds the bill's credits 2100 and debits 5910, not 4900", async () => {
    const bill = await postFromPack(db, s, {
      code: "PURCHASE_INVOICE",
      effectiveDate: "2026-01-06",
      partyId: f.partyIds.vendor,
      currency: "EUR",
      exchangeRate: "5.00000000",
      rateSource: "manual:test",
      lines: [line(f, "5900", "500.0000")],
    });
    const payment = await postFromPack(db, s, {
      code: "PAYMENT",
      effectiveDate: "2026-01-20",
      partyId: f.partyIds.vendor,
      currency: "EUR",
      exchangeRate: "5.20000000",
      rateSource: "manual:test",
      lines: [line(f, "1100", "500.0000")],
      allocate: [{ settledDocumentId: bill.documentId, amount: Money.of("500.0000", EUR) }],
    });
    // fx_difference is +100 exactly as the customer's is +40 — the SIDE is the settlement's, not the sign's.
    const posted = await asHuman(s, (tx, ctx) =>
      postSettlementFxDifference(tx, ctx, {
        companyId: s.company,
        settlementDocumentId: payment.documentId,
      }),
    );
    expect(posted!.difference.toString()).toBe("100.0000");
    const lines = await fxLines(posted!.fxDocumentIds[0]!);
    expect(lines.map((l) => [l.account_id, l.debit, l.credit])).toEqual([
      [f.accountIds["2100"], "0.0000", "100.0000"], // paid 2600 base to clear 2500: AP over-relieved by 100
      [f.accountIds["5910"], "100.0000", "0.0000"], // a debit to the result account is a LOSS
    ]);
    expect((await tieOut(s, "2026-01-31")).get("2100")!.difference).toBe("0.0000");
  });

  it("a deposit received BEFORE the invoice it pays is corrected on the invoice's date, so every as-of ties", async () => {
    depositParty = await seedParty(db, s, {
      kind: "customer",
      code: "CUST-DEP",
      receivableAccountId: f.accountIds["1200"]!,
    });
    ({ documentId: depositId } = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-01-10",
      partyId: depositParty,
      currency: "EUR",
      exchangeRate: "5.20000000",
      rateSource: "manual:test",
      lines: [line(f, "1100", "300.0000")],
    }));
    ({ documentId: depositInvoiceId } = await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-25",
      partyId: depositParty,
      currency: "EUR",
      exchangeRate: "5.00000000",
      rateSource: "manual:test",
      lines: [line(f, "4000", "300.0000")],
    }));
    // settleWithFx: the allocation and its realised difference in ONE transaction (ADR 0047).
    const settled = await asHuman(s, (tx, ctx) =>
      settleWithFx(tx, ctx, {
        companyId: s.company,
        settlementDocumentId: depositId,
        lines: [{ settledDocumentId: depositInvoiceId, amount: Money.of("300.0000", EUR) }],
      }),
    );
    expect(settled.fxDifference.toString()).toBe("60.0000"); // 300 × 5.2 − 300 × 5.0
    expect(settled.fxDocumentIds).toHaveLength(1);
    const [doc] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ on: string }[]>`
      select to_char(effective_date, 'YYYY-MM-DD') as on from app.document
       where id = ${settled.fxDocumentIds[0]!}`,
    );
    expect(doc!.on).toBe("2026-01-25");
    // Between the deposit and the invoice the ageing holds the deposit fully open and the ledger has no FX
    // leg yet; from the invoice on, both carry the allocation. Dated on the deposit, 01-15 would read 60.
    expect((await tieOut(s, "2026-01-15")).get("1200")!.difference).toBe("0.0000");
    expect((await tieOut(s, "2026-01-31")).get("1200")!.difference).toBe("0.0000");
  });

  it("an un-allocation withdraws the difference and a re-allocation restores it — the tie-out holds throughout", async () => {
    const [allocation] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listAllocations(tx, { companyId: s.company, settlementDocumentId: depositId }),
    );
    const withdrawn = await asHuman(s, async (tx, ctx) => {
      await unallocate(tx, ctx, {
        companyId: s.company,
        settlementDocumentId: depositId,
        allocationId: allocation!.id,
        reason: "applied to the wrong invoice",
      });
      return postSettlementFxDifference(tx, ctx, {
        companyId: s.company,
        settlementDocumentId: depositId,
      });
    });
    expect(withdrawn!.difference.toString()).toBe("-60.0000");
    // One direction rule, no exception for an unwinding: a debit to the result account is 5910.
    expect(
      (await fxLines(withdrawn!.fxDocumentIds[0]!)).map((l) => [l.account_id, l.debit, l.credit]),
    ).toEqual([
      [f.accountIds["1200"], "0.0000", "60.0000"],
      [f.accountIds["5910"], "60.0000", "0.0000"],
    ]);
    expect((await tieOut(s, "2026-01-31")).get("1200")!.difference).toBe("0.0000");

    const again = await asHuman(s, (tx, ctx) =>
      settleWithFx(tx, ctx, {
        companyId: s.company,
        settlementDocumentId: depositId,
        lines: [{ settledDocumentId: depositInvoiceId, amount: Money.of("300.0000", EUR) }],
      }),
    );
    expect(again.fxDocumentIds).toHaveLength(1);
    expect((await tieOut(s, "2026-01-31")).get("1200")!.difference).toBe("0.0000");
    // …and the deposit party is closed: nothing of it is open to revalue below.
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    expect(open.filter((r) => r.partyId === depositParty)).toEqual([]);
  });

  it("a realised FX document needs accounting.journal.post: a principal without it cannot realise one", async () => {
    // The allocation itself is 4A's and needs no posting code; the FX document's post is 2B's R2 on the
    // FX_REVALUATION policy's approval.post (§3.6.2's sentence for this type).
    const bill = await postFromPack(db, s, {
      code: "PURCHASE_INVOICE",
      effectiveDate: "2026-01-07",
      partyId: f.partyIds.vendor,
      currency: "EUR",
      exchangeRate: "5.00000000",
      rateSource: "manual:test",
      lines: [line(f, "5900", "10.0000")],
    });
    const refund = await postFromPack(db, s, {
      code: "PAYMENT",
      effectiveDate: "2026-01-21",
      partyId: f.partyIds.vendor,
      currency: "EUR",
      exchangeRate: "5.20000000",
      rateSource: "manual:test",
      lines: [line(f, "1100", "10.0000")],
    });
    const clerk = await seedPrincipalWithout(s, "fx-clerk");
    const ctx = { tenantId: s.tenant, actorId: clerk, requestId: await uuidv7(db.admin) };
    await expect(
      prodWithTenant(db.rw, ctx, (tx) =>
        settleWithFx(tx, ctx, {
          companyId: s.company,
          settlementDocumentId: refund.documentId,
          lines: [{ settledDocumentId: bill.documentId, amount: Money.of("10.0000", EUR) }],
        }),
      ),
    ).rejects.toThrow(/ERR_RBAC_FORBIDDEN.*accounting\.journal\.post/);
    // The whole transaction rolled back: no allocation was left behind with its difference unposted.
    const live = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listAllocations(tx, { companyId: s.company, settlementDocumentId: refund.documentId }),
    );
    expect(live).toEqual([]);
    // Settled by a principal who holds it, so no open item of this pair is left for the revaluation below.
    await asHuman(s, (tx, c) =>
      settleWithFx(tx, c, {
        companyId: s.company,
        settlementDocumentId: refund.documentId,
        lines: [{ settledDocumentId: bill.documentId, amount: Money.of("10.0000", EUR) }],
      }),
    );
    expect((await tieOut(s, "2026-01-31")).get("2100")!.difference).toBe("0.0000");
  });
});

/** A principal of `seed`'s tenant holding the payment codes and NOT accounting.journal.post. */
async function seedPrincipalWithout(seed: Seed, label: string): Promise<string> {
  const id = await secondPrincipal(db, seed, label);
  await grantCodes(db, seed, {
    codes: ["accounting.payment.create", "accounting.payment.post"],
    principalId: id,
    roleCode: label,
  });
  return id;
}

describe("revalueAtPeriodEnd and reverseRevaluation — the unrealised half", () => {
  it("revalues the open EUR item at the period-end rate, marks both lines unrealised, and the tie-out still holds", async () => {
    const result = await asHuman(s, (tx, ctx) =>
      revalueAtPeriodEnd(tx, ctx, { companyId: s.company, fiscalPeriodId: januaryId }),
    );
    expect(result.documentId).not.toBeNull();
    revaluationId = result.documentId!;
    expect(result.asOf).toBe("2026-01-31");
    expect(result.baseCurrency).toBe("MYR");
    // ONE exposure: the customer's 1000 − 100 − 200 = 700 EUR. The vendor's two bills are settled, the
    // deposit party is closed, the FX documents are MYR, and 1100 — which holds EUR rows but is not
    // DENOMINATED in EUR (account.currency is null) — is not revalued (ADR 0047's narrowing).
    expect(result.lines).toEqual([
      {
        accountId: f.accountIds["1200"],
        accountCode: "1200",
        currency: "EUR",
        amountCcy: "700.0000",
        carriedBase: "3500.0000", // at the invoice's OWN rate, 5.0
        revaluedBase: "3850.0000", // toBase(700 EUR, 5.5)
        delta: "350.0000",
        rate: "5.50000000",
      },
    ]);
    const lines = await fxLines(revaluationId);
    expect(lines.map((l) => [l.account_id, l.debit, l.credit])).toEqual([
      [f.accountIds["1200"], "350.0000", "0.0000"],
      [f.accountIds["4900"], "0.0000", "350.0000"],
    ]);
    for (const l of lines) {
      expect(l.custom_fields).toEqual({
        fxKind: "unrealised",
        fiscalPeriodId: januaryId,
        revaluedAccountId: f.accountIds["1200"],
        revaluedCurrency: "EUR",
      });
    }
    const [doc] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ party_id: string | null; branch_id: string }[]>`
      select party_id, branch_id::text as branch_id from app.document where id = ${revaluationId}`,
    );
    expect(doc).toEqual({ party_id: null, branch_id: s.hq }); // head office, by code

    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      expect(
        await outstandingRevaluation(tx, {
          companyId: s.company,
          accountId: f.accountIds["1200"]!,
          asOf: "2026-01-31",
        }),
      ).toBe("350.0000");
    });
    // The Phase 4 DoD figure after the unrealised revaluation (§4.8.2): the ledger moved by 350 and the
    // outstanding term says so.
    expect((await tieOut(s, "2026-01-31")).get("1200")).toMatchObject({
      ageingBase: "3500.0000",
      ledgerBase: "3850.0000",
      revaluationBase: "350.0000",
      difference: "0.0000",
    });
  });

  it("running it twice for the same period posts nothing the second time", async () => {
    const again = await asHuman(s, (tx, ctx) =>
      revalueAtPeriodEnd(tx, ctx, { companyId: s.company, fiscalPeriodId: januaryId }),
    );
    expect(again.documentId).toBeNull();
    expect(again.lines).toEqual([]);
  });

  it("a REALISED document is refused by reverseRevaluation — it is undone through its settlement", async () => {
    const [realised] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
      select distinct l.document_id::text as id from app.document_line l
       where l.custom_fields->>'fxKind' = 'realised' limit 1`,
    );
    await expect(
      asHuman(s, (tx, ctx) =>
        reverseRevaluation(tx, ctx, {
          companyId: s.company,
          documentId: realised!.id,
          effectiveDate: "2026-02-01",
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL.*not an unrealised revaluation/);
  });

  it("the reversal lands on the first day of the next period and nets the outstanding term to zero (§4.14)", async () => {
    const { reversalDocumentId } = await asHuman(s, (tx, ctx) =>
      reverseRevaluation(tx, ctx, {
        companyId: s.company,
        documentId: revaluationId,
        effectiveDate: "2026-02-01",
      }),
    );
    expect(reversalDocumentId).toBeTruthy();
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [original] = await tx<{ status: string }[]>`
        select status::text as status from app.document where id = ${revaluationId}`;
      expect(original!.status).toBe("reversed");
      expect(
        await outstandingRevaluation(tx, {
          companyId: s.company,
          accountId: f.accountIds["1200"]!,
          asOf: "2026-02-28",
        }),
      ).toBe("0.0000");
    });
    // The tie-out after the reversal, at both ends of it.
    expect((await tieOut(s, "2026-01-31")).get("1200")!.difference).toBe("0.0000");
    expect((await tieOut(s, "2026-02-28")).get("1200")).toMatchObject({
      ageingBase: "3500.0000",
      ledgerBase: "3500.0000",
      revaluationBase: "0.0000",
      difference: "0.0000",
    });
  });

  // Immediately AFTER the reversal — the case the guard's status set exists for. The "twice" case above
  // ran while the original was still 'posted', so a `status = 'posted'` guard passes it and fails here.
  it("re-running it AFTER the reversal still posts nothing (the guard counts 'reversed' too)", async () => {
    const third = await asHuman(s, (tx, ctx) =>
      revalueAtPeriodEnd(tx, ctx, { companyId: s.company, fiscalPeriodId: januaryId }),
    );
    expect(third.documentId).toBeNull();
    expect(third.lines).toEqual([]);
    expect((await tieOut(s, "2026-01-31")).get("1200")!.difference).toBe("0.0000");
  });

  it("settling the rest at 5.1 realises 70 more and closes the invoice to zero in the ageing and the ledger", async () => {
    const receipt = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-02-05",
      partyId: f.partyIds.customer,
      currency: "EUR",
      exchangeRate: "5.10000000",
      rateSource: "manual:test",
      lines: [line(f, "1100", "700.0000")],
    });
    const settled = await asHuman(s, (tx, ctx) =>
      settleWithFx(tx, ctx, {
        companyId: s.company,
        settlementDocumentId: receipt.documentId,
        lines: [{ settledDocumentId: invoiceId, amount: Money.of("700.0000", EUR) }],
      }),
    );
    // The completing allocation takes the invoice's base residue (4A): 700 × 5.1 − 3500.
    expect(settled.fxDifference.toString()).toBe("70.0000");
    const tie = await tieOut(s, "2026-02-28");
    expect(tie.get("1200")).toMatchObject({ ledgerBase: "0.0000", difference: "0.0000" });
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-02-28" }),
    );
    expect(open).toEqual([]);
  });

  it("base = round(value × rate, 4) holds on EVERY ledger line of this company, FX documents included (LEGACY-012)", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [bad] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.ledger_entry
         where company_id = ${s.company}
           and (base_debit <> round(debit * exchange_rate, 4) or base_credit <> round(credit * exchange_rate, 4))`;
      expect(bad!.n).toBe(0);
      const [fx] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.ledger_entry le
          join app.document d on d.id = le.document_id
          join app.document_type t on t.id = d.document_type_id
         where le.company_id = ${s.company} and t.code = 'FX_REVALUATION'`;
      expect(fx!.n).toBeGreaterThanOrEqual(12); // not vacuous: the FX documents above carry two lines each
      const [missing] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.document
         where company_id = ${s.company} and status in ('posted', 'reversed')
           and (rate_source is null or rate_source = '')`;
      expect(missing!.n).toBe(0);
    });
  });

  it("an account DENOMINATED in EUR is revalued from the ledger, beside the party's open items", async () => {
    const bank = await seedTenantV2(db, "fx-bank");
    // The bank account is created in EUR BEFORE the fixture, whose seedAccount is on-conflict-do-nothing.
    await seedCurrency(db, bank, { code: "EUR" });
    await seedAccount(db, bank, {
      code: "1100",
      nameEn: "Bank (EUR)",
      type: "asset",
      currency: "EUR",
    });
    const g = await arApFixture(db, bank);
    await seedRate(db, bank, {
      from: "EUR",
      to: "MYR",
      on: "2026-01-31",
      rate: "5.50000000",
      source: "manual:test",
    });
    // An on-account EUR receipt at 5.2: 1100 holds +200 EUR (1040), the customer −200 EUR open (−1040).
    await postFromPack(db, bank, {
      code: "RECEIPT",
      effectiveDate: "2026-01-20",
      partyId: g.partyIds.customer,
      currency: "EUR",
      exchangeRate: "5.20000000",
      rateSource: "manual:test",
      lines: [line(g, "1100", "200.0000")],
    });
    const result = await asHuman(bank, async (tx, ctx) =>
      revalueAtPeriodEnd(tx, ctx, {
        companyId: bank.company,
        fiscalPeriodId: await periodOf(bank, "2026-01-01"),
      }),
    );
    expect(
      result.lines.map((l) => [l.accountCode, l.amountCcy, l.carriedBase, l.revaluedBase, l.delta]),
    ).toEqual([
      ["1100", "200.0000", "1040.0000", "1100.0000", "60.0000"],
      ["1200", "-200.0000", "-1040.0000", "-1100.0000", "-60.0000"],
    ]);
    const lines = await withTenant(
      db.rw,
      bank.tenant,
      bank.human,
      (tx) => tx<{ account_id: string; debit: string; credit: string }[]>`
      select account_id::text as account_id, debit::text as debit, credit::text as credit
        from app.document_line where document_id = ${result.documentId!} order by line_no`,
    );
    expect(lines.map((l) => [l.account_id, l.debit, l.credit])).toEqual([
      [g.accountIds["1100"], "60.0000", "0.0000"],
      [g.accountIds["4900"], "0.0000", "60.0000"],
      [g.accountIds["1200"], "0.0000", "60.0000"],
      [g.accountIds["5910"], "60.0000", "0.0000"],
    ]);
    expect((await tieOut(bank, "2026-01-31")).get("1200")!.difference).toBe("0.0000");
  });

  it("a period with no foreign-currency exposure produces no document at all", async () => {
    const clean = await seedTenantV2(db, "fx-clean");
    await arApFixture(db, clean);
    const result = await asHuman(clean, async (tx, ctx) =>
      revalueAtPeriodEnd(tx, ctx, {
        companyId: clean.company,
        fiscalPeriodId: await periodOf(clean, "2026-01-01"),
      }),
    );
    expect(result).toMatchObject({ documentId: null, lines: [] });
  });

  it("a missing rate for an exposed currency raises ERR_RATE_NOT_FOUND naming the pair (LEGACY-012)", async () => {
    // The GBP exposure below has no exchange_rate row at all: the revaluation must refuse, never assume 1.
    const gbp = await seedTenantV2(db, "fx-norate");
    const g = await arApFixture(db, gbp);
    await seedCurrency(db, gbp, { code: "GBP" });
    await postFromPack(db, gbp, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-05",
      partyId: g.partyIds.customer,
      currency: "GBP",
      exchangeRate: "6.00000000",
      rateSource: "manual:test",
      lines: [line(g, "4000", "10.0000")],
    });
    const period = await periodOf(gbp, "2026-01-01");
    await expect(
      asHuman(gbp, (tx, ctx) =>
        revalueAtPeriodEnd(tx, ctx, { companyId: gbp.company, fiscalPeriodId: period }),
      ),
    ).rejects.toThrow(/ERR_RATE_NOT_FOUND.*GBP.*MYR/);
  });

  it("a period of a SIBLING company is ERR_PERIOD_NOT_FOUND, never a revaluation of the wrong books", async () => {
    // RLS bounds the tenant and nothing else (AGENTS.md): the period is visible to this tenant's principal,
    // and only the service's company binding refuses it.
    const sibling = await uuidv7(db.admin);
    const foreign = await uuidv7(db.admin);
    const system = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    await prodWithTenant(db.migrator, system, async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency)
               values (${sibling}, ${s.tenant}, 'FX-SIB', 'Sibling company', 'MYR')`;
      await tx`insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status)
               values (${foreign}, ${s.tenant}, ${sibling}, '2026-01-01', '2026-01-31', 'open')`;
    });
    await expect(
      asHuman(s, (tx, ctx) =>
        revalueAtPeriodEnd(tx, ctx, { companyId: s.company, fiscalPeriodId: foreign }),
      ),
    ).rejects.toThrow(/ERR_PERIOD_NOT_FOUND/);
  });
});
