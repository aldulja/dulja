import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { draftTypedDocument, grantCodes } from "@dulja/db/test";
import type { Ticket, BatchResult } from "@dulja/sync";
import type { StartedApi } from "../../apps/api/test/support/app";
import { sharedApi } from "../support/api";
import { buildTicket, posFixture, syncRequest, uuidv7Sync, type PosFixture } from "./support/pos";

async function ledgerMultiset(api: StartedApi, documentId: string): Promise<string[]> {
  const rows = await api.db.admin`
    select account_id, debit::text, credit::text, currency, exchange_rate::text,
      base_debit::text, base_credit::text, effective_date::text, fiscal_period_id
    from app.ledger_entry where document_id=${documentId}`;
  return rows.map((row) => JSON.stringify(row)).toSorted();
}

async function dimensionMultiset(api: StartedApi, documentId: string): Promise<string[]> {
  const rows = await api.db.admin<{ code: string; value: string }[]>`
    select dt.code, x.dimension_value_id::text as value from app.ledger_entry_dimension x
    join app.ledger_entry e on e.id=x.entry_id
    join app.dimension_value v on v.id=x.dimension_value_id
    join app.dimension_type dt on dt.id=v.dimension_type_id where e.document_id=${documentId}`;
  return rows.map((row) => `${row.code}:${row.value}`).toSorted();
}

async function consumptionMultiset(api: StartedApi, documentId: string): Promise<string[]> {
  const rows = await api.db.admin`
    select m.item_id, m.warehouse_id, m.lot_id, c.quantity::text, c.unit_cost::text, c.value::text
    from app.cost_consumption c join app.inventory_movement m on m.id=c.movement_id
    where m.document_id=${documentId}`;
  return rows.map((row) => JSON.stringify(row)).toSorted();
}

describe("acceptance 22 — terminal and human paths share the posting service", () => {
  let api: StartedApi;
  let f: PosFixture;
  let ticket: Ticket;
  let posId: string;
  let invoiceId: string;

  const push = async (sale: Ticket): Promise<BatchResult> => {
    const response = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: {
        terminalId: f.terminal.terminalId,
        batchId: uuidv7Sync(),
        tickets: [sale],
        shifts: [],
        tillEvents: [],
      },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as BatchResult;
    expect(result.results[0]).toMatchObject({ status: "accepted", error: null });
    return result;
  };

  beforeAll(async () => {
    ({ api } = await sharedApi());
    f = await posFixture(api, "OnePath");
    await grantCodes(api.db, f.s, { codes: ["accounting.sales.post"] });
    ticket = buildTicket(f, { quantity: "3.000000", unitPrice: "20.0000" });
    posId = (await push(ticket)).results[0]!.documentId!;
    // Use the persisted company-local date, including midnight in Malaysia.
    const [source] = await api.db.admin<{ effective_date: string }[]>`
      select effective_date::text from app.document where id=${posId}`;
    const item = ticket.lines[0]!;
    const lines = [
      {
        lineNo: 1,
        kind: "item" as const,
        itemId: item.itemId,
        warehouseId: f.warehouseId,
        unitId: item.unitId,
        quantity: item.quantity,
        unitQuantity: item.quantity,
        unitPrice: item.unitPrice.amount,
        discount: item.discount.amount,
        amount: item.total.amount,
        taxCodeId: item.taxCodeId!,
      },
      {
        lineNo: 2,
        kind: "tender" as const,
        amount: ticket.tenders[0]!.amount.amount,
        customFields: { method: "cash", reference: null },
      },
    ];
    ({ documentId: invoiceId } = await draftTypedDocument(api.db, f.s, {
      documentTypeId: f.types.POS_EQUIV_INVOICE!,
      series: "PEI",
      effectiveDate: source!.effective_date,
      warehouseId: f.warehouseId,
      branchId: f.s.hq,
      lines,
    }));
    await withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.s.human, requestId: "one-path-inclusive" },
      (tx) => tx`update app.document set tax_inclusive=true where id=${invoiceId}`,
    );
    // The normal draft writer computes tax; transitions post the resulting draft as the human.
    const replaced = await api.request({
      as: f.s.human,
      method: "PUT",
      path: `/v1/companies/${f.s.company}/documents/${invoiceId}/lines`,
      body: { lines },
    });
    expect(replaced.status, await replaced.clone().text()).toBe(200);
    const posted = await api.request({
      as: f.s.human,
      method: "POST",
      path: `/v1/companies/${f.s.company}/documents/${invoiceId}/transitions`,
      body: { to: "posted" },
    });
    expect(posted.status, await posted.clone().text()).toBe(200);
  }, 300_000);

  it("compares different document types, series and principal kinds", async () => {
    const rows = await api.db.admin<{ code: string; series: string; kind: string }[]>`
      select t.code,d.series,p.kind::text from app.document d
      join app.document_type t on t.id=d.document_type_id join app.principal p on p.id=d.posted_by
      where d.id in (${posId},${invoiceId})`;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.code).toSorted()).toEqual(["POS_EQUIV_INVOICE", "POS_TICKET"]);
    expect(new Set(rows.map((row) => row.series)).size).toBe(2);
    expect(rows.map((row) => row.kind).toSorted()).toEqual(["human", "terminal"]);
  });
  it("produces identical nonempty ledger multisets under hazard 18's projection", async () => {
    const pos = await ledgerMultiset(api, posId);
    expect(pos.length).toBeGreaterThan(0);
    expect(pos).toEqual(await ledgerMultiset(api, invoiceId));
  });
  it("produces identical nonempty branch-dimension multisets", async () => {
    const pos = await dimensionMultiset(api, posId);
    expect(pos.length).toBeGreaterThan(0);
    expect(pos.every((dimension) => dimension.startsWith("BRANCH:"))).toBe(true);
    expect(pos).toEqual(await dimensionMultiset(api, invoiceId));
  });
  it("consumes the same quantities and carrying costs through both paths", async () => {
    const pos = await consumptionMultiset(api, posId);
    expect(pos.length).toBeGreaterThan(0);
    expect(pos).toEqual(await consumptionMultiset(api, invoiceId));
  });
  it("pins different policies, which the comparison deliberately projects out", async () => {
    const rows = await api.db.admin<{ posting_policy_id: string }[]>`
      select posting_policy_id from app.document where id in (${posId},${invoiceId})`;
    expect(new Set(rows.map((row) => row.posting_policy_id)).size).toBe(2);
  });
  it("a referenced return creates a receipt layer at original carrying cost and consumes nothing", async () => {
    const refund = buildTicket(f, {
      kind: "return",
      quantity: "1.000000",
      unitPrice: "20.0000",
      returnsClientRef: ticket.clientRef,
    });
    const id = (await push(refund)).results[0]!.documentId!;
    const rows = await api.db.admin`
      select quantity::text,value::text from app.inventory_movement where document_id=${id}`;
    expect([...rows]).toEqual([{ quantity: "1.000000", value: "30.0000" }]);
    expect(await consumptionMultiset(api, id)).toEqual([]);
    const layers = await api.db.admin`
      select c.qty_remaining::text,c.unit_cost::text from app.cost_layer c
      join app.inventory_movement m on m.id=c.movement_id
      where m.document_id=${id} and c.invalidated_at is null`;
    expect([...layers]).toEqual([{ qty_remaining: "1.000000", unit_cost: "30.0000" }]);
  });
});
