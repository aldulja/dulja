import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueDocument } from "../src/posting";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedBranch,
  seedDocumentType,
  seedParty,
  seedTenantV2,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "./index";
import { secondPrincipal } from "../../../tests/invariants/support/post-inventory";

// DBS-07 = INV-08 (full review 2026-11-15), ADR 0095, migration 0127: the over-fulfilment guard (SAH-017)
// and app.document_open_quantity sum a source line's links over the whole COMPANY. Before 0127 the sum
// joined app.document under the caller's RLS, so a principal restricted to the source's branch did not see
// a fulfilment drafted in another branch and could link the same quantity again.

let db: Db;
let s: Seed;
let typeId: string;
let brb: string;
let hqClerk: string;
let partyId: string;

const ctxOf = (actor: string) => ({
  tenantId: s.tenant,
  actorId: actor,
  requestId: "00000000-0000-0000-0000-000000000000",
});

const ORDER_POLICY = {
  version: 1,
  documentType: "OQ_TEST",
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
  numbering: { series: "OQT", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.sales.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as const;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "open-quantity-branch-isolation");
  await seedAccount(db, s, { code: "1200", nameEn: "Trade receivables", type: "asset" });
  await seedAccount(db, s, { code: "4000", nameEn: "Sales", type: "income" });
  await grantCodes(db, s, { codes: ["accounting.sales.post"] });
  typeId = await seedDocumentType(db, s, { code: "OQ_TEST", policy: ORDER_POLICY });
  brb = await seedBranch(db, s, { code: "BRB", nameEn: "Branch B" });
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-OQ" });
  hqClerk = await secondPrincipal(db, s, "clerk-hq");
  await grantCodes(db, s, {
    codes: ["accounting.sales.post"],
    principalId: hqClerk,
    roleCode: "clerk-hq",
    branchIds: [s.hq],
  });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

const draft = (branchId: string, quantity: string) =>
  draftTypedDocument(db, s, {
    documentTypeId: typeId,
    series: "OQT",
    effectiveDate: "2026-01-10",
    partyId,
    branchId,
    lines: [
      { kind: "item", description: "widget", amount: "10.0000", unitPrice: "1.0000", quantity },
    ],
  });

const link = (
  actor: string,
  source: { documentId: string; lineIds: string[] },
  target: { documentId: string; lineIds: string[] },
  quantity: string,
) =>
  withTenant(
    db.rw,
    s.tenant,
    actor,
    (tx) => tx`
      insert into app.document_link
        (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id,
         link_kind, quantity)
      values (${s.tenant}, ${s.company}, ${source.documentId}, ${source.lineIds[0]!},
              ${target.documentId}, ${target.lineIds[0]!}, 'fulfils', ${quantity})`,
  );

describe("DBS-07 / INV-08 — a source line's links are summed over the whole company (ADR 0095, 0127)", () => {
  let order: { documentId: string; lineIds: string[] };

  beforeAll(async () => {
    // An order of 10 at HQ; a company-wide principal fulfils all 10 from a draft at BRB.
    order = await draft(s.hq, "10.000000");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      issueDocument(tx, ctxOf(s.human), { documentId: order.documentId }),
    );
    await link(s.human, order, await draft(brb, "10.000000"), "10.000000");
  });

  it("an HQ-restricted clerk reads the line as fully fulfilled", async () => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      hqClerk,
      (tx) => tx<{ linked: string; open: string }[]>`
        select linked_quantity::text as linked, open_quantity::text as open
          from app.document_open_quantity where document_line_id = ${order.lineIds[0]!}`,
    );
    expect(row).toEqual({ linked: "10.000000", open: "0.000000" });
  });

  it("an HQ-restricted clerk cannot link the same 10 again (SAH-017)", async () => {
    const target = await draft(s.hq, "10.000000");
    await expect(link(hqClerk, order, target, "10.000000")).rejects.toThrow(
      /ERR_DOC_LINK_OVER_FULFILLED: source line .* has 0\.000000 open of 10\.000000 ordered/,
    );
    const [sum] = await db.admin<{ q: string }[]>`
      select sum(quantity)::text as q from app.document_link where source_line_id = ${order.lineIds[0]!}`;
    expect(sum!.q).toBe("10.000000");
  });
});
