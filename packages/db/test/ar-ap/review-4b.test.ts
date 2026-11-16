// packages/db/test/ar-ap/review-4b.test.ts — the Phase 4 review's confirmed 4B findings at the data layer
// (B1–B7), each written to fail against the tree it was found on and pass against the fix. B1's 409 is in
// apps/api/test/routes/accounting/review-4a.test.ts beside the other route-level findings.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { allocateSettlement } from "../../src/ar-ap/allocation";
import { match, importStatement } from "../../src/ar-ap/reconciliation";
import { revalueAtPeriodEnd, reverseRevaluation, settleWithFx } from "../../src/ar-ap/fx";
import { itemProfitabilityRows } from "../../src/projections/item-profitability";
import { replay } from "../../src/costing/replay";
import { postDocument, recordOverride, reverseDocument } from "../../src/posting";
import { withTenant, type TenantContext } from "../../src/with-tenant";
import type { Sql } from "postgres";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedCurrency,
  seedItem,
  seedParty,
  seedRate,
  seedTenantV2,
  seedWarehouse,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "../index";
import {
  arApFixture,
  postFromPack,
  seedTypeFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";
import {
  recordingJobs,
  secondPrincipal,
} from "../../../../tests/invariants/support/post-inventory";

let db: Db;
let s: Seed;
let f: ArApFixture;
const MYR = currency("MYR");
const EUR = currency("EUR");

const ctxFor = async (seed: Seed): Promise<TenantContext> => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: await uuidv7(db.admin),
});
/** Run `fn` in ONE production transaction as `seed.human`, the way a route handler does. */
const as = async <T>(seed: Seed, fn: (tx: Sql, c: TenantContext) => Promise<T>): Promise<T> => {
  const c = await ctxFor(seed);
  return withTenant(db.rw, c, (tx) => fn(tx, c));
};
const reverse = (documentId: string, effectiveDate: string, seed = s) =>
  as(seed, (tx, c) =>
    reverseDocument(tx, c, { documentId, effectiveDate, reason: "review", jobs: recordingJobs() }),
  );
const invoice = async (
  amount: string,
  on: string,
  opts: { currency?: string; rate?: string } = {},
) =>
  (
    await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: on,
      partyId: f.partyIds.customer,
      ...(opts.currency === undefined ? {} : { currency: opts.currency }),
      ...(opts.rate === undefined ? {} : { exchangeRate: opts.rate }),
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount }],
    })
  ).documentId;
const receipt = async (
  amount: string,
  on: string,
  opts: { currency?: string; rate?: string } = {},
) =>
  (
    await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: on,
      partyId: f.partyIds.customer,
      ...(opts.currency === undefined ? {} : { currency: opts.currency }),
      ...(opts.rate === undefined ? {} : { exchangeRate: opts.rate }),
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount }],
    })
  ).documentId;
