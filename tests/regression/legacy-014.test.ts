import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERRORS } from "@dulja/contracts";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import {
  ageingRows,
  draftSettlement,
  revalueAtPeriodEnd,
  salesByItem,
  withTenant,
} from "@dulja/db";
import { loadDocumentTypes } from "@dulja/db/seed";
import {
  seedAccount,
  seedCurrency,
  seedItem,
  seedParty,
  seedRate,
  seedTenantV2,
  seedWarehouse,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
// ONE import statement per module: `repoFile` and `sharedDb` are both exported from that file (§4.17.1).
import { repoFile, sharedDb } from "../support/regression";
import { REPO_ROOT } from "../support/source";
import { postArDocument } from "../invariants/support/post-ar";
import { arApFixture, postFromPack } from "../invariants/support/ar-ap";
import { recordingJobs } from "../invariants/support/post-inventory";
import {
  cachedReportFixture,
  readDefinition,
  runDefinition,
  type ReportFixture,
} from "../invariants/support/reports";

/**
 * LEGACY-014 (spec:340) — `procSumVouItems` silently discards the caller's exchange rate: when a caller supplied
 * a non-zero `vEqu`, the `else` branch overwrote it with 1, and a report requested at a contractual rate of
 * 1500 printed base-currency figures under a foreign-currency heading, 1500× too large, with no error. Its
 * related defect: a row predating the first `CurHistory` entry silently reused the previous row's rate.
 *
 * 4A CREATES this file (contracts §3.7.3): it is the first slice in execution order with a report that
 * converts a document amount to base (`inventory.sales_by_item`'s revenue) and a service that takes a
 * caller's rate (`draftSettlement`). The behaviour is asserted on the database; the two source-text cases
 * pin the shape that makes the behaviour structural.
 */

const PACK_DIR = join(REPO_ROOT, "packages", "db", "seed", "my", "document-types");

interface Fixture {
  db: Db;
  s: Seed;
  types: Record<string, string>;
  partyId: string;
}

let fixture: Promise<Fixture> | undefined;

/** One tenant in the shared database, the pack's types loaded through 0C's own loader, and USD beside MYR. */
function setup(): Promise<Fixture> {
  fixture ??= (async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "legacy-014-4a");
    for (const [code, nameEn, type] of [
      ["1100", "Bank", "asset"],
      ["1200", "Trade receivables", "asset"],
      ["1250", "Goods delivered not invoiced", "asset"],
      ["5000", "Cost of goods sold", "expense"],
    ] as const) {
      await seedAccount(db, s, { code, nameEn, type });
    }
    const seeded = await loadDocumentTypes(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      PACK_DIR,
      PERMISSIONS.map((p) => p.code),
    );
    const types = Object.fromEntries(seeded.map((row) => [row.code, row.documentTypeId]));
    await seedCurrency(db, s, { code: "USD" });
    const partyId = await seedParty(db, s, { kind: "customer", code: "CUST-014" });
    return { db, s, types, partyId };
  })();
  return fixture;
}

