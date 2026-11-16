// apps/api/test/routes/accounting/code-review-a.test.ts — code review 2026-09-29, stream A: the route-level
// findings (A4, A8, A9), each written to fail against the tree it was found on (33d5e4d) and pass against the
// fix. The data-layer halves are in packages/db/test/ar-ap/code-review-a.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCursor } from "@dulja/contracts";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedParty,
  seedPaymentTerm,
  seedTenantV2,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories up.
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let customerId: string;
let termId: string;
let bankId: string;

/** A one-line account-kind sale: the shape of SALES_INVOICE's account rule (the pack is packages/db's). */
const SALE_POLICY = {
  version: 1,
  documentType: "CR_A_SALE",
  direction: "outbound",
  requires: ["party"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "party.receivable_account" },
      amount: "line.total_incl_tax",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "line.account" },
      amount: "line.amount",
      when: { "line.kind": "account" },
    },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "CRS", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: {
    required: false,
    approve: null,
    post: "accounting.sales.post",
    create: "accounting.sales.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};

/** RECEIPT.json's shape, inline for the same reason (settlements.test.ts states it). */
const RECEIPT_POLICY = {
  version: 1,
  documentType: "RECEIPT",
  direction: "inbound",
  requires: ["party"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "line.account" },
      amount: "line.total_incl_tax",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "party.receivable_account" },
      amount: "line.total_incl_tax",
      when: { "line.kind": "account" },
    },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "RCT", assignAt: "issue" },
  reversal: { allowed: true, producesType: "RECEIPT" },
  approval: {
    required: false,
    approve: null,
    post: "accounting.receipt.post",
    create: "accounting.receipt.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};

const receiptBody = (allocations: unknown[]) => ({
  documentTypeCode: "RECEIPT",
  series: "RCT",
  effectiveDate: "2026-01-15",
  partyId: customerId,
  bankAccountId: bankId,
  branchId: s.hq,
  currency: "MYR",
  exchangeRate: "1.00000000",
  amount: "10.0000",
  allocations,
});

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "code-review-a-api");
  bankId = await seedAccount(api.db, s, { code: "1100", nameEn: "Bank", type: "asset" });
  await seedAccount(api.db, s, { code: "1200", nameEn: "Trade receivables", type: "asset" });
  await seedDocumentType(api.db, s, {
    code: "CR_A_SALE",
    module: "accounting",
    policy: SALE_POLICY,
  });
  await seedDocumentType(api.db, s, {
    code: "RECEIPT",
    module: "accounting",
    policy: RECEIPT_POLICY,
  });
  await grantCodes(api.db, s, {
    codes: [
      "accounting.sales.create",
      "accounting.sales.post",
      "accounting.receipt.create",
      "accounting.receipt.post",
      "accounting.party.manage",
    ],
  });
  termId = await seedPaymentTerm(api.db, s, { code: "NET30", dueDays: 30 });
  customerId = await seedParty(api.db, s, { kind: "customer", code: "CR-A-API-CUST" });
  await withTenant(
    api.db.rw,
    s.tenant,
    s.human,
    (tx) => tx`update app.party set payment_term_id = ${termId} where id = ${customerId}`,
  );
}, 240_000);
afterAll(async () => {
  await api.stop();
});

describe("A4 — the generic draft pins the party's payment term", () => {
  it("POST …/documents with a party pins party.payment_term_id, so the due date is the term's", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "CR_A_SALE",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: s.hq,
        partyId: customerId,
        lines: [
          {
            lineNo: 1,
            kind: "account",
            accountId: s.sales,
            amount: "100.0000",
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const doc = (await res.json()) as { paymentTermId: string | null; dueDate: string | null };
    expect(doc.paymentTermId).toBe(termId);
    expect(doc.dueDate).toBe("2026-02-14");
  });

  it("a draft with no party pins no term", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "CR_A_SALE",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: s.hq,
        lines: [{ lineNo: 1, kind: "account", accountId: s.sales, amount: "1.0000" }],
      },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { paymentTermId: string | null }).paymentTermId).toBeNull();
  });
});

