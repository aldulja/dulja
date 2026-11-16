import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { creditStatus } from "../../src/ar-ap/credit";
import { resolvePartyTerm } from "../../src/ar-ap/payment-term";
import { issueDocument, recordOverride } from "../../src/posting";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedParty,
  seedPaymentTerm,
  seedPriceList,
  seedTenantV2,
  startDb,
  uuidv7,
  withTenant,
  type Db,
  type Seed,
} from "../index";
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";

let db: Db;
let s: Seed;
let partyId: string;
let crtType: string;
const ctxOf = (seed: Seed, actor?: string) => ({
  tenantId: seed.tenant,
  actorId: actor ?? seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/** The §4.14 test-only type `CREDIT_TEST` — outbound, no inventory, no approval. Configured here through
 *  `seedDocumentType` and never a seed-pack file (contracts §4.14's test-only mark). */
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
  s = await seedTenantV2(db, "credit-control");
  await seedAccount(db, s, { code: "1200", nameEn: "Trade receivables", type: "asset" });
  await grantCodes(db, s, { codes: ["accounting.sales.post"] });
  crtType = await seedDocumentType(db, s, { code: "CREDIT_TEST", policy: CREDIT_TEST_POLICY });
  const termId = await seedPaymentTerm(db, s, { code: "NET30", dueDays: 30 });
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-CREDIT" });
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) =>
      tx`update app.party set credit_limit = ${"1000.0000"}, payment_term_id = ${termId} where id = ${partyId}`,
  );
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/** Draft a CREDIT_TEST for `total`, and try to issue it. */
async function tryIssue(total: string, opts?: { override?: string; reason?: string }) {
  const { documentId } = await draftTypedDocument(db, s, {
    documentTypeId: crtType,
    series: "CRT",
    effectiveDate: "2026-01-10",
    partyId,
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
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) =>
      tx`update app.document_line set total_incl_tax = ${total} where document_id = ${documentId}`,
  );
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    if (opts?.override !== undefined) {
      // `document_event.actor_id` defaults to `app.current_actor()` — always `s.human` here — so the second
      // principal is the ATTRIBUTED one (2B, §4.5.3; 3D states the same at 3d:2650).
      await recordOverride(tx, ctxOf(s), {
        documentId,
        code: "accounting.credit_limit.override",
        reason: opts.reason ?? "director approved by telephone",
        attributedTo: opts.override,
      });
    }
    await issueDocument(tx, ctxOf(s), { documentId });
    return documentId;
  });
}