describe("LEGACY-014 The caller's exchange rate is never discarded — 4A", () => {
  it("no query in this slice substitutes 1 for a supplied rate", () => {
    for (const f of [
      "packages/db/src/reports/sales-by-item.ts",
      "packages/db/src/ar-ap/allocation.ts",
      "packages/db/src/ar-ap/invoice.ts",
      "packages/db/src/ar-ap/settlement.ts",
    ]) {
      const src = repoFile(f);
      // The legacy defect's exact shape: `if (:vEqu <> 0) then … else vEqu = 1`. Nothing here writes a
      // literal 1 over a rate; the only literal rate in the slice is the identity `settlement.ts` REQUIRES of
      // the base currency, and a different rate there is refused, never replaced (the case below).
      expect(src, f).not.toMatch(/exchange_?[Rr]ate\s*=\s*1\b/);
      expect(src, f).not.toMatch(/rate\s*=\s*['"]1(\.0+)?['"]/);
    }
  });

  it("a report converts on the DOCUMENT'S pinned rate — never a current one, never a default", async () => {
    const src = repoFile("packages/db/src/reports/sales-by-item.ts");
    // Code review B4: the report's revenue is app.item_revenue_rows (0048), the one definition
    // item_profitability reads too, so the conversion is pinned where it is spelled.
    expect(src).toMatch(/app\.item_revenue_rows/);
    expect(src).not.toMatch(/app\.rate_for/);
    const fn = repoFile("packages/db/migrations/0048_create_party_ageing_item_profitability.sql");
    expect(fn).toMatch(/round\(dl\.amount \* rd\.exchange_rate, 4\)/);

    // The behaviour: a USD invoice posted at the caller's 4.68351234 reports round(18.0000 × 4.68351234, 4) =
    // 84.3032 — not 18.0000, the rate-1 answer the legacy report printed, and not 72.0000, the figure a
    // re-conversion at the rate table's CURRENT 4.00000000 would give.
    const { db, s, types, partyId } = await setup();
    await seedRate(db, s, { from: "USD", to: "MYR", on: "2026-01-01", rate: "4.00000000" });
    const { itemId } = await seedItem(db, s, { code: "SV-014", kind: "service", trackLots: false });
    const invoice = await postArDocument(db, s, {
      documentTypeId: types.SALES_INVOICE!,
      series: "INV",
      partyId,
      effectiveDate: "2026-01-16",
      currency: "USD",
      exchangeRate: "4.68351234",
      lines: [
        {
          kind: "item",
          itemId,
          quantity: "2.000000",
          unitPrice: "9.0000",
          amount: "18.0000",
        },
      ],
    });
    const rates = await db.admin<{ rate: string }[]>`
      select distinct exchange_rate::text as rate from app.ledger_entry
       where document_id = ${invoice.documentId}
      union
      select exchange_rate::text from app.document where id = ${invoice.documentId}`;
    expect(rates.map((r) => r.rate)).toEqual(["4.68351234"]);
    const [row] = await withTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
      (tx) =>
        salesByItem(tx, {
          companyId: s.company,
          fromDate: "2026-01-16",
          toDate: "2026-01-16",
          itemId,
          limit: 50,
        }),
    );
    expect(row!.revenue).toBe("84.3032");
    const [ledger] = await db.admin<{ base: string }[]>`
      select sum(e.base_credit - e.base_debit)::numeric(19,4)::text as base
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${invoice.documentId} and a.code = '4000'`;
    expect(row!.revenue).toBe(ledger!.base);

    // And the database refuses any ledger row where the identity fails, on every row in the system.
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry
       where base_debit <> round(debit * exchange_rate, 4) or base_credit <> round(credit * exchange_rate, 4)`;
    expect(n!.n).toBe(0);
  });

  it("a settlement keeps the caller's rate, and a rate the base currency cannot take is REFUSED, not replaced by 1", async () => {
    const { db, s, types, partyId } = await setup();
    const [bank] = await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '1100'`;
    const input = {
      companyId: s.company,
      documentTypeId: types.RECEIPT!,
      series: "RCT",
      effectiveDate: "2026-01-16",
      partyId,
      bankAccountId: bank!.id,
      amount: "100.0000",
    };
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const usd = await withTenant(db.rw, ctx, (tx) =>
      draftSettlement(tx, ctx, { ...input, currency: "USD", exchangeRate: "4.50000000" }),
    );
    const [head] = await db.admin<{ rate: string; source: string | null }[]>`
      select exchange_rate::text as rate, rate_source as source
        from app.document where id = ${usd.documentId}`;
    // The rate the caller supplied, to eight places, with its provenance — not the rate table's 4.00000000.
    expect(head).toEqual({ rate: "4.50000000", source: `manual:${s.human}` });

    // The legacy `else vEqu = 1` in reverse: a base-currency settlement at a non-identity rate is an ERROR
    // the caller sees, never a silent substitution of the rate the caller did not ask for.
    await expect(
      withTenant(db.rw, ctx, (tx) =>
        draftSettlement(tx, ctx, { ...input, currency: "MYR", exchangeRate: "4.50000000" }),
      ),
    ).rejects.toMatchObject({ code: "ERR_VALIDATION_FAILED" });
  });

  it("a date before the first rate has NO rate — not 1 and not another row's rate (app.rate_for, ERR_RATE_NOT_FOUND)", async () => {
    const { db, s } = await setup();
    await seedCurrency(db, s, { code: "EUR" });
    await seedRate(db, s, { from: "USD", to: "EUR", on: "2026-02-01", rate: "0.92000000" });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const [before, after] = await withTenant(db.rw, ctx, async (tx) => [
      ...(await tx<{ rate: string | null }[]>`
        select (app.rate_for(${s.company}, 'USD', 'EUR', '2026-01-31'::date)).rate::text as rate`),
      ...(await tx<{ rate: string | null }[]>`
        select (app.rate_for(${s.company}, 'USD', 'EUR', '2026-02-10'::date)).rate::text as rate`),
    ]);
    // 0D's app.rate_for answers NULL when no rate is effective on the date, and the caller raises
    // ERR_RATE_NOT_FOUND (422). The legacy procedure returned a usable 1, or the previous row's rate.
    expect(before!.rate).toBeNull();
    expect(after!.rate).toBe("0.92000000");
    expect(ERRORS).toHaveProperty("ERR_RATE_NOT_FOUND");
  });
});

// 4B (contracts §3.7.3: appended to 4A's file, never editing the block above).
describe("LEGACY-014 The caller's exchange rate is never discarded — 4B", () => {
  it("the ageing values each open item at ITS OWN posted base, never at a rate looked up at report time", async () => {
    const { db } = await sharedDb();
    const src = async (name: string) => {
      const [fn] = await db.admin<{ prosrc: string }[]>`
        select p.prosrc from pg_proc p
         where p.pronamespace = 'app'::regnamespace and p.proname = ${name}`;
      return fn!.prosrc;
    };
    // base_amount is the document's OWN ledger base (base_debit − base_credit, written at its own rate), so
    // no single rate for the whole run can reach it and no identity rate can be substituted. Since 0129 the
    // ageing reads it through app.document_control_exposure (full review 2026-11-15, MON-01), which converts
    // only at the document's own exchange_rate.
    const ageing = await src("party_ageing_rows");
    expect(ageing).toMatch(/app\.document_control_exposure\(d\.id\)/);
    expect(ageing).not.toMatch(/rate_for/);
    expect(ageing).not.toMatch(/exchange_rate\s*=\s*1\b/);
    const exposure = await src("document_control_exposure");
    expect(exposure).toMatch(/le\.base_debit - le\.base_credit/);
    expect(exposure).toMatch(/d\.exchange_rate/);
    expect(exposure).not.toMatch(/rate_for/);
    expect(exposure).not.toMatch(/exchange_rate\s*=\s*1\b/);
  });

  it("the revaluation reads app.rate_for PER CURRENCY — two exposures, two rates, never the previous loop's", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "legacy-014-4b");
    const f = await arApFixture(db, s);
    for (const [code, rate] of [
      ["EUR", "5.50000000"],
      ["GBP", "6.50000000"],
    ] as const) {
      await seedCurrency(db, s, { code });
      await seedRate(db, s, {
        from: code,
        to: "MYR",
        on: "2026-01-31",
        rate,
        source: "manual:test",
      });
    }
    for (const [code, rate] of [
      ["EUR", "5.00000000"],
      ["GBP", "6.00000000"],
    ] as const) {
      await postFromPack(db, s, {
        code: "SALES_INVOICE",
        effectiveDate: "2026-01-05",
        partyId: f.partyIds.customer,
        currency: code,
        exchangeRate: rate,
        rateSource: "manual:test",
        lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "100.0000" }],
      });
    }
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const result = await withTenant(db.rw, ctx, async (tx) => {
      const [period] = await tx<{ id: string }[]>`
        select id::text as id from app.fiscal_period
         where company_id = ${s.company} and starts_on = '2026-01-01'`;
      return revalueAtPeriodEnd(tx, ctx, { companyId: s.company, fiscalPeriodId: period!.id });
    });
    // Each exposure is carried at its own document's rate and revalued at its own currency's rate.
    expect(result.lines.map((l) => [l.currency, l.carriedBase, l.rate, l.revaluedBase])).toEqual([
      ["EUR", "500.0000", "5.50000000", "550.0000"],
      ["GBP", "600.0000", "6.50000000", "650.0000"],
    ]);
    expect(repoFile("packages/db/src/ar-ap/fx.ts")).toContain("app.rate_for(");
  });
});

