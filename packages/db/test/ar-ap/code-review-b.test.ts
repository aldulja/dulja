// packages/db/test/ar-ap/code-review-b.test.ts — the code review's stream-B findings at the data layer
// (B1–B6), each written to fail against the tree it was found on and pass against the fix. B5's incident is
// in apps/worker/test/code-review-b.test.ts, beside the handler it concerns.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import {
  ageingRows,
  ageingTieOut,
  comparePartyAgeing,
  rebuildPartyAgeing,
} from "../../src/ar-ap/ageing";
import { listAllocations, unallocate } from "../../src/ar-ap/allocation";
import { creditNoteFrom } from "../../src/ar-ap/credit-note";
import { postSettlementFxDifference, settleWithFx } from "../../src/ar-ap/fx";
import { importStatement } from "../../src/ar-ap/reconciliation";
import { issueDocument, postDocument, reverseDocument } from "../../src/posting";
import {
  itemProfitabilityRows,
  rebuildItemProfitability,
} from "../../src/projections/item-profitability";
import { salesByItem } from "../../src/reports/sales-by-item";
import { withTenant, type TenantContext } from "../../src/with-tenant";
import {
  seedCurrency,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
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
import { postArDocument } from "../../../../tests/invariants/support/post-ar";
import { recordingJobs } from "../../../../tests/invariants/support/post-inventory";

let db: Db;
let s: Seed;
let f: ArApFixture;

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

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "code-review-b");
  f = await arApFixture(db, s);
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("B6 — an imported bank statement and its lines are fixed at import", () => {
  it("app_rw can neither rewrite a line's amount nor a statement's closing balance", async () => {
    const { statementId } = await as(s, (tx, c) =>
      importStatement(tx, c, {
        companyId: s.company,
        bankAccountId: f.accountIds["1100"]!,
        csv: "2026-01-10,RECEIPT CUST-1,RCT,400.00",
        mapping: {
          statement: {
            statementDate: "2026-01-31",
            openingBalance: "0.0000",
            closingBalance: "400.0000",
          },
          columns: { valueDate: 0, description: 1, reference: 2, amount: 3 },
          dateFormat: "YYYY-MM-DD",
          hasHeader: false,
        },
      }),
    );
    // Before 0049's guard both UPDATEs succeeded: app_rw holds UPDATE through default privileges.
    await expect(
      as(
        s,
        (tx) =>
          tx`update app.bank_statement_line set amount = 4000.0000 where statement_id = ${statementId}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE: bank_statement_line is append-only/);
    await expect(
      as(
        s,
        (tx) =>
          tx`update app.bank_statement set closing_balance = 4000.0000 where id = ${statementId}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE: bank_statement is append-only/);
    const [row] = await db.admin<{ closing: string; amount: string }[]>`
      select s.closing_balance::text as closing, l.amount::text as amount
        from app.bank_statement s join app.bank_statement_line l on l.statement_id = s.id
       where s.id = ${statementId}`;
    expect(row).toEqual({ closing: "400.0000", amount: "400.0000" });
  });
});

describe("B2 — step 14 enqueues the projection rebuild for the run date, never the document's", () => {
  it("two back-dated posts both enqueue a payload with no asOf, so a collapsed request means today", async () => {
    const jobs = recordingJobs();
    for (const on of ["2026-01-12", "2026-01-05"]) {
      await postFromPack(db, s, {
        code: "SALES_INVOICE",
        effectiveDate: on,
        partyId: f.partyIds.customer,
        jobs,
        lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "10.0000" }],
      });
    }
    const rebuilds = jobs.enqueued.filter((j) => j.name === "accounting.projection.rebuild");
    expect(rebuilds.map((j) => [j.payload, j.singletonKey])).toEqual([
      [{ companyId: s.company }, s.company],
      [{ companyId: s.company }, s.company],
    ]);
  });
});

