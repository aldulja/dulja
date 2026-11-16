// apps/api/test/routes/accounting/review-4a.test.ts — the Phase 4 review's confirmed findings at the API
// (S1 branch authority on every settled document, S3 the credit note's issue code, A8's and B1's 409s), each
// written to fail against the tree it was found on. The data-layer findings are in
// packages/db/test/ar-ap/review-4a.test.ts and review-4b.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AllocateSettlementResultSchema, SettlementResultSchema } from "@dulja/contracts";
import { issueDocument, postDocument } from "@dulja/db";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedBranch,
  seedDocumentType,
  seedItem,
  seedParty,
  seedPaymentTerm,
  seedTenantV2,
  withTenant,
  type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories up.
import { problemOf } from "../../../../../tests/support/api";
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let branch2: string;
let invType: string;
let cnType: string;
let rctType: string;
let partyId: string;
let bankId: string;
let serviceItem: string;

const CONTROL = (side: "debit" | "credit", kind: "account" | "item") => ({
  for: "each_line",
  side,
  account: { from: "party.receivable_account" },
  amount: "line.total_incl_tax",
  when: { "line.kind": kind },
});
const OTHER = (side: "debit" | "credit", kind: "account" | "item") => ({
  for: "each_line",
  side,
  account: kind === "item" ? { from: "item.revenue_account" } : { from: "line.account" },
  amount: kind === "item" ? "line.amount" : "line.total_incl_tax",
  when: { "line.kind": kind },
});
const BASE = {
  version: 1,
  inventory: { effect: "none" },
  tax: { applies: false },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};
/** SALES_INVOICE's two ledger shapes (item and account lines), with SALES_INVOICE's own approval block. */
const INVOICE_POLICY = {
  ...BASE,
  documentType: "R4A_INVOICE",
  direction: "outbound",
  requires: ["party"],
  lines: [
    CONTROL("debit", "item"),
    OTHER("credit", "item"),
    CONTROL("debit", "account"),
    OTHER("credit", "account"),
  ],
  numbering: { series: "RINV", assignAt: "issue" },
  reversal: { allowed: true, producesType: "R4A_CREDIT_NOTE" },
  approval: {
    required: false,
    approve: null,
    post: "accounting.sales.post",
    create: "accounting.sales.create",
  },
};
/** SALES_CREDIT_NOTE over it: the invoice's sides, `reverses_document` required, the pack's approval block —
 *  create `accounting.sales.create`, post `accounting.sales.post`. */
const CREDIT_NOTE_POLICY = {
  ...INVOICE_POLICY,
  documentType: "R4A_CREDIT_NOTE",
  direction: "inbound",
  requires: ["party", "reverses_document"],
  numbering: { series: "RCN", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
};
/** RECEIPT's shape and approval block. */
const RECEIPT_POLICY = {
  ...BASE,
  documentType: "RECEIPT",
  direction: "inbound",
  requires: ["party"],
  lines: [OTHER("debit", "account"), CONTROL("credit", "account")],
  numbering: { series: "RCT", assignAt: "issue" },
  reversal: { allowed: true, producesType: "RECEIPT" },
  approval: {
    required: false,
    approve: null,
    post: "accounting.receipt.post",
    create: "accounting.receipt.create",
  },
};

const ctx = () => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});
const docPath = (documentId: string, tail: string) =>
  `/v1/companies/${s.company}/documents/${documentId}/${tail}`;
const line = (settledDocumentId: string, amount: string) => ({
  settledDocumentId,
  amount: { amount, currency: "MYR" },
});

/** Draft, issue and post a one-account-line document of `typeId` at `branchId`, as the fixture owner. */
async function posted(
  typeId: string,
  series: string,
  amount: string,
  branchId: string,
  paymentTermId: string | null = null,
): Promise<string> {
  const accountId = typeId === rctType ? bankId : s.sales;
  const { documentId, lineIds } = await draftTypedDocument(api.db, s, {
    documentTypeId: typeId,
    series,
    effectiveDate: "2026-01-15",
    partyId,
    branchId,
    lines: [{ kind: "account", accountId, description: "line", amount }],
  });
  await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
    await tx`update app.document_line set total_incl_tax = ${amount} where id = ${lineIds[0]!}`;
    await tx`update app.document set rate_source = ${"unit"}, payment_term_id = ${paymentTermId}
              where id = ${documentId}`;
    await issueDocument(tx, ctx(), { documentId });
    await postDocument(tx, ctx(), { documentId });
  });
  return documentId;
}