describe("A8 — an allocation body is bounded", () => {
  const lines = async (n: number) => {
    const id = await uuidv7(api.db.admin);
    return Array.from({ length: n }, () => ({ settledDocumentId: id, amount: "1.0000" }));
  };

  it("POST …/settlements with 501 allocations is 400 before any lock is taken", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/settlements`,
      as: s.human,
      body: receiptBody(await lines(501)),
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("POST …/{documentId}/allocations with 501 lines is 400", async () => {
    const drafted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/settlements`,
      as: s.human,
      body: receiptBody([]),
    });
    expect(drafted.status).toBe(201);
    const { documentId } = (await drafted.json()) as { documentId: string };
    const settled = await uuidv7(api.db.admin);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/allocations`,
      as: s.human,
      body: {
        lines: Array.from({ length: 501 }, () => ({
          settledDocumentId: settled,
          amount: { amount: "1.0000", currency: "MYR" },
        })),
      },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });
});

describe("A9 — a malformed payment-term cursor is 400, as on every other keyset", () => {
  it("a cursor whose key is missing, a number, or whose id is not a uuid is refused", async () => {
    const id = await uuidv7(api.db.admin);
    for (const cursor of [
      encodeCursor({ k: [], id }),
      encodeCursor({ k: [42], id }),
      encodeCursor({ k: ["NET30", "extra"], id }),
      encodeCursor({ k: ["NET30"], id: "not-a-uuid" }),
    ]) {
      const res = await api.request({
        method: "GET",
        path: `/v1/companies/${s.company}/payment-terms?cursor=${cursor}`,
        as: s.human,
      });
      expect(res.status, cursor).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("the cursor the route itself hands out still pages", async () => {
    await seedPaymentTerm(api.db, s, { code: "NET45", dueDays: 45 });
    const first = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/payment-terms?limit=1`,
      as: s.human,
    });
    expect(first.status).toBe(200);
    const page = (await first.json()) as { next_cursor: string | null };
    expect(page.next_cursor).not.toBeNull();
    const next = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/payment-terms?limit=1&cursor=${page.next_cursor}`,
      as: s.human,
    });
    expect(next.status).toBe(200);
    expect(((await next.json()) as { items: { code: string }[] }).items.map((t) => t.code)).toEqual(
      ["NET45"],
    );
  });
});

// Code review 2 (Phase 4), M5-X / review finding F7: the refund refusal is the posting service's (step 6c),
// with POST …/documents asking the same helper as a pre-flight. On e8df83b the generic route answered 201 for
// a vendor RECEIPT and both transitions answered 200, crediting 1200 for a party whose open items are on 2100.
describe("F7 — the generic document route refuses a refund, at create and at post", () => {
  let vendorId: string;
  beforeAll(async () => {
    // seedParty gives the vendor BOTH control accounts, as POST …/parties allows; its control is 2100.
    vendorId = await seedParty(api.db, s, { kind: "vendor", code: "CR-F7-API-VEND" });
  });

  const documentsOf = async (partyId: string) =>
    api.db.admin<{ status: string; number: string | null; ledger: number }[]>`
      select d.status::text as status, d.number::text as number,
             (select count(*)::int from app.ledger_entry e where e.document_id = d.id) as ledger
        from app.document d where d.party_id = ${partyId}`;

  it("POST …/documents with a RECEIPT from a vendor is 400 ERR_VALIDATION_FAILED and writes no draft", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "RECEIPT",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: s.hq,
        partyId: vendorId,
        lines: [
          {
            lineNo: 1,
            kind: "account",
            accountId: bankId,
            amount: "100.0000",
          },
        ],
      },
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/RECEIPT posts to party\.receivable_account.*no posting rule/);
    expect(await documentsOf(vendorId)).toEqual([]);
  });

  it("a vendor RECEIPT drafted by another path is refused at POST …/transitions {to: posted}, spending no number", async () => {
    const [type] = await api.db.admin<{ id: string }[]>`
      select id from app.document_type where company_id = ${s.company} and code = 'RECEIPT'`;
    const { documentId, lineIds } = await draftTypedDocument(api.db, s, {
      documentTypeId: type!.id,
      series: "RCT",
      effectiveDate: "2026-01-15",
      partyId: vendorId,
      lines: [{ kind: "account", accountId: bankId, amount: "100.0000" }],
    });
    await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
      await tx`update app.document_line set total_incl_tax = 100.0000 where id = ${lineIds[0]!}`;
      await tx`update app.document set rate_source = 'unit' where id = ${documentId}`;
    });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/transitions`,
      as: s.human,
      body: { to: "posted" },
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/no posting rule/);
    expect(await documentsOf(vendorId)).toEqual([{ status: "draft", number: null, ledger: 0 }]);
  });

  it("control: a customer's RECEIPT still drafts through the generic route", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "RECEIPT",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: s.hq,
        partyId: customerId,
        lines: [
          {
            lineNo: 1,
            kind: "account",
            accountId: bankId,
            amount: "5.0000",
          },
        ],
      },
    });
    expect(res.status).toBe(201);
  });
});