describe("B4 — one definition of item revenue, read by sales_by_item and item_profitability alike", () => {
  it("a type that credits item.revenue_account and is not named SALES_INVOICE is revenue in both, and they agree", async () => {
    // The pack's SALES_INVOICE policy under another code: what 6A's POS_TICKET will be to these two reports —
    // a type whose pinned policy credits item.revenue_account, in no hard-coded list.
    const pack = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../seed/my/document-types/SALES_INVOICE.json", import.meta.url)),
        "utf8",
      ),
    ) as { policy: Record<string, unknown> };
    const typeId = await seedDocumentType(db, s, {
      code: "CRB_SALE",
      policy: {
        ...pack.policy,
        documentType: "CRB_SALE",
        numbering: { series: "CRB", assignAt: "issue" },
        reversal: { allowed: false, producesType: null },
      },
    });
    const { itemId } = await seedItem(db, s, { code: "B4-SV", kind: "service", trackLots: false });
    const itemLine = (amount: string) => ({
      kind: "item" as const,
      itemId,
      quantity: "1.000000",
      unitPrice: amount,
      amount,
    });
    await postArDocument(db, s, {
      documentTypeId: typeId,
      series: "CRB",
      partyId: f.partyIds.customer,
      effectiveDate: "2026-01-14",
      lines: [itemLine("50.0000")],
    });
    await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-15",
      partyId: f.partyIds.customer,
      lines: [itemLine("30.0000")],
    });
    const [report] = await as(s, (tx) =>
      salesByItem(tx, {
        companyId: s.company,
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
        itemId,
        limit: 10,
      }),
    );
    const projection = (
      await as(s, (tx) => itemProfitabilityRows(tx, { companyId: s.company }))
    ).filter((r) => r.itemId === itemId);
    // On the parent the report counted 30.0000 (its type list) and the projection 30.0000 (its membership).
    expect(report!.revenue).toBe("80.0000");
    expect(projection.map((r) => [r.fiscalPeriodId, r.revenueBase])).toEqual([
      [s.period, "80.0000"],
    ]);
  });
});