describe("credit control — migration 0045, contracts §4.8.1, spec:1026, spec:2179", () => {
  it("the schema linter reports zero violations after 0045", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("a document inside the limit issues", async () => {
    const id = await tryIssue("400.0000");
    const [doc] = await db.admin<
      { status: string }[]
    >`select status from app.document where id = ${id}`;
    expect(doc!.status).toBe("issued");
  });

  it("a document that takes the party OVER the limit is refused with ERR_CREDIT_LIMIT_EXCEEDED naming the party", async () => {
    // 400 is issued-but-unposted and counts towards the exposure (Phase 4 review A6); 1200 alone exceeds 1000.
    await expect(tryIssue("1200.0000")).rejects.toThrow(
      /ERR_CREDIT_LIMIT_EXCEEDED: party CUST-CREDIT/,
    );
  });

  it("the same document issues when a SECOND principal has recorded the override event (spec:2179)", async () => {
    const director = await secondPrincipal(db, s, "director");
    await grantCodes(db, s, {
      codes: ["accounting.credit_limit.override"],
      principalId: director,
      roleCode: "credit-override",
    });
    const id = await tryIssue("1200.0000", { override: director });
    const [doc] = await db.admin<
      { status: string }[]
    >`select status from app.document where id = ${id}`;
    expect(doc!.status).toBe("issued");
    const [ev] = await db.admin<{ kind: string; code: string; attributed: string }[]>`
      select event_kind as kind, override_code as code, attributed_to as attributed
        from app.document_event where document_id = ${id} and event_kind = 'override'`;
    expect(ev).toMatchObject({
      kind: "override",
      code: "accounting.credit_limit.override",
      attributed: director,
    });
  });

  it("the creator cannot authorise their own override — 2B's guard, not a second check here", async () => {
    // The creator is granted the code first, so the refusal below is the second-principal branch of
    // app.assert_override_authorised and not its "does not hold" branch: without the grant the creator
    // would be refused for lacking authority, which proves nothing about maker and checker.
    await grantCodes(db, s, { codes: ["accounting.credit_limit.override"] });
    await expect(tryIssue("1200.0000", { override: s.human })).rejects.toThrow(
      /ERR_OVERRIDE_NOT_AUTHORISED: an override on document .* needs a second principal/,
    );
  });

  it("credit_hold refuses with ERR_CREDIT_HOLD, and an override does NOT lift it (§4.8.1 'blocks regardless')", async () => {
    const director = await secondPrincipal(db, s, "director");
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set credit_hold = true where id = ${partyId}`,
    );
    await expect(tryIssue("1.0000")).rejects.toThrow(
      /ERR_CREDIT_HOLD: party CUST-CREDIT is on credit hold/,
    );
    await expect(tryIssue("1.0000", { override: director })).rejects.toThrow(/ERR_CREDIT_HOLD/);
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set credit_hold = false where id = ${partyId}`,
    );
  });

  it("a NULL credit_limit is no limit, not a zero limit", async () => {
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set credit_limit = null where id = ${partyId}`,
    );
    const id = await tryIssue("999999.0000");
    const [doc] = await db.admin<
      { status: string }[]
    >`select status from app.document where id = ${id}`;
    expect(doc!.status).toBe("issued");
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set credit_limit = ${"1000.0000"} where id = ${partyId}`,
    );
  });

  it("a party with a limit and NO receivable control account is REFUSED, never silently allowed (LEGACY-042)", async () => {
    // `app.party.receivable_account_id` is nullable (§4.5.7) and `l.account_id = <null>` matches no ledger
    // row, so a naive predicate would report a 0.0000 exposure and let every over-limit sale through — "an
    // absent row makes a check pass". This is the ONE case that discriminates the fail-closed branch: it is
    // red against a function that returns 0 for a null account and green only against one that raises.
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set receivable_account_id = null where id = ${partyId}`,
    );
    await expect(tryIssue("1.0000")).rejects.toThrow(
      /ERR_POLICY_REQUIRES_MISSING: party .* carries a credit limit but no receivable control account/,
    );
    // …and with the limit cleared there is no credit question, so the same party issues and the function
    // returns 0 without raising — the guard tests BOTH columns, not one.
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set credit_limit = null where id = ${partyId}`,
    );
    const id = await tryIssue("1.0000");
    const [doc] = await db.admin<
      { status: string }[]
    >`select status from app.document where id = ${id}`;
    expect(doc!.status).toBe("issued");
    // `_support.ts`'s `accountByCode` is Task 5's file and does not exist yet, so the id is read inline.
    const [receivable] = await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = ${"1200"}`;
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx`update app.party set receivable_account_id = ${receivable!.id}, credit_limit = ${"1000.0000"}
            where id = ${partyId}`,
    );
  });

  it("resolvePartyTerm returns the party's pinned-at-draft term, and refuses an invisible party", async () => {
    // Task 1 shipped the function against a column this migration adds; this is its DB-tier test, and the
    // ERR_NOT_FOUND case is what lets `draftSettlement` and `convertToInvoice` drop their own party probes.
    const term = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      resolvePartyTerm(tx, { partyId }),
    );
    const [row] = await db.admin<{ id: string }[]>`
      select payment_term_id as id from app.party where id = ${partyId}`;
    expect(term).toBe(row!.id);
    const ghost = await uuidv7(db.admin);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => resolvePartyTerm(tx, { partyId: ghost })),
    ).rejects.toThrow(/ERR_NOT_FOUND: party .* is not visible/);
  });

  it("an INTERNAL document type is ignored by the trigger, even for a party on hold", async () => {
    // s.docType is JOURNAL (direction internal, §4.3.7). It carries the held party, so the case reaches the
    // trigger's DIRECTION guard rather than returning at its party guard; this case exists so a later reader
    // does not "improve" the trigger into checking every type.
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set credit_hold = true where id = ${partyId}`,
    );
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: s.docType,
      series: "JV",
      effectiveDate: "2026-01-10",
      partyId,
      lines: [
        { kind: "account", accountId: s.cash, debit: "5.0000" },
        { kind: "account", accountId: s.sales, credit: "5.0000" },
      ],
    });
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    await withTenant(db.rw, s.tenant, s.human, (tx) => issueDocument(tx, ctxOf(s), { documentId }));
    const [doc] = await db.admin<
      { status: string }[]
    >`select status from app.document where id = ${documentId}`;
    expect(doc!.status).toBe("issued");
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set credit_hold = false where id = ${partyId}`,
    );
  });

  it("creditStatus reports the same figures the trigger uses, in base currency", async () => {
    const status = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      creditStatus(tx, { partyId }),
    );
    expect(status.creditHold).toBe(false);
    expect(status.creditLimit?.toString()).toBe("1000.0000");
    expect(status.openBase.toString()).toBe("0.0000"); // nothing posted yet
    expect(status.openBase.currency).toBe("MYR");
    // …but four sales of this party are ISSUED — 400, the overridden 1200, the 999999 issued while it had no
    // limit, and the 1.0000 issued while the limit was cleared — and the control counts every one (A6), so
    // the screen does too. Drafts and refused issues count for nothing.
    expect(status.pendingBase.toString()).toBe("1001600.0000");
    expect(status.exposureBase.toString()).toBe("1001600.0000");
    expect(status.headroomBase?.toString()).toBe("-1000600.0000");
  });

  it("the five new columns are on the two tables with the shapes §4.5.7 and §4.3.4 fix", async () => {
    const cols = await db.admin<{ t: string; c: string; d: string; n: string }[]>`
      select table_name as t, column_name as c, data_type as d, is_nullable as n
        from information_schema.columns
       where table_schema = 'app'
         and (table_name, column_name) in
             (('party','credit_limit'), ('party','payment_term_id'), ('party','credit_hold'),
              ('party','price_list_id'), ('document','payment_term_id'))
       order by 1, 2`;
    expect(cols).toEqual([
      { t: "document", c: "payment_term_id", d: "uuid", n: "YES" },
      { t: "party", c: "credit_hold", d: "boolean", n: "NO" },
      { t: "party", c: "credit_limit", d: "numeric", n: "YES" },
      { t: "party", c: "payment_term_id", d: "uuid", n: "YES" },
      { t: "party", c: "price_list_id", d: "uuid", n: "YES" },
    ]);
  });

  it("document.payment_term_id has the COMPOSITE FK, not a plain one (§3.5.1)", async () => {
    const [fk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.document'::regclass and conname = 'document_payment_term_fk'`;
    expect(fk!.def).toMatch(
      /FOREIGN KEY \(tenant_id, payment_term_id\) REFERENCES app\.payment_term\(tenant_id, id\)/,
    );
  });

  it("party.payment_term_id has the COMPOSITE FK too (§4.5.7, 4A amendment 6)", async () => {
    const [fk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.party'::regclass and conname = 'party_payment_term_fk'`;
    expect(fk!.def).toMatch(
      /FOREIGN KEY \(tenant_id, payment_term_id\) REFERENCES app\.payment_term\(tenant_id, id\)/,
    );
  });

  it("party.price_list_id has the COMPOSITE FK to app.price_list (§4.5.7, 6B's A10(b))", async () => {
    // The column is not credit control and the trigger never reads it; it is the customer's trade-level
    // price list, and 6B's A10(b) named THIS migration as the file that adds it. A plain
    // `references app.price_list(id)` would be the §3.5.1 defect — a party could point at another
    // tenant's list — so the constraint definition is asserted, not merely the column's existence.
    const [fk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.party'::regclass and conname = 'party_price_list_fk'`;
    expect(fk!.def).toMatch(
      /FOREIGN KEY \(tenant_id, price_list_id\) REFERENCES app\.price_list\(tenant_id, id\)/,
    );
  });

  it("a party can be pinned to a price list, and a list from ANOTHER tenant is refused", async () => {
    const listId = await seedPriceList(db, s, { code: "WHOLESALE", currency: "MYR" });
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set price_list_id = ${listId} where id = ${partyId}`,
    );
    const [row] = await db.admin<{ id: string | null }[]>`
      select price_list_id as id from app.party where id = ${partyId}`;
    expect(row!.id).toBe(listId);

    // The other half of the composite FK: a second tenant's list is not reachable from this party, and the
    // database says so rather than the application. `seedTenantV2` makes a whole second tenant, which is
    // the only way to produce a (tenant_id, price_list_id) pair the FK must reject.
    const other = await seedTenantV2(db, "credit-control-other");
    const otherList = await seedPriceList(db, other, { code: "RETAIL", currency: "MYR" });
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`update app.party set price_list_id = ${otherList} where id = ${partyId}`,
      ),
    ).rejects.toThrow(/party_price_list_fk/);

    // Left null so no later case in this file inherits a pinned list it did not ask for.
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set price_list_id = null where id = ${partyId}`,
    );
  });
});