/** A principal holding `codes` at the head office ONLY (`role_assignment_branch`). */
async function hqOnly(label: string, codes: readonly string[]): Promise<string> {
  const id = await secondPrincipal(api.db, s, label);
  await grantCodes(api.db, s, { codes, principalId: id, roleCode: label, branchIds: [s.hq] });
  // Row visibility at B must not supply the receipt authority held only at HQ.
  await grantCodes(api.db, s, {
    principalId: id,
    branchIds: [branch2],
    roleCode: `${label}-visibility`,
  });
  await api.loadPrincipals();
  return id;
}

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "review-4a-api");
  await seedAccount(api.db, s, { code: "1200", nameEn: "Trade receivables", type: "asset" });
  bankId = await seedAccount(api.db, s, { code: "1100", nameEn: "Bank", type: "asset" });
  branch2 = await seedBranch(api.db, s, { code: "BR2", nameEn: "Second branch" });
  invType = await seedDocumentType(api.db, s, {
    code: "R4A_INVOICE",
    module: "accounting",
    policy: INVOICE_POLICY,
  });
  cnType = await seedDocumentType(api.db, s, {
    code: "R4A_CREDIT_NOTE",
    module: "accounting",
    policy: CREDIT_NOTE_POLICY,
  });
  rctType = await seedDocumentType(api.db, s, {
    code: "RECEIPT",
    module: "accounting",
    policy: RECEIPT_POLICY,
  });
  partyId = await seedParty(api.db, s, { kind: "customer", code: "R4A-CUST" });
  ({ itemId: serviceItem } = await seedItem(api.db, s, {
    code: "R4A-SV",
    kind: "service",
    trackLots: false,
  }));
  await grantCodes(api.db, s, {
    codes: [
      "accounting.sales.create",
      "accounting.sales.post",
      "accounting.receipt.create",
      "accounting.receipt.post",
      "accounting.ledger.read",
      "accounting.party.manage",
    ],
  });
}, 240_000);
afterAll(async () => {
  await api?.stop();
});

describe("S1 — a branch-restricted clerk allocates only against documents of branches it holds (spec:2166)", () => {
  it("POST …/allocations: an invoice of another branch is 403, one of the clerk's own branch is 201", async () => {
    const clerk = await hqOnly("r4a-alloc-clerk", ["accounting.receipt.create"]);
    const rct = await posted(rctType, "RCT", "20.0000", s.hq);
    const away = await posted(invType, "RINV", "10.0000", branch2);
    const home = await posted(invType, "RINV", "10.0000", s.hq);
    const refused = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: clerk,
      body: { lines: [line(home, "10.0000"), line(away, "10.0000")] },
    });
    expect(refused.status).toBe(403);
    const problem = await problemOf(refused);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toMatch(/accounting\.receipt\.create/);
    const allowed = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: clerk,
      body: { lines: [line(home, "10.0000")] },
    });
    expect(allowed.status).toBe(201);
  });

  it("POST …/unallocate: an allocation against another branch's invoice is 403 to the clerk", async () => {
    const clerk = await hqOnly("r4a-unalloc-clerk", ["accounting.receipt.create"]);
    const rct = await posted(rctType, "RCT", "7.0000", s.hq);
    const away = await posted(invType, "RINV", "7.0000", branch2);
    const made = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: s.human,
      body: { lines: [line(away, "7.0000")] },
    });
    expect(made.status).toBe(201);
    const { allocationIds } = AllocateSettlementResultSchema.parse(await made.json());
    const refused = await api.request({
      method: "POST",
      path: docPath(rct, `allocations/${allocationIds[0]}/unallocate`),
      as: clerk,
      body: { reason: "not mine to undo" },
    });
    expect(refused.status).toBe(403);
    expect((await problemOf(refused)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("POST …/documents/settlements with allocations: another branch's invoice is 403, nothing is posted", async () => {
    const clerk = await hqOnly("r4a-settle-clerk", [
      "accounting.receipt.create",
      "accounting.receipt.post",
    ]);
    const away = await posted(invType, "RINV", "5.0000", branch2);
    const body = {
      documentTypeCode: "RECEIPT",
      series: "RCT",
      effectiveDate: "2026-01-15",
      partyId,
      bankAccountId: bankId,
      branchId: s.hq,
      currency: "MYR",
      exchangeRate: "1.00000000",
      amount: "5.0000",
      reference: "S1",
      allocations: [{ settledDocumentId: away, amount: "5.0000" }],
    };
    const refused = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/settlements`,
      as: clerk,
      body,
    });
    expect(refused.status).toBe(403);
    expect((await problemOf(refused)).code).toBe("ERR_RBAC_FORBIDDEN");
    const [open] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.allocation where settled_document_id = ${away}`,
    );
    expect(open!.n).toBe(0);
    // …and with an invoice of its own branch the same clerk posts and allocates.
    const home = await posted(invType, "RINV", "5.0000", s.hq);
    const allowed = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/settlements`,
      as: clerk,
      body: { ...body, allocations: [{ settledDocumentId: home, amount: "5.0000" }] },
    });
    expect(allowed.status).toBe(201);
    expect(SettlementResultSchema.parse(await allowed.json()).allocationIds).toHaveLength(1);
  });
});

describe("S3 — issuing the credit note needs the credit note's issue code", () => {
  it("a clerk holding only accounting.sales.create is 403 on accounting.sales.post, and nothing is drafted", async () => {
    const { documentId: inv, lineIds } = await draftTypedDocument(api.db, s, {
      documentTypeId: invType,
      series: "RINV",
      effectiveDate: "2026-01-15",
      partyId,
      lines: [
        {
          kind: "item",
          itemId: serviceItem,
          quantity: "2.000000",
          unitPrice: "5.0000",
          amount: "10.0000",
        },
      ],
    });
    await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
      await tx`update app.document_line set total_incl_tax = ${"10.0000"} where id = ${lineIds[0]!}`;
      await tx`update app.document set rate_source = ${"unit"} where id = ${inv}`;
      await issueDocument(tx, ctx(), { documentId: inv });
      await postDocument(tx, ctx(), { documentId: inv });
    });
    const clerk = await secondPrincipal(api.db, s, "r4a-cn-clerk");
    await grantCodes(api.db, s, {
      codes: ["accounting.sales.create"],
      principalId: clerk,
      roleCode: "r4a-cn-clerk",
    });
    await api.loadPrincipals();
    const body = {
      targetDocumentTypeId: cnType,
      targetSeries: "RCN",
      effectiveDate: "2026-01-16",
      reason: "one unit short",
      lines: [{ settledLineId: lineIds[0], quantity: "1.000000" }],
    };
    const refused = await api.request({
      method: "POST",
      path: docPath(inv, "credit-note"),
      as: clerk,
      body,
    });
    expect(refused.status).toBe(403);
    expect((await problemOf(refused)).detail).toMatch(
      /accounting\.sales\.post is required to issue a R4A_CREDIT_NOTE/,
    );
    const [notes] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document where reverses_document_id = ${inv}`,
    );
    expect(notes!.n).toBe(0);
    // The owner, who holds the post code, issues the same note.
    const allowed = await api.request({
      method: "POST",
      path: docPath(inv, "credit-note"),
      as: s.human,
      body,
    });
    expect(allowed.status).toBe(201);
  });
});

