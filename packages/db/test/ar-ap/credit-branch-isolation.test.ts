import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueDocument, postDocument } from "../../src/posting";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedBranch,
  seedDocumentType,
  seedParty,
  seedPaymentTerm,
  seedTenantV2,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";

// DBS-04 and DBS-18 (full review 2026-11-15), ADR 0095, migration 0127: credit control and the two "pinned"
// guards on a party and a payment term compute over the whole COMPANY, whatever branches the acting
// principal is restricted to. Before 0127 they read app.document under the caller's RLS, and 0068's
// RESTRICTIVE branch_isolation hid every other branch's documents from a branch-restricted clerk.

let db: Db;
let s: Seed;
let crtType: string;
let brb: string;
let clerk: string;
let accountsReceivableAlt: string;

const ctxOf = (actor: string) => ({
  tenantId: s.tenant,
  actorId: actor,
  requestId: "00000000-0000-0000-0000-000000000000",
});

const CREDIT_TEST_POLICY = {
  version: 1,
  documentType: "CREDIT_TEST",
  direction: "outbound",
  requires: ["party"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "party.receivable_account" },
      amount: "line.total_incl_tax",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "4000" },
      amount: "line.amount",
      when: { "line.kind": "item" },
    },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "CRT", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.sales.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as const;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "credit-branch-isolation");
  await seedAccount(db, s, { code: "1200", nameEn: "Trade receivables", type: "asset" });
  await seedAccount(db, s, { code: "4000", nameEn: "Sales", type: "income" });
  accountsReceivableAlt = await seedAccount(db, s, {
    code: "1210",
    nameEn: "Other receivables",
    type: "asset",
  });
  await grantCodes(db, s, { codes: ["accounting.sales.post"] });
  crtType = await seedDocumentType(db, s, { code: "CREDIT_TEST", policy: CREDIT_TEST_POLICY });
  brb = await seedBranch(db, s, { code: "BRB", nameEn: "Branch B" });
  clerk = await secondPrincipal(db, s, "clerk-brb");
  await grantCodes(db, s, {
    codes: ["accounting.sales.post"],
    principalId: clerk,
    roleCode: "clerk-brb",
    branchIds: [brb],
  });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/** A CREDIT_TEST draft for `total` at `branchId`, drafted by the company-wide `s.human`. */
async function draft(partyId: string, total: string, branchId: string, paymentTermId?: string) {
  const { documentId } = await draftTypedDocument(db, s, {
    documentTypeId: crtType,
    series: "CRT",
    effectiveDate: "2026-01-10",
    partyId,
    branchId,
    lines: [
      {
        kind: "item",
        description: "widget",
        amount: total,
        unitPrice: total,
        quantity: "1.000000",
      },
    ],
  });
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`update app.document_line set total_incl_tax = ${total} where document_id = ${documentId}`;
    if (paymentTermId)
      await tx`update app.document set payment_term_id = ${paymentTermId} where id = ${documentId}`;
  });
  return documentId;
}

const issueAs = (actor: string, documentId: string) =>
  withTenant(db.rw, s.tenant, actor, (tx) => issueDocument(tx, ctxOf(actor), { documentId }));

describe("DBS-04 — credit control counts every branch of the company (ADR 0095, 0127)", () => {
  let partyId: string;
  beforeAll(async () => {
    partyId = await seedParty(db, s, { kind: "customer", code: "CUST-BRANCHES" });
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set credit_limit = ${"1000.0000"} where id = ${partyId}`,
    );
    // 900 issued at HQ by the company-wide principal: exposure 900 of 1,000.
    await issueAs(s.human, await draft(partyId, "900.0000", s.hq));
  });

  it("the branch-restricted clerk sees the company's exposure, not only branch BRB's", async () => {
    // The read creditStatus() shows on the credit screen — the same function the trigger compares.
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      clerk,
      (tx) =>
        tx<
          { v: string }[]
        >`select app.party_credit_exposure(${partyId}, null)::numeric(19,4)::text as v`,
    );
    expect(row!.v).toBe("900.0000");
  });

  it("a clerk restricted to branch BRB cannot issue 900 more without an override", async () => {
    const id = await draft(partyId, "900.0000", brb);
    await expect(issueAs(clerk, id)).rejects.toThrow(
      /ERR_CREDIT_LIMIT_EXCEEDED: party CUST-BRANCHES .* open 900\.0000/,
    );
  });

  it("a sale that fits under the company-wide exposure still issues at BRB", async () => {
    const id = await draft(partyId, "100.0000", brb);
    await issueAs(clerk, id);
    const [doc] = await db.admin<
      { status: string }[]
    >`select status::text from app.document where id = ${id}`;
    expect(doc!.status).toBe("issued");
  });
});

describe("DBS-18 — the pinned guards answer over the whole company (ADR 0095, 0127)", () => {
  it("a BRB-restricted principal cannot change the days of a term an HQ document pins", async () => {
    const termId = await seedPaymentTerm(db, s, { code: "NET45", dueDays: 45 });
    const partyId = await seedParty(db, s, { kind: "customer", code: "CUST-TERM" });
    await issueAs(s.human, await draft(partyId, "50.0000", s.hq, termId));
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        clerk,
        (tx) => tx`update app.payment_term set due_days = 60 where id = ${termId}`,
      ),
    ).rejects.toThrow(/ERR_CONFLICT_REFERENCE: payment term NET45/);
  });

  it("a BRB-restricted principal cannot re-point a party whose HQ document has posted", async () => {
    const partyId = await seedParty(db, s, { kind: "customer", code: "CUST-POSTED" });
    const id = await draft(partyId, "75.0000", s.hq);
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctxOf(s.human), { documentId: id }),
    );
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        clerk,
        (tx) =>
          tx`update app.party set receivable_account_id = ${accountsReceivableAlt} where id = ${partyId}`,
      ),
    ).rejects.toThrow(/ERR_CONFLICT_REFERENCE: party CUST-POSTED/);
  });
});
