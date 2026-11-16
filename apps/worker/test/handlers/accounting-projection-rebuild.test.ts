import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  ageingRows,
  itemProfitabilityRows,
  JOBS,
  rebuildPartyAgeing,
  systemContext,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import { seedItem, seedTenantV2, seedWarehouse, uuidv7, type Seed } from "@dulja/db/test";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";
import { registeredJobNames } from "../../src/handler";
import { createAccountingProjectionRebuildHandler } from "../../src/handlers/accounting-projection-rebuild";
import { startWorker, type StartedWorker } from "../support/worker";

/**
 * `accounting.projection.rebuild` through the worker (4B Task 3): the SAME registration production performs,
 * driven by `runJob`, which resolves the tenant's system principal (`systemContext`) exactly as the nightly
 * `eachTenant` fan-out does.
 */
const NAME = "accounting.projection.rebuild" as const;
const MYR = currency("MYR");

describe("accounting.projection.rebuild through the worker", () => {
  let w: StartedWorker;
  let s: Seed;
  let f: ArApFixture;
  let second: string;

  const ctx = async (): Promise<TenantContext> => ({
    tenantId: s.tenant,
    actorId: s.human,
    requestId: await uuidv7(w.db.admin),
  });
  const run = async (payload: { companyId?: string; asOf?: string }) => {
    const requestId = await uuidv7(w.db.admin);
    await w.run(NAME, { tenantId: s.tenant, requestId, payload });
    return requestId;
  };
  const stored = async (companyId: string, asOf: string) =>
    withTenant(
      w.db.rw,
      await ctx(),
      (tx) => tx<
        { partyId: string; currency: string; bucket: string; amount: string; baseAmount: string }[]
      >`
        select party_id::text as "partyId", currency::text as currency, bucket,
               amount::text as amount, base_amount::text as "baseAmount"
          from app.party_ageing
         where company_id = ${companyId} and as_of = ${asOf}::date and (amount <> 0 or base_amount <> 0)
         order by party_id, currency, bucket`,
    );
  const fresh = async (companyId: string, asOf: string) =>
    withTenant(w.db.rw, await ctx(), (tx) => ageingRows(tx, { companyId, asOf }));
  const incidents = async (requestId: string) =>
    withTenant(
      w.db.rw,
      await ctx(),
      (tx) => tx<
        { actor_id: string; after: { projections: { checked: string[]; mismatches: unknown[] } } }[]
      >`
        select actor_id::text as actor_id, after from app.audit_log
         where tenant_id = ${s.tenant} and table_name = 'integrity_incident' and row_id = ${requestId}`,
    );

  beforeAll(async () => {
    w = await startWorker();
    s = await seedTenantV2(w.db, "WorkerAgeing");
    f = await arApFixture(w.db, s);
    // A second company in the same tenant, with no documents: the handler's fan-out is over companies, one
    // transaction each, and a company with nothing open merges nothing.
    second = await uuidv7(w.db.admin);
    await withTenant(
      w.db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(w.db.admin) },
      (tx) => tx`
        insert into app.company (id, tenant_id, code, name, base_currency)
        values (${second}, ${s.tenant}, 'ZZ', 'Second company', 'MYR')`,
    );

    const { documentId: invoiceId } = await postFromPack(w.db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-03-02",
      partyId: f.partyIds.customer,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "500.0000" }],
    });
    await postFromPack(w.db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-04-10",
      partyId: f.partyIds.customer,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount: "200.0000" }],
      allocate: [{ settledDocumentId: invoiceId, amount: Money.of("200.0000", MYR) }],
    });
    await postFromPack(w.db, s, {
      code: "PURCHASE_INVOICE",
      effectiveDate: "2026-04-20",
      partyId: f.partyIds.vendor,
      lines: [{ kind: "account", accountId: f.accountIds["5900"]!, amount: "120.0000" }],
    });
  }, 600_000);
  afterAll(async () => {
    await w.stop();
  });

  it("is registered under its JOBS name, which is scheduled nightly", () => {
    expect(registeredJobNames()).toContain(NAME);
    expect(JOBS[NAME].schedule).toBe("0 3 * * *");
  });

  it("rebuilds every company's snapshot as of the payload date, one log line per company, and records no incident", async () => {
    const requestId = await run({ asOf: "2026-04-30" });

    const rows = await stored(s.company, "2026-04-30");
    expect(rows).toEqual(await fresh(s.company, "2026-04-30"));
    // Invoice 500 − 200 allocated, due 2026-04-01 → 1_30; the bill 120, due 2026-05-20 → current.
    expect(rows.map((r) => [r.partyId, r.bucket, r.amount])).toEqual(
      [
        [f.partyIds.customer, "1_30", "300.0000"],
        [f.partyIds.vendor, "current", "120.0000"],
      ].toSorted((x, y) => (x[0]! < y[0]! ? -1 : 1)),
    );
    expect(await stored(second, "2026-04-30")).toEqual([]);

    const lines = w.logs.filter(
      (l) => l.fields["job"] === NAME && l.fields["as_of"] === "2026-04-30",
    );
    expect(lines.map((l) => [l.level, l.msg, l.fields["company_id"], l.fields["merged"]])).toEqual(
      [
        ["info", "party ageing rebuilt", s.company, 2],
        ["info", "party ageing rebuilt", second, 0],
      ].toSorted((x, y) => (String(x[2]) < String(y[2]) ? -1 : 1)),
    );
    expect(lines.every((l) => l.fields["tenant_id"] === s.tenant)).toBe(true);
    expect(await incidents(requestId)).toEqual([]);
  });

  it("companyId narrows the run to that one company", async () => {
    await run({ companyId: s.company, asOf: "2026-04-15" });
    const lines = w.logs.filter(
      (l) => l.fields["job"] === NAME && l.fields["as_of"] === "2026-04-15",
    );
    expect(lines.map((l) => l.fields["company_id"])).toEqual([s.company]);
    expect(await stored(s.company, "2026-04-15")).toEqual(await fresh(s.company, "2026-04-15"));
  });

  it("asOf defaults to the run date, and a stale key of that date is zeroed, never deleted", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // 31_60: a bucket neither party has on any run date after this fixture (the bill of 2026-04-20 is due
    // 2026-05-20, so from late June both open items sit in over_90).
    await withTenant(
      w.db.rw,
      await ctx(),
      (tx) => tx`
        insert into app.party_ageing (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount)
        values (${s.tenant}, ${s.company}, ${f.partyIds.vendor}, 'MYR', ${today}::date, '31_60', 9, 9)`,
    );
    await run({});
    expect(await stored(s.company, today)).toEqual(await fresh(s.company, today));
    const [stale] = await withTenant(
      w.db.rw,
      await ctx(),
      (tx) => tx<{ amount: string }[]>`
        select amount::text as amount from app.party_ageing
         where company_id = ${s.company} and as_of = ${today}::date
           and party_id = ${f.partyIds.vendor} and bucket = '31_60'`,
    );
    expect(stale).toEqual({ amount: "0.0000" });
    const line = w.logs.findLast(
      (l) =>
        l.fields["job"] === NAME &&
        l.fields["company_id"] === s.company &&
        l.msg === "party ageing rebuilt",
    );
    expect(line!.fields).toMatchObject({ as_of: today, zeroed: 1 });
  });

  it("a company whose rebuild throws is logged, the next company is still attempted, and ONE incident is recorded", async () => {
    // No data makes one company's rebuild throw and not another's, so the per-company rebuild is injected —
    // the production handler's own factory, with the first company (code HQ, ordered first) failing.
    const handler = createAccountingProjectionRebuildHandler({
      rebuild: async (tx, params) => {
        if (params.companyId === s.company) throw new Error("injected rebuild failure");
        return rebuildPartyAgeing(tx, params);
      },
    });
    const requestId = await uuidv7(w.db.admin);
    await handler(
      w.db.rw,
      { tenantId: s.tenant, requestId, payload: { asOf: "2026-04-20" } },
      await systemContext(w.db.rw, s.tenant, requestId),
    );
    const lines = w.logs.filter(
      (l) => l.fields["job"] === NAME && l.fields["as_of"] === "2026-04-20",
    );
    expect(lines.map((l) => [l.level, l.fields["company_id"]])).toEqual([
      ["error", s.company],
      ["info", second],
    ]);
    expect(await stored(s.company, "2026-04-20")).toEqual([]); // its transaction rolled back whole
    const recorded = await incidents(requestId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.actor_id).toBe(s.system); // the job ran as the tenant's system principal
    expect(recorded[0]!.after.projections.checked).toEqual(["party_ageing"]);
    expect(recorded[0]!.after.projections.mismatches).toEqual([
      {
        projection: "party_ageing",
        key: { company_id: s.company, as_of: "2026-04-20" },
        side: "amount_differs",
        detail: "rebuild threw: Error: injected rebuild failure",
      },
    ]);
  });

  it("rebuilds item_profitability in the same per-company transaction (4B Task 4), logged without an as_of", async () => {
    const { itemId, baseUnitId } = await seedItem(w.db, s, {
      code: "W-PROFIT",
      kind: "product",
      trackLots: false,
    });
    const warehouseId = await seedWarehouse(w.db, s, { code: "W-PROFIT" });
    const line = (quantity: string, unitPrice: string, amount: string) => ({
      kind: "item" as const,
      itemId,
      warehouseId,
      unitId: baseUnitId,
      quantity,
      unitPrice,
      amount,
    });
    await postFromPack(w.db, s, {
      code: "GOODS_RECEIPT",
      effectiveDate: "2026-01-05",
      partyId: f.partyIds.vendor,
      warehouseId,
      lines: [line("10.000000", "4.0000", "40.0000")],
    });
    await postFromPack(w.db, s, {
      code: "DELIVERY_ORDER",
      effectiveDate: "2026-01-06",
      partyId: f.partyIds.customer,
      warehouseId,
      lines: [line("3.000000", "9.0000", "27.0000")],
    });

    await run({ companyId: s.company, asOf: "2026-04-30" });
    const storedProfit = await withTenant(
      w.db.rw,
      await ctx(),
      (tx) => tx<
        {
          itemId: string;
          fiscalPeriodId: string;
          quantitySold: string;
          revenueBase: string;
          cogsBase: string;
          marginBase: string;
        }[]
      >`
        select item_id::text as "itemId", fiscal_period_id::text as "fiscalPeriodId",
               quantity_sold::text as "quantitySold", revenue_base::text as "revenueBase",
               cogs_base::text as "cogsBase", margin_base::text as "marginBase"
          from app.item_profitability where company_id = ${s.company}
         order by item_id, fiscal_period_id`,
    );
    const freshProfit = await withTenant(w.db.rw, await ctx(), (tx) =>
      itemProfitabilityRows(tx, { companyId: s.company }),
    );
    expect(storedProfit).toEqual(freshProfit);
    expect(storedProfit).toMatchObject([
      { itemId, quantitySold: "3.000000", revenueBase: "0.0000", cogsBase: "12.0000" },
    ]);
    const logged = w.logs.findLast(
      (l) => l.fields["job"] === NAME && l.msg === "item_profitability rebuilt",
    );
    expect(logged!.fields).toMatchObject({ company_id: s.company, merged: 1, zeroed: 0 });
    expect(logged!.fields["as_of"]).toBeUndefined(); // keyed by fiscal period, not by date
  });

  it("an item_profitability rebuild that throws names ITS projection in the incident and rolls the company back whole", async () => {
    const handler = createAccountingProjectionRebuildHandler({
      rebuildProfitability: async (_tx, params) => {
        if (params.companyId === s.company) throw new Error("injected profitability failure");
        return { merged: 0, zeroed: 0 };
      },
    });
    const requestId = await uuidv7(w.db.admin);
    await handler(
      w.db.rw,
      { tenantId: s.tenant, requestId, payload: { asOf: "2026-04-25" } },
      await systemContext(w.db.rw, s.tenant, requestId),
    );
    const errors = w.logs.filter(
      (l) => l.fields["job"] === NAME && l.fields["as_of"] === "2026-04-25" && l.level === "error",
    );
    expect(errors.map((l) => [l.msg, l.fields["company_id"], l.fields["projection"]])).toEqual([
      ["item_profitability rebuild failed for one company", s.company, "item_profitability"],
    ]);
    // One transaction per company: the ageing snapshot written before the throw rolled back with it.
    expect(await stored(s.company, "2026-04-25")).toEqual([]);
    const recorded = await incidents(requestId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.after.projections.mismatches).toEqual([
      {
        projection: "item_profitability",
        key: { company_id: s.company },
        side: "amount_differs",
        detail: "rebuild threw: Error: injected profitability failure",
      },
    ]);
  });

  it("a malformed asOf — or a date-shaped one that is not a calendar date — fails the job before anything is written", async () => {
    await expect(run({ asOf: "30/04/2026" })).rejects.toThrow(/asOf must be a calendar date/);
    // postgres.js would send 2026-02-30 as 2026-03-02 (`new Date(x).toISOString()`), so it must never
    // reach SQL.
    await expect(run({ asOf: "2026-02-30" })).rejects.toThrow(/asOf must be a calendar date/);
    expect(await stored(s.company, "2026-03-02")).toEqual([]);
  });
});
