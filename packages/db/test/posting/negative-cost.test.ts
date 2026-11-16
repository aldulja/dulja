import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";

let db: Db;
let s: Seed;
let noneType: string;
let itemId: string;
// No `Money` import and no `MYR` constant: every figure this suite asserts is read back from the
// database as a 4-dp string and compared as a string, so importing `@dulja/domain` here would be an
// unused import and `bun run lint` fails on one.
const ctxOf = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/** An `effect: "none"` policy with a cost/cost pair — the SALES_INVOICE shape, minimally. */
const NONE_WITH_COST = {
  version: 1,
  documentType: "CREDIT_TEST",
  direction: "outbound",
  requires: [],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { code: "5000" },
      amount: "line.cost",
      when: { "item.kind": "product" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "1250" },
      amount: "line.cost",
      when: { "item.kind": "product" },
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
  s = await seedTenantV2(db, "negative-cost");
  for (const [code, nameEn, type] of [
    ["1250", "Goods delivered not invoiced", "asset"],
    ["1300", "Inventory control", "asset"],
    ["5000", "Cost of goods sold", "expense"],
    ["5920", "FX rounding", "expense"],
  ] as const)
    await seedAccount(db, s, { code, nameEn, type });
  await grantCodes(db, s, { codes: ["accounting.sales.post"] });
  noneType = await seedDocumentType(db, s, { code: "CREDIT_TEST", policy: NONE_WITH_COST });
  ({ itemId } = await seedItem(db, s, { code: "IT-NC", kind: "product", trackLots: false }));
  await seedWarehouse(db, s, { code: "WH-NC" });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/** Draft an item line on the effect:"none" type, optionally with a cost already written. */
async function draftWithCost(cost: string | null, quantity: string) {
  const { documentId, lineIds } = await draftTypedDocument(db, s, {
    documentTypeId: noneType,
    series: "CRT",
    effectiveDate: "2026-01-10",
    lines: [{ kind: "item", itemId, quantity, unitPrice: "9.0000", amount: "45.0000" }],
  });
  if (cost !== null) {
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.document_line set cost = ${cost} where id = ${lineIds[0]!}`,
    );
  }
  return documentId;
}

describe("the unfilled-cost refusal and the negative-cost round trip — §4.7.2, ADR 0045", () => {
  it("a COPIED cost posts without any movement: debit 5000, credit 1250, at that figure", async () => {
    const id = await draftWithCost("15.0000", "5.000000");
    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctxOf(s), { documentId: id }),
    );
    expect(result.movementIds).toEqual([]);
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text, e.credit::text from app.ledger_entry e
        join app.account a on a.id = e.account_id where e.document_id = ${id} order by a.code`;
    expect(rows).toEqual([
      { code: "1250", debit: "0.0000", credit: "15.0000" },
      { code: "5000", debit: "15.0000", credit: "0.0000" },
    ]);
  });

  it("a NEGATIVE quantity with a copied cost relieves the other way — the credit-note direction (ADR 0045)", async () => {
    const id = await draftWithCost("15.0000", "-5.000000");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctxOf(s), { documentId: id }),
    );
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text, e.credit::text from app.ledger_entry e
        join app.account a on a.id = e.account_id where e.document_id = ${id} order by a.code`;
    expect(rows).toEqual([
      { code: "1250", debit: "15.0000", credit: "0.0000" },
      { code: "5000", debit: "0.0000", credit: "15.0000" },
    ]);
  });

  it("the two together net to EXACTLY zero on both accounts — the corridor invariant", async () => {
    const rows = await db.admin<{ code: string; net: string }[]>`
      select a.code, sum(e.base_debit - e.base_credit)::text as net
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where a.code in ('1250', '5000') group by a.code order by a.code`;
    expect(rows).toEqual([
      { code: "1250", net: "0.0000" },
      { code: "5000", net: "0.0000" },
    ]);
  });

  it("an UNFILLED cost — no movement, no copy — is REFUSED with ERR_POLICY_REQUIRES_MISSING naming the line", async () => {
    const id = await draftWithCost(null, "5.000000");
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId: id })),
    ).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING: document line 1 has no cost/);
  });

  it("the refusal leaves the document unposted and the ledger empty — it fires BEFORE any insert", async () => {
    const id = await draftWithCost(null, "5.000000");
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId: id })),
    ).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING/);
    const [doc] = await db.admin<
      { status: string }[]
    >`select status from app.document where id = ${id}`;
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where document_id = ${id}`;
    expect(doc!.status).not.toBe("posted");
    expect(n!.n).toBe(0);
  });

  it("a SERVICE item is filtered out by when: { item.kind: product } and needs no cost at all", async () => {
    const { itemId: svc } = await seedItem(db, s, {
      code: "SVC-NC",
      kind: "service",
      trackLots: false,
    });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: noneType,
      series: "CRT",
      effectiveDate: "2026-01-10",
      lines: [
        {
          kind: "item",
          itemId: svc,
          quantity: "1.000000",
          unitPrice: "50.0000",
          amount: "50.0000",
        },
      ],
    });
    // The policy plans NO ledger line for a service line, so the post refuses with the OUTPUT case of
    // ERR_DOC_NO_LINES (§4.3.2 step 6) — not with the cost refusal. The distinction matters: the service
    // line is not missing a cost, it is not a cost-bearing line at all.
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId })),
    ).rejects.toThrow(/ERR_DOC_NO_LINES/);
  });
});
