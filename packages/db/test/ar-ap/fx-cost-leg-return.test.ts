// packages/db/test/ar-ap/fx-cost-leg-return.test.ts — full review 2026-11-15, findings MON-01, MON-11 and
// MON-07 (docs/review/findings/money-posting.md on claude/review-money-posting). Each case was written to fail
// on main (6a8d239) for the reason the finding states, and passes against migration 0129 and the fx.ts /
// allocation.ts changes beside it.
//
// A foreign-currency PURCHASE_RETURN debits 2100 at `line.cost`, a BASE-currency cost leg (§4.7.3 amendment
// A4), so its control rows carry nothing in the return's own currency. 0048's ageing read only rows in the
// document's currency, so the return aged as EUR 0.0000 with base −cost, and `revalueAtPeriodEnd` revalued that
// base to zero — an "unrealised loss" of the whole return at a rate that never moved (MON-01); allocating it
// took its cost base as the settlement base, so the price-versus-cost difference was booked as realised FX
// (MON-11). `app.document_control_exposure` (0129) is now the one derivation: the return's exposure in its own
// currency is its keyed total at its own rate, and what the cost leg put on 2100 beyond that is a base-only
// residue, never revalued and never realised (the 2026-11-15 amendments to ADRs 0046 and 0047).
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  ageingRows,
  ageingTieOut,
  allocateSettlement,
  openBalance,
  revalueAtPeriodEnd,
  reverseRevaluation,
  withTenant as prodWithTenant,
  type TenantContext,
} from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  seedCurrency,
  seedItem,
  seedParty,
  seedRate,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import {
  arApFixture,
  postFromPack,
  seedTypeFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";
import { recordingJobs } from "../../../../tests/invariants/support/post-inventory";

const EUR = currency("EUR");
let db: Db;

beforeAll(async () => {
  db = await startDb();
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

const as = async <T>(s: Seed, fn: (tx: Sql, c: TenantContext) => Promise<T>): Promise<T> => {
  const c = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
  return prodWithTenant(db.rw, c, (tx) => fn(tx, c));
};
const periodOf = async (s: Seed, startsOn: string) => {
  const [p] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
      select id::text as id from app.fiscal_period
       where company_id = ${s.company} and starts_on = ${startsOn}::date`,
  );
  return p!.id;
};
const revalue = (s: Seed, periodId: string) =>
  as(s, (tx, c) => revalueAtPeriodEnd(tx, c, { companyId: s.company, fiscalPeriodId: periodId }));
const ageing = (s: Seed, asOf: string) =>
  withTenant(db.rw, s.tenant, s.human, (tx) => ageingRows(tx, { companyId: s.company, asOf }));
const tieOut2100 = async (s: Seed, asOf: string) =>
  (
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf }),
    )
  ).find((r) => r.accountCode === "2100");

/** A tenant with EUR rates `rates`, the FX type, one vendor and one item received in MYR at `unitCost`. */
async function returnFixture(
  name: string,
  rates: readonly (readonly [string, string])[],
  unitCost: string,
): Promise<{
  s: Seed;
  f: ArApFixture;
  vendor: string;
  returnOne: (keyedEur: string, on: string) => Promise<string>;
}> {
  const s = await seedTenantV2(db, name);
  const f = await arApFixture(db, s);
  await seedTypeFromPack(db, s, "FX_REVALUATION");
  await seedCurrency(db, s, { code: "EUR" });
  for (const [on, rate] of rates) {
    await seedRate(db, s, { from: "EUR", to: "MYR", on, rate, source: "manual:test" });
  }
  const vendor = await seedParty(db, s, { kind: "vendor", code: `${name}-V` });
  const { itemId, baseUnitId: unitId } = await seedItem(db, s, {
    code: `${name}-I`,
    kind: "product",
    trackLots: false,
  });
  const warehouseId = await seedWarehouse(db, s, { code: `${name}-W` });
  await postFromPack(db, s, {
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
        quantity: "1.000000",
        unitPrice: unitCost,
        amount: unitCost,
      },
    ],
  });
  const returnOne = async (keyedEur: string, on: string) =>
    (
      await postFromPack(db, s, {
        code: "PURCHASE_RETURN",
        effectiveDate: on,
        partyId: vendor,
        warehouseId,
        currency: "EUR",
        exchangeRate: "4.00000000",
        rateSource: "manual:test",
        jobs: recordingJobs(),
        lines: [
          {
            kind: "item",
            itemId,
            unitId,
            warehouseId,
            quantity: "1.000000",
            unitPrice: keyedEur,
            amount: keyedEur,
          },
        ],
      })
    ).documentId;
  return { s, f, vendor, returnOne };
}

describe("MON-01 — a foreign-currency PURCHASE_RETURN's exposure is its own currency's, at its own rate", () => {
  it("revaluing at an UNCHANGED rate posts nothing on 2100 (the reviewer's reproduction)", async () => {
    const { s, vendor, returnOne } = await returnFixture(
      "mon01-flat",
      [
        ["2026-01-01", "4.00000000"],
        ["2026-01-31", "4.00000000"],
      ],
      "115.0000",
    );
    await returnOne("30.0000", "2026-01-08");
    const r = await revalue(s, await periodOf(s, "2026-01-01"));
    // Nothing is posted: the exposure is reported at a zero delta. Main posted Dr 5910 / Cr 2100 115.0000.
    expect(r.documentId).toBeNull();
    expect(
      r.lines
        .filter((l) => l.accountCode === "2100")
        .map((l) => [l.currency, l.amountCcy, l.carriedBase, l.revaluedBase, l.delta]),
    ).toEqual([["EUR", "30.0000", "120.0000", "120.0000", "0.0000"]]);

    // The return ages as EUR −30 at its own rate (−120 base); the 5.0000 the cost leg put on 2100 below that
    // is a base-only residue — still on the ledger, so the tie-out stays exact.
    const rows = (await ageing(s, "2026-01-31")).filter((x) => x.partyId === vendor);
    expect(rows.map((x) => [x.currency, x.amount, x.baseAmount]).toSorted()).toEqual([
      ["EUR", "-30.0000", "-120.0000"],
      ["MYR", "5.0000", "5.0000"],
    ]);
    expect((await tieOut2100(s, "2026-01-31"))!.difference).toBe("0.0000");
  });

  it("revaluing after a rate move posts only the rate difference on the return's own amount", async () => {
    const { s, returnOne } = await returnFixture(
      "mon01-move",
      [
        ["2026-01-01", "4.00000000"],
        ["2026-01-31", "4.20000000"],
      ],
      "115.0000",
    );
    await returnOne("30.0000", "2026-01-08");
    const r = await revalue(s, await periodOf(s, "2026-01-01"));
    // 30 × (4.2 − 4.0) = 6.0000, debit 2100 (the vendor owes us more MYR): never the −115 of main.
    expect(
      r.lines
        .filter((l) => l.accountCode === "2100")
        .map((l) => [l.currency, l.amountCcy, l.carriedBase, l.revaluedBase, l.delta]),
    ).toEqual([["EUR", "30.0000", "120.0000", "126.0000", "6.0000"]]);
    expect((await tieOut2100(s, "2026-01-31"))!.difference).toBe("0.0000");
  });
});

describe("MON-11 — allocating a foreign-currency return realises only a rate difference", () => {
  it("a return keyed EUR 120 (cost 460) applied to a EUR 1,000 invoice at one rate realises nothing and leaves 880", async () => {
    const { s, f, vendor, returnOne } = await returnFixture(
      "mon11",
      [["2026-01-01", "4.00000000"]],
      "460.0000",
    );
    const invoice = (
      await postFromPack(db, s, {
        code: "PURCHASE_INVOICE",
        effectiveDate: "2026-01-06",
        partyId: vendor,
        currency: "EUR",
        exchangeRate: "4.00000000",
        rateSource: "manual:test",
        lines: [{ kind: "account", accountId: f.accountIds["5900"]!, amount: "1000.0000" }],
      })
    ).documentId;
    const ret = await returnOne("120.0000", "2026-01-08");

    const open = await as(s, (tx) => openBalance(tx, { companyId: s.company, documentId: ret }));
    expect([open.document.toString(), open.base.toString()]).toEqual(["120.0000", "480.0000"]);

    const { fxDifference } = await as(s, (tx, c) =>
      allocateSettlement(tx, c, {
        companyId: s.company,
        settlementDocumentId: ret,
        lines: [{ settledDocumentId: invoice, amount: Money.of("120.0000", EUR) }],
      }),
    );
    // Same rate on both documents: no FX. Main booked −20.0000 (480 at the invoice's rate against the cost 460).
    expect(fxDifference.toString()).toBe("0.0000");

    const rows = (await ageing(s, "2026-01-31")).filter((x) => x.partyId === vendor);
    expect(rows.map((x) => [x.currency, x.amount, x.baseAmount]).toSorted()).toEqual([
      ["EUR", "880.0000", "3520.0000"],
      ["MYR", "20.0000", "20.0000"],
    ]);
    expect((await tieOut2100(s, "2026-01-31"))!.difference).toBe("0.0000");
  });
});

describe("MON-07 — a late reversal of an unrealised revaluation does not hide the next period's", () => {
  it("January's revaluation reversed on February 28 still lets February be revalued", async () => {
    const s = await seedTenantV2(db, "mon07");
    const f = await arApFixture(db, s);
    await seedTypeFromPack(db, s, "FX_REVALUATION");
    await seedCurrency(db, s, { code: "EUR" });
    for (const [on, rate] of [
      ["2026-01-01", "4.00000000"],
      ["2026-01-31", "4.50000000"],
      ["2026-02-28", "4.80000000"],
    ] as const) {
      await seedRate(db, s, { from: "EUR", to: "MYR", on, rate, source: "manual:test" });
    }
    await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-10",
      partyId: f.partyIds.customer,
      currency: "EUR",
      exchangeRate: "4.00000000",
      rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "100.0000" }],
    });
    const january = await revalue(s, await periodOf(s, "2026-01-01"));
    expect(january.documentId).not.toBeNull();
    await as(s, (tx, c) =>
      reverseRevaluation(tx, c, {
        companyId: s.company,
        documentId: january.documentId!,
        effectiveDate: "2026-02-28",
      }),
    );
    const february = await revalue(s, await periodOf(s, "2026-02-01"));
    expect(february.documentId).not.toBeNull();
    // January's +50 is undone by its reversal on the 28th, so February restates from the invoice's own 400.
    expect(
      february.lines
        .filter((l) => l.accountCode === "1200")
        .map((l) => [l.amountCcy, l.carriedBase, l.revaluedBase, l.delta]),
    ).toEqual([["100.0000", "400.0000", "480.0000", "80.0000"]]);
  });
});