describe("B1 — an allocation carries its own accounting date, so a closed period never blocks it", () => {
  const USD = currency("USD");
  /** A fresh tenant per case: each one CLOSES March 2026. */
  const setup = async (name: string) => {
    const seed = await seedTenantV2(db, name);
    const fx = await arApFixture(db, seed);
    await seedTypeFromPack(db, seed, "FX_REVALUATION");
    await seedCurrency(db, seed, { code: "USD" });
    const post = async (code: string, on: string, rate: string, accountCode: string) =>
      (
        await postFromPack(db, seed, {
          code,
          effectiveDate: on,
          partyId: fx.partyIds.customer,
          currency: "USD",
          exchangeRate: rate,
          rateSource: "manual:test",
          lines: [{ kind: "account", accountId: fx.accountIds[accountCode]!, amount: "100.0000" }],
        })
      ).documentId;
    // The finding's figures: a USD invoice on 10 March at 4.40 and a USD receipt on 25 March at 4.50, on
    // account — 100 USD each, so allocating them realises 450 − 440 = 10.0000.
    const invoiceId = await post("SALES_INVOICE", "2026-03-10", "4.40000000", "4000");
    const receiptId = await post("RECEIPT", "2026-03-25", "4.50000000", "1100");
    const closeMarch = async () =>
      withTenant(
        db.migrator,
        { tenantId: seed.tenant, actorId: seed.system, requestId: await uuidv7(db.admin) },
        (tx) => tx`
          update app.fiscal_period set status = 'closed'
           where company_id = ${seed.company} and starts_on = '2026-03-01'::date`,
      );
    const tie = async (asOf: string) =>
      (await as(seed, (tx) => ageingTieOut(tx, { companyId: seed.company, asOf }))).find(
        (r) => r.accountCode === "1200",
      )!.difference;
    const march = () =>
      as(seed, (tx) => ageingRows(tx, { companyId: seed.company, asOf: "2026-03-31" }));
    const fxDates = async () =>
      (
        await db.admin<{ on: string }[]>`
          select to_char(d.effective_date, 'YYYY-MM-DD') as on from app.document d
            join app.document_type t on t.id = d.document_type_id
           where d.company_id = ${seed.company} and t.code = 'FX_REVALUATION' order by d.created_at`
      ).map((r) => r.on);
    const allocationRow = async () =>
      (
        await db.admin<{ effective: string; unallocated: string | null }[]>`
          select to_char(effective_date, 'YYYY-MM-DD') as effective,
                 to_char(unallocated_on, 'YYYY-MM-DD') as unallocated
            from app.allocation where settlement_document_id = ${receiptId}`
      )[0]!;
    const settle = () =>
      as(seed, (tx, c) =>
        settleWithFx(tx, c, {
          companyId: seed.company,
          settlementDocumentId: receiptId,
          lines: [{ settledDocumentId: invoiceId, amount: Money.of("100.0000", USD) }],
        }),
      );
    const unsettle = () =>
      as(seed, async (tx, c) => {
        const [live] = await listAllocations(tx, {
          companyId: seed.company,
          settlementDocumentId: receiptId,
        });
        await unallocate(tx, c, {
          companyId: seed.company,
          settlementDocumentId: receiptId,
          allocationId: live!.id,
          reason: "applied to the wrong invoice",
        });
        return postSettlementFxDifference(tx, c, {
          companyId: seed.company,
          settlementDocumentId: receiptId,
        });
      });
    return {
      seed,
      invoiceId,
      receiptId,
      closeMarch,
      tie,
      march,
      fxDates,
      allocationRow,
      settle,
      unsettle,
    };
  };

  it("allocating and unallocating in April with March closed: both FX documents land in April and every as-of ties", async () => {
    const x = await setup("code-review-b1a");
    await x.closeMarch();
    const marchBefore = await x.march();
    // Both documents open, both on the fixture's 30-day term and so both `current` on 31 March, where the
    // invoice's 100 USD (440.0000) and the receipt's −100 USD (−450.0000) share one bucket row.
    expect(marchBefore.map((r) => [r.currency, r.bucket, r.amount, r.baseAmount])).toEqual([
      ["USD", "current", "0.0000", "-10.0000"],
    ]);

    // On the parent the FX document was dated 25 March, postDocument raised ERR_PERIOD_NOT_OPEN, and the
    // allocation rolled back with it.
    const settled = await x.settle();
    expect(settled.fxDifference.toString()).toBe("10.0000");
    expect(await x.fxDates()).toEqual(["2026-04-01"]);
    expect(await x.allocationRow()).toEqual({ effective: "2026-04-01", unallocated: null });
    expect(await x.march()).toEqual(marchBefore); // the closed month's ageing is as it was reported
    expect(await x.tie("2026-03-31")).toBe("0.0000");
    expect(await x.tie("2026-04-30")).toBe("0.0000");
    // The accounting date is the guard's, fixed at insert like every other figure.
    await expect(
      as(
        x.seed,
        (tx) =>
          tx`update app.allocation set effective_date = '2026-03-25' where settlement_document_id = ${x.receiptId}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE: allocation .* is fixed at insert/);

    const withdrawn = await x.unsettle();
    expect(withdrawn!.difference.toString()).toBe("-10.0000");
    expect(await x.fxDates()).toEqual(["2026-04-01", "2026-04-01"]);
    expect(await x.allocationRow()).toEqual({ effective: "2026-04-01", unallocated: "2026-04-01" });
    expect(await x.march()).toEqual(marchBefore);
    expect(await x.tie("2026-03-31")).toBe("0.0000");
    expect(await x.tie("2026-04-30")).toBe("0.0000");
  });

  it("an allocation made while March was open is unallocated in April after the close, and the invoice can then be reversed", async () => {
    const x = await setup("code-review-b1b");
    await x.settle(); // March open: dated 25 March, the later document's date
    expect(await x.fxDates()).toEqual(["2026-03-25"]);
    await x.closeMarch();
    const marchAllocated = await x.march();
    expect(marchAllocated).toEqual([]); // both documents relieved in full as of 31 March

    // On the parent the withdrawal was dated on the original FX document's 25 March and refused.
    await x.unsettle();
    expect(await x.fxDates()).toEqual(["2026-03-25", "2026-04-01"]);
    expect(await x.allocationRow()).toEqual({ effective: "2026-03-25", unallocated: "2026-04-01" });
    // March still reads as it did when it closed; April shows both documents open again.
    expect(await x.march()).toEqual(marchAllocated);
    expect(await x.tie("2026-03-31")).toBe("0.0000");
    expect(await x.tie("2026-04-30")).toBe("0.0000");
    const april = await as(x.seed, (tx) =>
      ageingRows(tx, { companyId: x.seed.company, asOf: "2026-04-30" }),
    );
    // 21 and 6 days past their terms: one 1_30 row holding both documents' open figures again.
    expect(april.map((r) => [r.currency, r.bucket, r.amount, r.baseAmount])).toEqual([
      ["USD", "1_30", "0.0000", "-10.0000"],
    ]);

    // …and with no live allocation left the invoice can be reversed, in April.
    await as(x.seed, (tx, c) =>
      reverseDocument(tx, c, {
        documentId: x.invoiceId,
        effectiveDate: "2026-04-15",
        reason: "raised against the wrong customer",
        jobs: recordingJobs(),
      }),
    );
    expect(await x.tie("2026-03-31")).toBe("0.0000");
    expect(await x.tie("2026-04-30")).toBe("0.0000");
  });
});

describe("B3 — the ageing nets reversal chains set-based, and each rebuild evaluates its function once", () => {
  let party: string;
  const post = async (
    code: string,
    on: string,
    lines: Parameters<typeof postFromPack>[2]["lines"],
  ) => (await postFromPack(db, s, { code, effectiveDate: on, partyId: party, lines })).documentId;
  const reverse = async (documentId: string, on: string) =>
    (
      await as(s, (tx, c) =>
        reverseDocument(tx, c, {
          documentId,
          effectiveDate: on,
          reason: "code review B3 chain",
          jobs: recordingJobs(),
        }),
      )
    ).reversalDocumentId;
  const ageingOf = async (asOf: string) =>
    (await as(s, (tx) => ageingRows(tx, { companyId: s.company, asOf })))
      .filter((r) => r.partyId === party)
      .map((r) => [r.bucket, r.amount]);

  beforeAll(async () => {
    // A party of its own (no payment term: due on its own date), so every figure below is this chain's.
    party = await seedParty(db, s, {
      kind: "customer",
      code: "B3-CUST",
      receivableAccountId: f.accountIds["1200"]!,
    });
    const bank = [
      { kind: "account" as const, accountId: f.accountIds["1100"]!, amount: "30.0000" },
    ];
    // A receipt, its reversal (the bounced cheque), the reversal of THAT (the re-deposit) and a third
    // reversal: depths 0, 1, 2, 3 — two netted pairs.
    const r0 = await post("RECEIPT", "2026-02-05", bank);
    const r1 = await reverse(r0, "2026-02-06");
    const r2 = await reverse(r1, "2026-02-07");
    await reverse(r2, "2026-02-09");
    // A PARTIAL credit note (a `returns` target of a still-posted invoice) and a FULL reversal of another.
    const { itemId } = await seedItem(db, s, { code: "B3-SV", kind: "service", trackLots: false });
    const invoiceId = await post("SALES_INVOICE", "2026-02-10", [
      { kind: "item", itemId, quantity: "2.000000", unitPrice: "25.0000", amount: "50.0000" },
    ]);
    const [invoiceLine] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${invoiceId} order by line_no limit 1`;
    await as(s, async (tx, c) => {
      const cn = await creditNoteFrom(tx, c, {
        companyId: s.company,
        settledDocumentId: invoiceId,
        targetDocumentTypeId: f.documentTypeIds["SALES_CREDIT_NOTE"]!,
        targetSeries: "CN",
        effectiveDate: "2026-02-11",
        reason: "one unit returned",
        lines: [{ settledLineId: invoiceLine!.id, quantity: "1.000000" }],
      });
      await issueDocument(tx, c, { documentId: cn.documentId });
      await postDocument(tx, c, { documentId: cn.documentId });
    });
    const other = await post("SALES_INVOICE", "2026-02-12", [
      { kind: "account", accountId: f.accountIds["4000"]!, amount: "40.0000" },
    ]);
    await reverse(other, "2026-02-13");
  }, 300_000);

  it("app.document_netted_from_rows equals app.document_netted_from on every document of the company", async () => {
    const rows = await as(
      s,
      (tx) => tx<{ id: string; per_document: string | null; set_based: string | null }[]>`
        select d.id::text as id,
               to_char(app.document_netted_from(d.id), 'YYYY-MM-DD') as per_document,
               to_char(n.netted_from, 'YYYY-MM-DD') as set_based
          from app.document d
          left join app.document_netted_from_rows(${s.company}::uuid) n on n.document_id = d.id
         where d.company_id = ${s.company}`,
    );
    expect(rows.filter((r) => r.per_document !== r.set_based)).toEqual([]);
    // Not vacuous: the two receipt pairs, the reversed invoice and its reversal are netted, the partial note
    // and the re-deposit's live window are not.
    expect(rows.filter((r) => r.set_based !== null).length).toBeGreaterThanOrEqual(6);
    const [unlisted] = await as(
      s,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document_netted_from_rows(${s.company}::uuid) n
         where not exists (select 1 from app.document d where d.id = n.document_id and d.company_id = ${s.company})`,
    );
    expect(unlisted!.n).toBe(0);
  });

  it("the ageing through the chain reads as the per-document definition says, date by date", async () => {
    expect(await ageingOf("2026-02-05")).toEqual([["current", "-30.0000"]]); // r0 alone
    expect(await ageingOf("2026-02-06")).toEqual([]); // r0 netted with r1
    expect(await ageingOf("2026-02-07")).toEqual([["current", "-30.0000"]]); // the re-deposit r2
    expect(await ageingOf("2026-02-08")).toEqual([["1_30", "-30.0000"]]);
    expect(await ageingOf("2026-02-09")).toEqual([]); // r2 netted with r3
    expect(await ageingOf("2026-02-11")).toEqual([
      ["1_30", "50.0000"], // the invoice, still posted: the partial note does not net it
      ["current", "-25.0000"], // the partial note, an open item of its own
    ]);
    expect(await ageingOf("2026-02-12")).toEqual([
      ["1_30", "25.0000"],
      ["current", "40.0000"], // the second invoice, before its reversal
    ]);
    expect(await ageingOf("2026-02-13")).toEqual([["1_30", "25.0000"]]); // its full reversal nets it
  });

  it("each rebuild is ONE statement: it MERGEs and zeroes from one evaluation, and the job's compare reuses its rows", async () => {
    const asOf = "2026-02-12";
    const { itemId } = await seedItem(db, s, {
      code: "B3-STALE",
      kind: "service",
      trackLots: false,
    });
    // One stale non-zero key in each projection's scope, which no fresh computation produces.
    await as(s, async (tx) => {
      await tx`
        insert into app.party_ageing
          (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount)
        values (${s.tenant}, ${s.company}, ${party}, 'MYR', ${asOf}::date, 'over_90', 5, 5)`;
      await tx`
        insert into app.item_profitability
          (tenant_id, company_id, item_id, fiscal_period_id, quantity_sold, revenue_base, cogs_base, margin_base)
        values (${s.tenant}, ${s.company}, ${itemId}, ${s.period}, 1, 5, 2, 3)`;
    });
    const run = await as(s, async (tx) => {
      const ageing = await rebuildPartyAgeing(tx, { companyId: s.company, asOf });
      const profit = await rebuildItemProfitability(tx, { companyId: s.company });
      const compared = await comparePartyAgeing(tx, { companyId: s.company, asOf }, ageing.rows);
      return { ageing, profit, compared };
    });
    const fresh = await as(s, (tx) => ageingRows(tx, { companyId: s.company, asOf }));
    const freshProfit = await as(s, (tx) => itemProfitabilityRows(tx, { companyId: s.company }));
    // The rows handed back ARE the fresh function's, all of them were merged, the stale keys were zeroed…
    expect(run.ageing.rows).toEqual(fresh);
    expect(run.ageing).toMatchObject({ merged: fresh.length, zeroed: 1 });
    expect(run.profit).toEqual({ merged: freshProfit.length, zeroed: 1 });
    // …and the stored snapshot is exactly them, read back against the rows the rebuild wrote.
    expect(run.compared).toEqual([]);
    const stored = await as(
      s,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.party_ageing
         where company_id = ${s.company} and as_of = ${asOf}::date and (amount <> 0 or base_amount <> 0)`,
    );
    expect(stored[0]!.n).toBe(fresh.length);
    // The reused rows still catch a stored row that drifted, exactly as a fresh evaluation does.
    const drifted = await as(s, async (tx) => {
      await tx`
        update app.party_ageing set amount = amount + 1
         where company_id = ${s.company} and as_of = ${asOf}::date and party_id = ${party}
           and bucket = 'current'`;
      return {
        reused: await comparePartyAgeing(tx, { companyId: s.company, asOf }, fresh),
        evaluated: await comparePartyAgeing(tx, { companyId: s.company, asOf }),
      };
    });
    expect(drifted.reused).toHaveLength(1);
    expect(drifted.reused).toEqual(drifted.evaluated);
  });
});
