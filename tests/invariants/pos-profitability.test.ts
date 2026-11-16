import { beforeAll, describe, expect, it } from "vitest";
import { itemProfitabilityRows, rebuildItemProfitability, withTenant } from "@dulja/db";
import { sharedApi } from "../support/api";
import { buildTicket, posFixture, syncRequest, uuidv7Sync, type PosFixture } from "./support/pos";
import type { Ticket } from "@dulja/sync";
import type { StartedApi } from "../../apps/api/test/support/app";

describe("POS sale and return use the existing item profitability projection", () => {
  let api: StartedApi;
  let f: PosFixture;
  beforeAll(async () => {
    ({ api } = await sharedApi());
    f = await posFixture(api, "POS-PROFIT");
  }, 240_000);

  const push = async (ticket: Ticket) => {
    const response = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: {
        terminalId: f.terminal.terminalId,
        batchId: uuidv7Sync(),
        tickets: [ticket],
        shifts: [],
        tillEvents: [],
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ status: "accepted" }] });
  };

  it("ties remaining quantity, revenue and carrying cost after a partial refund, and rebuilds identically", async () => {
    const sale = buildTicket(f, { quantity: "2.000000", unitPrice: "50.0000" });
    await push(sale);
    const refund = buildTicket(f, {
      kind: "return",
      quantity: "1.000000",
      unitPrice: "50.0000",
      returnsClientRef: sale.clientRef,
    });
    // Half of the immutable sale net 90.0901 rounds to 45.0451; a fresh quotient would lose its residue.
    refund.lines[0]!.taxAmount.amount = "-4.9549";
    await push(refund);

    await withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.s.system, requestId: "pos-profitability" },
      async (tx) => {
        const fresh = await itemProfitabilityRows(tx, { companyId: f.s.company });
        expect(fresh).toEqual([
          {
            itemId: f.items["SKU-A"]!.itemId,
            fiscalPeriodId: expect.any(String),
            quantitySold: "1.000000",
            revenueBase: "45.0450",
            cogsBase: "30.0000",
            marginBase: "15.0450",
          },
        ]);
        await rebuildItemProfitability(tx, { companyId: f.s.company });
        const stored = await tx`
          select item_id as "itemId", fiscal_period_id as "fiscalPeriodId",
            quantity_sold::text as "quantitySold", revenue_base::text as "revenueBase",
            cogs_base::text as "cogsBase", margin_base::text as "marginBase"
          from app.item_profitability where company_id=${f.s.company}`;
        expect([...stored]).toEqual(fresh);
        await rebuildItemProfitability(tx, { companyId: f.s.company });
        const repeated = await tx`
          select item_id as "itemId", fiscal_period_id as "fiscalPeriodId",
            quantity_sold::text as "quantitySold", revenue_base::text as "revenueBase",
            cogs_base::text as "cogsBase", margin_base::text as "marginBase"
          from app.item_profitability where company_id=${f.s.company}`;
        expect([...repeated]).toEqual([...stored]);
      },
    );
  });
});