describe("A8 — PATCH of a pinned term's days is 409", () => {
  it("is 409 ERR_CONFLICT_REFERENCE once a posted document pins the term, and a rename is still 200", async () => {
    const term = await seedPaymentTerm(api.db, s, { code: "R4A-N30", dueDays: 30 });
    await posted(invType, "RINV", "3.0000", s.hq, term);
    const path = `/v1/companies/${s.company}/payment-terms/${term}`;
    const refused = await api.request({
      method: "PATCH",
      path,
      as: s.human,
      body: { dueDays: 60 },
    });
    expect(refused.status).toBe(409);
    expect((await problemOf(refused)).code).toBe("ERR_CONFLICT_REFERENCE");
    const renamed = await api.request({
      method: "PATCH",
      path,
      as: s.human,
      body: { nameEn: "Net thirty" },
    });
    expect(renamed.status).toBe(200);
  });
});

describe("B1 — PATCH of a posted party's control account is 409", () => {
  it("is 409 ERR_CONFLICT_REFERENCE, and nothing about the party changed", async () => {
    const p = await seedParty(api.db, s, { kind: "customer", code: "R4A-B1" });
    const alt = await seedAccount(api.db, s, {
      code: "1201",
      nameEn: "Other receivables",
      type: "asset",
    });
    const path = `/v1/companies/${s.company}/parties/${p}`;
    // Before anything is posted the account is the party's to change.
    const early = await api.request({
      method: "PATCH",
      path,
      as: s.human,
      body: { receivableAccountId: alt },
    });
    expect(early.status).toBe(200);
    const [control] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<{ id: string }[]>`select receivable_account_id as id from app.party where id = ${p}`,
    );
    const { documentId, lineIds } = await draftTypedDocument(api.db, s, {
      documentTypeId: invType,
      series: "RINV",
      effectiveDate: "2026-01-15",
      partyId: p,
      lines: [{ kind: "account", accountId: s.sales, description: "line", amount: "4.0000" }],
    });
    await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
      await tx`update app.document_line set total_incl_tax = ${"4.0000"} where id = ${lineIds[0]!}`;
      await tx`update app.document set rate_source = ${"unit"} where id = ${documentId}`;
      await issueDocument(tx, ctx(), { documentId });
      await postDocument(tx, ctx(), { documentId });
    });
    const back = await seedAccount(api.db, s, {
      code: "1200",
      nameEn: "Trade receivables",
      type: "asset",
    });
    const refused = await api.request({
      method: "PATCH",
      path,
      as: s.human,
      body: { receivableAccountId: back, nameEn: "Renamed" },
    });
    expect(refused.status).toBe(409);
    expect((await problemOf(refused)).code).toBe("ERR_CONFLICT_REFERENCE");
    const [after] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string; name: string }[]>`
        select receivable_account_id as id, name_en as name from app.party where id = ${p}`,
    );
    expect(after!.id).toBe(control!.id);
    expect(after!.name).not.toBe("Renamed");
    // A PATCH that leaves the account alone still edits the party.
    const renamed = await api.request({
      method: "PATCH",
      path,
      as: s.human,
      body: { nameEn: "Renamed" },
    });
    expect(renamed.status).toBe(200);
  });
});