const statusOf = async (documentId: string) =>
  (
    await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${documentId}`
  )[0]!.status;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "review-4b");
  f = await arApFixture(db, s);
  await seedTypeFromPack(db, s, "FX_REVALUATION");
  await seedCurrency(db, s, { code: "EUR" });
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("B1 — a party's control account is fixed once it has history", () => {
  it("refuses changing receivable_account_id or payable_account_id once a non-draft document of the party exists", async () => {
    const alt = await seedAccount(db, s, {
      code: "1201",
      nameEn: "Other receivables",
      type: "asset",
    });
    const p = await seedParty(db, s, {
      kind: "customer",
      code: "B1-CUST",
      receivableAccountId: f.accountIds["1200"]!,
    });
    const set = async (column: "receivable" | "payable", id: string | null) =>
      as(s, (tx) =>
        column === "receivable"
          ? tx`update app.party set receivable_account_id = ${id} where id = ${p}`
          : tx`update app.party set payable_account_id = ${id} where id = ${p}`,
      );
    // A draft is not history — nothing of it is in the ledger yet — so the account is still the party's.
    await draftTypedDocument(db, s, {
      documentTypeId: f.documentTypeIds.SALES_INVOICE!,
      series: "INV",
      effectiveDate: "2026-01-05",
      partyId: p,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "1.0000" }],
    });
    await set("receivable", alt);
    await set("receivable", f.accountIds["1200"]!);
    await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-05",
      partyId: p,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "100.0000" }],
    });
    await expect(set("receivable", alt)).rejects.toThrow(
      /ERR_CONFLICT_REFERENCE: party B1-CUST has posted documents/,
    );
    const altPayable = await seedAccount(db, s, {
      code: "2101",
      nameEn: "Other payables",
      type: "liability",
    });
    await expect(set("payable", altPayable)).rejects.toThrow(/ERR_CONFLICT_REFERENCE/);
    // Re-saving the same account — which the party PATCH does for every field it is not given — and editing
    // anything else is not a change of control account.
    await set("receivable", f.accountIds["1200"]!);
    await as(s, (tx) => tx`update app.party set name_en = 'Renamed' where id = ${p}`);
  });
});

describe("B2 — a realised FX_REVALUATION is never reversed on its own", () => {
  it("reverseDocument refuses the realised document an allocation posted", async () => {
    await seedRate(db, s, {
      from: "EUR",
      to: "MYR",
      on: "2026-01-01",
      rate: "5.00000000",
      source: "manual:test",
    });
    const inv = await invoice("200.0000", "2026-01-05", { currency: "EUR", rate: "5.00000000" });
    const rct = await receipt("200.0000", "2026-01-20", { currency: "EUR", rate: "5.20000000" });
    const { fxDocumentIds } = await as(s, (tx, c) =>
      settleWithFx(tx, c, {
        companyId: s.company,
        settlementDocumentId: rct,
        lines: [{ settledDocumentId: inv, amount: Money.of("200.0000", EUR) }],
      }),
    );
    expect(fxDocumentIds).toHaveLength(1);
    await expect(reverse(fxDocumentIds[0]!, "2026-01-25")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: document .* is a realised FX difference/,
    );
    expect(await statusOf(fxDocumentIds[0]!)).toBe("posted");
  });
});

describe("B3 — a reversal is never dated before its original", () => {
  it("refuses an earlier effective date, and admits the same day", async () => {
    const inv = await invoice("10.0000", "2026-01-20");
    await expect(reverse(inv, "2026-01-10")).rejects.toThrow(
      /ERR_VALIDATION_FAILED: .* cannot be reversed on 2026-01-10, before its own effective date 2026-01-20/,
    );
    expect(await statusOf(inv)).toBe("posted");
    await reverse(inv, "2026-01-20");
    expect(await statusOf(inv)).toBe("reversed");
  });
});

describe("B4 — one definition of a full reversal: chain depth parity", () => {
  it("the reversal of a reversal (a re-deposited receipt) is a live settlement and matches money IN", async () => {
    const r0 = await receipt("30.0000", "2026-01-05");
    const { reversalDocumentId: r1 } = await reverse(r0, "2026-01-06");
    const { reversalDocumentId: r2 } = await reverse(r1, "2026-01-07");
    // A reversal ages from the term its original pinned, like the original.
    const terms = await db.admin<{ id: string; term: string | null }[]>`
      select id, payment_term_id as term from app.document where id = any(${[r0, r1, r2]}::uuid[])`;
    expect(new Set(terms.map((t) => t.term))).toEqual(new Set([f.termId]));
    const inv = await invoice("30.0000", "2026-01-07");
    // R1 is netted with R0 and settles nothing; R2 is the live, re-deposited receipt and settles the invoice.
    await expect(
      as(s, (tx, c) =>
        allocateSettlement(tx, c, {
          companyId: s.company,
          settlementDocumentId: r1,
          lines: [{ settledDocumentId: inv, amount: Money.of("30.0000", MYR) }],
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL|full reversal/);
    const { allocationIds } = await as(s, (tx, c) =>
      allocateSettlement(tx, c, {
        companyId: s.company,
        settlementDocumentId: r2,
        lines: [{ settledDocumentId: inv, amount: Money.of("30.0000", MYR) }],
      }),
    );
    expect(allocationIds).toHaveLength(1);

    // The bank saw 30 in, 30 out (the bounced cheque) and 30 in again: R2 is money IN.
    const { statementId } = await as(s, (tx, c) =>
      importStatement(tx, c, {
        companyId: s.company,
        bankAccountId: f.accountIds["1100"]!,
        csv: [
          "Date,Narrative,Ref,Amount",
          "2026-01-05,deposit,R0,30.0000",
          "2026-01-06,returned,R1,-30.0000",
          "2026-01-07,re-deposit,R2,30.0000",
        ].join("\n"),
        mapping: {
          statement: {
            statementDate: "2026-01-07",
            openingBalance: "0.0000",
            closingBalance: "30.0000",
          },
          columns: {
            valueDate: "Date",
            description: "Narrative",
            reference: "Ref",
            amount: "Amount",
          },
          dateFormat: "YYYY-MM-DD",
          hasHeader: true,
        },
      }),
    );
    const lines = await db.admin<{ id: string; ref: string }[]>`
      select id, reference as ref from app.bank_statement_line where statement_id = ${statementId}`;
    const lineOf = (ref: string) => lines.find((l) => l.ref === ref)!.id;
    const matchOne = (statementLineId: string, documentId: string) =>
      as(s, (tx, c) =>
        match(tx, c, {
          companyId: s.company,
          statementLineId,
          reconcilable: { kind: "receipt", documentId },
          amount: Money.of("30.0000", MYR),
        }),
      );
    await matchOne(lineOf("R0"), r0);
    await matchOne(lineOf("R1"), r1);
    await matchOne(lineOf("R2"), r2);
  });
});

describe("B5 — an unrealised revaluation is not reversed under a later one that counted it", () => {
  it("refuses reversing January while February's revaluation stands; reversing February first releases it", async () => {
    const t = await seedTenantV2(db, "review-4b-reval");
    const g = await arApFixture(db, t);
    await seedTypeFromPack(db, t, "FX_REVALUATION");
    await seedCurrency(db, t, { code: "EUR" });
    for (const [on, rate] of [
      ["2026-01-01", "5.00000000"],
      ["2026-01-31", "5.50000000"],
      ["2026-02-28", "5.60000000"],
    ] as const) {
      await seedRate(db, t, { from: "EUR", to: "MYR", on, rate, source: "manual:test" });
    }
    await postFromPack(db, t, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-10",
      partyId: g.partyIds.customer,
      currency: "EUR",
      exchangeRate: "5.00000000",
      lines: [{ kind: "account", accountId: g.accountIds["4000"]!, amount: "1000.0000" }],
    });
    const period = async (startsOn: string) =>
      (
        await db.admin<{ id: string }[]>`
          select id from app.fiscal_period where company_id = ${t.company} and starts_on = ${startsOn}::date`
      )[0]!.id;
    const janDoc = await as(t, async (tx, c) =>
      revalueAtPeriodEnd(tx, c, {
        companyId: t.company,
        fiscalPeriodId: await period("2026-01-01"),
      }),
    );
    const febDoc = await as(t, async (tx, c) =>
      revalueAtPeriodEnd(tx, c, {
        companyId: t.company,
        fiscalPeriodId: await period("2026-02-01"),
      }),
    );
    expect(janDoc.lines[0]!.delta).toBe("500.0000");
    expect(febDoc.lines[0]!.delta).toBe("100.0000"); // counted January's 500 as still outstanding
    const reverseJan = (on: string) =>
      as(t, (tx, c) =>
        reverseRevaluation(tx, c, {
          companyId: t.company,
          documentId: janDoc.documentId!,
          effectiveDate: on,
        }),
      );
    await expect(reverseJan("2026-02-01")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: .* a later unrealised revaluation .* counted it/,
    );
    // …and not by the generic reversal either.
    await expect(reverse(janDoc.documentId!, "2026-02-01", t)).rejects.toThrow(
      /a later unrealised revaluation/,
    );
    await as(t, (tx, c) =>
      reverseRevaluation(tx, c, {
        companyId: t.company,
        documentId: febDoc.documentId!,
        effectiveDate: "2026-03-01",
      }),
    );
    await reverseJan("2026-03-01");
    expect(await statusOf(janDoc.documentId!)).toBe("reversed");
  });
});

describe("B6 / B7 — item_profitability agrees with the ledger, not with a current master-data column", () => {
  const rowOf = async (itemId: string) =>
    (await as(s, (tx) => itemProfitabilityRows(tx, { companyId: s.company }))).filter(
      (r) => r.itemId === itemId,
    );

  it("B6: a delivery that ran into negative stock carries its whole movement value as COGS", async () => {
    const { itemId } = await seedItem(db, s, { code: "B6-PR", kind: "product", trackLots: false });
    const wh = await seedWarehouse(db, s, { code: "WH-B6" });
    await postFromPack(db, s, {
      code: "GOODS_RECEIPT",
      effectiveDate: "2026-01-02",
      partyId: f.partyIds.vendor,
      warehouseId: wh,
      jobs: recordingJobs(),
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId: wh,
          quantity: "20.000000",
          unitPrice: "10.0000",
          amount: "200.0000",
        },
      ],
    });
    const supervisor = await secondPrincipal(db, s, "b6-sup");
    await grantCodes(db, s, {
      codes: ["inventory.negative_stock.override"],
      principalId: supervisor,
      roleCode: "b6-sup",
    });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId:
        f.documentTypeIds.DELIVERY_ORDER ?? (await seedTypeFromPack(db, s, "DELIVERY_ORDER")),
      series: "DO",
      effectiveDate: "2026-01-03",
      partyId: f.partyIds.customer,
      warehouseId: wh,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId: wh,
          quantity: "30.000000",
          unitPrice: "20.0000",
          amount: "600.0000",
        },
      ],
    });
    await as(s, async (tx, c) => {
      await recordOverride(tx, c, {
        documentId,
        code: "inventory.negative_stock.override",
        reason: "sold ahead of the next receipt",
        attributedTo: supervisor,
      });
      await postDocument(tx, c, { documentId, jobs: recordingJobs() });
    });
    const [ledger] = await db.admin<{ cost: string }[]>`
      select coalesce(sum(e.base_debit - e.base_credit), 0)::numeric(19,4)::text as cost
        from app.ledger_entry e where e.document_id = ${documentId} and e.account_id = ${f.accountIds["1250"]!}`;
    const [consumed] = await db.admin<{ v: string }[]>`
      select coalesce(sum(c.value), 0)::numeric(19,4)::text as v
        from app.cost_consumption c join app.inventory_movement m on m.id = c.movement_id
       where m.document_id = ${documentId} and c.invalidated_at is null`;
    // The premise: the layers covered only part of the issue, and the ledger carries the whole of it.
    expect(consumed!.v).not.toBe(ledger!.cost);
    const [row] = await rowOf(itemId);
    expect(row!.quantitySold).toBe("30.000000");
    expect(row!.cogsBase).toBe(ledger!.cost);
  });

  it("B7: revenue already earned does not move when the item's revenue account is changed", async () => {
    const { itemId } = await seedItem(db, s, { code: "B7-SV", kind: "service", trackLots: false });
    await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-12",
      partyId: f.partyIds.customer,
      lines: [
        { kind: "item", itemId, quantity: "2.000000", unitPrice: "25.0000", amount: "50.0000" },
      ],
    });
    expect((await rowOf(itemId))[0]!.revenueBase).toBe("50.0000");
    const other = await seedAccount(db, s, {
      code: "4010",
      nameEn: "Service revenue",
      type: "income",
    });
    await as(s, (tx) => tx`update app.item set revenue_account_id = ${other} where id = ${itemId}`);
    const [row] = await rowOf(itemId);
    expect(row!.revenueBase).toBe("50.0000");
    expect(row!.marginBase).toBe("50.0000");
  });

  it("B8: a cost replay rewrites nothing item_profitability reads, so it leaves the rows as they were", async () => {
    const { itemId } = await seedItem(db, s, { code: "B8-PR", kind: "product", trackLots: false });
    const wh = await seedWarehouse(db, s, { code: "WH-B8" });
    const receive = (on: string, unitPrice: string, amount: string) =>
      postFromPack(db, s, {
        code: "GOODS_RECEIPT",
        effectiveDate: on,
        partyId: f.partyIds.vendor,
        warehouseId: wh,
        jobs: recordingJobs(),
        lines: [
          {
            kind: "item",
            itemId,
            warehouseId: wh,
            quantity: "10.000000",
            unitPrice,
            amount,
          },
        ],
      });
    await receive("2026-01-20", "3.0000", "30.0000");
    const { documentId: doId } = await postFromPack(db, s, {
      code: "DELIVERY_ORDER",
      effectiveDate: "2026-01-25",
      partyId: f.partyIds.customer,
      warehouseId: wh,
      jobs: recordingJobs(),
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId: wh,
          quantity: "4.000000",
          unitPrice: "9.0000",
          amount: "36.0000",
        },
      ],
    });
    const before = await rowOf(itemId);
    const consumed = async () =>
      (
        await db.admin<{ v: string }[]>`
          select coalesce(sum(c.value), 0)::numeric(19,4)::text as v
            from app.cost_consumption c join app.inventory_movement m on m.id = c.movement_id
           where m.document_id = ${doId} and c.invalidated_at is null`
      )[0]!.v;
    const consumedBefore = await consumed();
    // A receipt back-dated before the delivery invalidates its consumption; the replay recosts it.
    await receive("2026-01-15", "1.0000", "10.0000");
    const c = await ctxFor(s);
    await replay(
      db.rw,
      { tenantId: s.tenant, requestId: c.requestId, payload: { companyId: s.company } },
      c,
    );
    expect(await consumed()).not.toBe(consumedBefore); // the premise: the replay changed the costing
    expect(await rowOf(itemId)).toEqual(before);
  });
});