describe("LEGACY-014 The caller's exchange rate is never discarded — full review 2026-11-15 (MON-01)", () => {
  it("a EUR return posted through a base cost leg ages in EUR at its own rate — never EUR 0 beside a MYR cost", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "legacy-014-mon01");
    await arApFixture(db, s);
    await seedCurrency(db, s, { code: "EUR" });
    const vendor = await seedParty(db, s, { kind: "vendor", code: "VEND-014" });
    const { itemId, baseUnitId: unitId } = await seedItem(db, s, {
      code: "ITEM-014",
      kind: "product",
      trackLots: false,
    });
    const warehouseId = await seedWarehouse(db, s, { code: "WH-014" });
    const item = { kind: "item" as const, itemId, unitId, warehouseId, quantity: "1.000000" };
    await postFromPack(db, s, {
      code: "GOODS_RECEIPT",
      effectiveDate: "2026-01-05",
      partyId: vendor,
      warehouseId,
      jobs: recordingJobs(),
      lines: [{ ...item, unitPrice: "115.0000", amount: "115.0000" }],
    });
    // Keyed at EUR 30 at the caller's 4.0: the 2100 leg is the MYR cost 115, and the caller's rate is still the
    // one the return's EUR exposure is carried at (120), with the 5.0000 below it a MYR residue.
    await postFromPack(db, s, {
      code: "PURCHASE_RETURN",
      effectiveDate: "2026-01-08",
      partyId: vendor,
      warehouseId,
      currency: "EUR",
      exchangeRate: "4.00000000",
      rateSource: "manual:test",
      jobs: recordingJobs(),
      lines: [{ ...item, unitPrice: "30.0000", amount: "30.0000" }],
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const rows = await withTenant(db.rw, ctx, (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    expect(
      rows
        .filter((r) => r.partyId === vendor)
        .map((r) => [r.currency, r.amount, r.baseAmount])
        .toSorted(),
    ).toEqual([
      ["EUR", "-30.0000", "-120.0000"],
      ["MYR", "5.0000", "5.0000"],
    ]);
  });
});

// ── 7B ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface LedgerLine {
  number: string;
  lineNo: string;
  currency: string;
  exchangeRate: string;
  baseDebit: string;
  baseCredit: string;
}

/** January 2026's general ledger as the shipped definition answers it, in a stable order. The right-hand side of
 *  each field is a snake_case dataset alias (contracts 7B A3); the left-hand side is this helper's own shape. */
async function readGeneralLedger(f: ReportFixture): Promise<LedgerLine[]> {
  const ctx = { tenantId: f.s.tenant, actorId: f.reader, requestId: await uuidv7(f.db.admin) };
  const rows = await withTenant(f.db.rw, ctx, (tx) =>
    runDefinition(tx, readDefinition("accounting.general_ledger"), {
      companyId: f.s.company,
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
      accountId: null,
      branchId: null,
    }),
  );
  return rows
    .map((r) => ({
      number: String(r["number"]),
      lineNo: String(r["line_no"]),
      currency: String(r["currency"]),
      exchangeRate: String(r["exchange_rate"]),
      baseDebit: String(r["base_debit"]),
      baseCredit: String(r["base_credit"]),
    }))
    .toSorted((a, b) => `${a.number}|${a.lineNo}`.localeCompare(`${b.number}|${b.lineNo}`));
}

describe("LEGACY-014 The caller's exchange rate is never discarded — 7B", () => {
  // The defect: the legacy path took a rate from the caller and re-derived one at read time, so a report and a
  // voucher disagreed. Every base figure in the 7B catalogue is a STORED column — spec:2041, "stored base
  // amounts are never recomputed on read" — and the general ledger carries each line's own `exchange_rate`
  // beside it, so a reader can see which rate produced it.
  it("a later rate for a pair does not move a single figure in the general ledger", async () => {
    const { db } = await sharedDb();
    const f = await cachedReportFixture(db, "legacy014-7b");
    const before = await readGeneralLedger(f);
    expect(before.length).toBeGreaterThan(0);
    // A NEWER rate lands for a pair the company can now quote; the report is read again. Both reads must be
    // identical: a report that re-derived a base amount at read time would move.
    await seedCurrency(db, f.s, { code: "USD" });
    await seedRate(db, f.s, {
      from: "USD",
      to: "MYR",
      on: "2026-01-20",
      rate: "9.99000000",
      source: "manual:test",
    });
    const after = await readGeneralLedger(f);
    expect(after).toEqual(before);
    expect(after.every((r) => /^\d+\.\d+$/.test(r.exchangeRate))).toBe(true);
  });
});
