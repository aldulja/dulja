import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch, ageingTieOut, withTenant } from "@dulja/db";
import { startApi, type StartedApi } from "../../support/app";
import {
  buildTicket,
  posFixture,
  uuidv7Sync,
  type PosFixture,
} from "../../../../../tests/invariants/support/pos";
import { recordingJobs } from "../../../../../tests/invariants/support/post-inventory";

/**
 * A referenced POS return settles the way its sale did (ADR 0056, 2026-10-22; Plan Contracts' Phase 6 account
 * correction): a sale debited to the customer's account is credited back to it with no tender, and a paid sale
 * is refunded through tenders. The till (`returnTicket`) produces only those two shapes; the server refuses the
 * crossed ones, so a refund can never leave the customer holding both the money and the debt.
 */
describe("referenced returns settle the way their sale did", () => {
  let api: StartedApi;
  let f: PosFixture;
  beforeAll(async () => {
    api = await startApi();
    f = await posFixture(api, "AccountReturns");
  }, 240_000);
  afterAll(async () => api.stop());

  const apply = (tickets: ReturnType<typeof buildTicket>[]) =>
    withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "account-returns" },
      (tx) =>
        applyBatch(
          tx,
          { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "account-returns" },
          {
            terminalId: f.terminal.terminalId,
            companyId: f.s.company,
            branchId: f.s.hq,
            principalId: f.terminal.principalId,
            jobs: recordingJobs(),
          },
          {
            terminalId: f.terminal.terminalId,
            batchId: uuidv7Sync(),
            tickets,
            shifts: [],
            tillEvents: [],
          },
        ),
    );
  const accepted = async (ticket: ReturnType<typeof buildTicket>) => {
    const out = (await apply([ticket])).results[0]!;
    expect(out.status, JSON.stringify(out)).toBe("accepted");
    return out;
  };
  const customer = async () =>
    (
      await api.db.admin<
        { id: string }[]
      >`select id from app.party where company_id=${f.s.company} and code='TAXCUST'`
    )[0]!.id;
  const receivable = async (documentIds: string[]) =>
    (
      await api.db.admin<{ debit: string; credit: string }[]>`
        select coalesce(sum(debit), 0)::numeric(19, 4)::text as debit,
               coalesce(sum(credit), 0)::numeric(19, 4)::text as credit
          from app.ledger_entry
         where document_id = any(${documentIds}::uuid[]) and account_id = ${f.accounts["1200"]!}`
    )[0]!;

  it("a zero-tender return of an account sale credits the customer's receivable, and AR ties out", async () => {
    const id = await customer();
    const source = buildTicket(f, { accountSale: true, customerId: id });
    const sale = await accepted(source);
    const refund = buildTicket(f, {
      kind: "return",
      returnsClientRef: source.clientRef,
      customerId: id,
      accountSale: true,
    });
    const ret = await accepted(refund);
    expect(await receivable([ret.documentId!])).toEqual({ debit: "0.0000", credit: "50.0000" });
    expect(await receivable([sale.documentId!, ret.documentId!])).toEqual({
      debit: "50.0000",
      credit: "50.0000",
    });
    const [settlement] = await api.db.admin<{ debit: string; credit: string }[]>`
      select debit::text, credit::text from app.document_line
       where document_id = ${ret.documentId!} and kind = 'account'`;
    expect(settlement).toEqual({ debit: "0.0000", credit: "50.0000" });
    const rows = await withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.s.system, requestId: "tie-out" },
      (tx) => ageingTieOut(tx, { companyId: f.s.company, asOf: "2026-12-31" }),
    );
    expect(
      rows.every((r) => r.difference === "0.0000"),
      JSON.stringify(rows),
    ).toBe(true);
  });

  it("refuses a tendered refund of an account sale", async () => {
    const id = await customer();
    const source = buildTicket(f, { accountSale: true, customerId: id });
    await accepted(source);
    const out = (
      await apply([
        buildTicket(f, { kind: "return", returnsClientRef: source.clientRef, customerId: id }),
      ])
    ).results[0]!;
    expect(out.status).toBe("rejected");
    expect(out.error?.code).toBe("ERR_VALIDATION_FAILED");
    expect(out.error?.detail).toContain("refunded to the customer's account");
  });

  it("refuses an account credit for a paid sale, and still refunds it through a tender", async () => {
    const id = await customer();
    const source = buildTicket(f, { customerId: id });
    await accepted(source);
    const out = (
      await apply([
        buildTicket(f, {
          kind: "return",
          returnsClientRef: source.clientRef,
          customerId: id,
          accountSale: true,
        }),
      ])
    ).results[0]!;
    expect(out.status).toBe("rejected");
    expect(out.error?.code).toBe("ERR_VALIDATION_FAILED");
    expect(out.error?.detail).toContain("refunded through tenders");
    const ret = await accepted(
      buildTicket(f, { kind: "return", returnsClientRef: source.clientRef, customerId: id }),
    );
    expect(await receivable([ret.documentId!])).toEqual({ debit: "0.0000", credit: "0.0000" });
  });
});
