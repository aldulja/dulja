import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dueDateFor, resolvePartyTerm } from "../../src/ar-ap/payment-term";
import { readPackFile } from "../../src/seed";
import {
  seedAccount,
  seedCurrency,
  seedItem,
  seedParty,
  seedPaymentTerm,
  seedTenantV2,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";
import { PACK_ROOT, accountByCode, loadTypesFromPack } from "./_support";

let db: Db;
let s: Seed;
let invType: string;
let partyId: string;
let itemId: string;
let termId: string;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "sales-invoice");
  // The accounts SALES_INVOICE's policy resolves, created the one way a test creates a §4.15 account. A test
  // tenant has no pack chart; 4A seeds none of these (Global Constraint 14) — 0C and 3D own them. `4000` is
  // seedTenantV2's and is never passed here; `1300` and `5900` are here because `seedItem` needs an inventory
  // account and the charge-line case needs an expense account, not because the policy names either.
  for (const [code, nameEn, type] of [
    ["1200", "Trade receivables", "asset"],
    ["1250", "Goods delivered not invoiced", "asset"],
    ["1300", "Inventory control", "asset"],
    ["5000", "Cost of goods sold", "expense"],
    ["5900", "Other operating expense", "expense"],
    ["5920", "FX rounding", "expense"],
  ] as const) {
    await seedAccount(db, s, { code, nameEn, type });
  }
  // The type comes from the PACK, through 1A's loader — the zero-code claim is about the seeded file.
  invType = (await loadTypesFromPack(db, s, ["SALES_INVOICE"])).salesInvoiceType!;
  termId = await seedPaymentTerm(db, s, { code: "NET30", dueDays: 30 });
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-INV" });
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx`update app.party set payment_term_id = ${termId} where id = ${partyId}`,
  );
  ({ itemId } = await seedItem(db, s, { code: "IT-INV", kind: "product", trackLots: false }));
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("SALES_INVOICE — §4.14, ADR 0044, spec:2009–2028", () => {
  it("the seed file validates against the envelope schema and its policy against the policy schema", () => {
    // The loader in `beforeAll` already ran both validations (validateDocumentTypeSeed, validatePolicy against
    // the catalogue) — a file that failed either would have thrown there. This pins the four choices.
    const envelope = readPackFile<{
      code: string;
      module: string;
      policy: {
        direction: string;
        inventory: { effect: string };
        numbering: { series: string };
        approval: { post: string };
      };
    }>(PACK_ROOT, "document-types", "SALES_INVOICE.json");
    expect(envelope.code).toBe("SALES_INVOICE");
    expect(envelope.module).toBe("accounting");
    expect(envelope.policy.direction).toBe("outbound");
    expect(envelope.policy.inventory.effect).toBe("none"); // ADR 0044
    expect(envelope.policy.numbering.series).toBe("INV");
    expect(envelope.policy.approval.post).toBe("accounting.sales.post");
  });

  it("a linked-shape invoice posts four rows: AR, revenue, COGS and the 1250 relief", async () => {
    const r = await postArDocument(db, s, {
      documentTypeId: invType,
      series: "INV",
      partyId,
      paymentTermId: termId,
      lines: [
        {
          kind: "item",
          itemId,
          quantity: "5.000000",
          unitPrice: "9.0000",
          amount: "45.0000",
          cost: "15.0000",
        },
      ],
    });
    expect(r.ledger).toEqual([
      { code: "1200", debit: "45.0000", credit: "0.0000" },
      { code: "1250", debit: "0.0000", credit: "15.0000" },
      { code: "4000", debit: "0.0000", credit: "45.0000" },
      { code: "5000", debit: "15.0000", credit: "0.0000" },
    ]);
  });

  it("every line carries BRANCH — spec:1066's required dimension on revenue and COGS", async () => {
    const [total] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where tenant_id = ${s.tenant}`;
    expect(total!.n).toBeGreaterThan(0); // non-empty before the absence below
    const rows = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry e
       where e.tenant_id = ${s.tenant}
         and not exists (select 1 from app.ledger_entry_dimension d
                          join app.dimension_value v on v.id = d.dimension_value_id
                         where d.entry_id = e.id and v.id = ${s.hq})`;
    expect(rows[0]!.n).toBe(0);
  });

  it("a MIXED invoice posts cost legs for the product line only (when: item.kind = product)", async () => {
    const { itemId: svc } = await seedItem(db, s, {
      code: "SVC-INV",
      kind: "service",
      trackLots: false,
    });
    const r = await postArDocument(db, s, {
      documentTypeId: invType,
      series: "INV",
      partyId,
      effectiveDate: "2026-01-16",
      lines: [
        {
          kind: "item",
          itemId,
          quantity: "1.000000",
          unitPrice: "9.0000",
          amount: "9.0000",
          cost: "3.0000",
        },
        {
          kind: "item",
          itemId: svc,
          quantity: "1.000000",
          unitPrice: "50.0000",
          amount: "50.0000",
        },
      ],
    });
    // Two AR debits, two revenue credits, and exactly ONE cost pair.
    expect(r.ledger.filter((l) => l.code === "5000")).toHaveLength(1);
    expect(r.ledger.filter((l) => l.code === "1250")).toHaveLength(1);
    expect(r.ledger.filter((l) => l.code === "1200")).toHaveLength(2);
    expect(r.ledger.filter((l) => l.code === "4000")).toHaveLength(2);
  });

  it("a CHARGE line posts AR against its own account, with no cost leg", async () => {
    const r = await postArDocument(db, s, {
      documentTypeId: invType,
      series: "INV",
      partyId,
      effectiveDate: "2026-01-17",
      lines: [
        {
          kind: "account",
          accountId: await accountByCode(db, s, "5900"),
          description: "delivery charge",
          amount: "20.0000",
        },
      ],
    });
    expect(r.ledger).toEqual([
      { code: "1200", debit: "20.0000", credit: "0.0000" },
      { code: "5900", debit: "0.0000", credit: "20.0000" },
    ]);
  });

  it("a product line with NO cost — no delivery, no copy — is refused (Task 4's guard, ADR 0044)", async () => {
    await expect(
      postArDocument(db, s, {
        documentTypeId: invType,
        series: "INV",
        partyId,
        effectiveDate: "2026-01-18",
        lines: [
          { kind: "item", itemId, quantity: "1.000000", unitPrice: "9.0000", amount: "9.0000" },
        ],
      }),
    ).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING: document line 1 has no cost/);
  });

  it("the pinned term drives the derived due date, and it survives a change to the party's term", async () => {
    const r = await postArDocument(db, s, {
      documentTypeId: invType,
      series: "INV",
      partyId,
      paymentTermId: termId,
      effectiveDate: "2026-01-20",
      lines: [
        {
          kind: "item",
          itemId,
          quantity: "1.000000",
          unitPrice: "9.0000",
          amount: "9.0000",
          cost: "3.0000",
        },
      ],
    });
    const later = await seedPaymentTerm(db, s, { code: "NET90", dueDays: 90 });
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set payment_term_id = ${later} where id = ${partyId}`,
    );
    const due = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [d] = await tx<{ t: string | null }[]>`
        select payment_term_id::text as t from app.document where id = ${r.documentId}`;
      return dueDateFor(tx, { paymentTermId: d!.t, effectiveDate: "2026-01-20" });
    });
    expect(due).toBe("2026-02-19"); // 20 Jan + 30 days, NOT + 90
    expect(
      await withTenant(db.rw, s.tenant, s.human, (tx) => resolvePartyTerm(tx, { partyId })),
    ).toBe(later);
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set payment_term_id = ${termId} where id = ${partyId}`,
    );
  });

  it("credit control applies to the real type: over the limit refuses, a second principal's override releases it", async () => {
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set credit_limit = ${"100.0000"} where id = ${partyId}`,
    );
    const over = {
      documentTypeId: invType,
      series: "INV",
      partyId,
      effectiveDate: "2026-01-21",
      lines: [
        {
          kind: "item" as const,
          itemId,
          quantity: "1.000000",
          unitPrice: "900.0000",
          amount: "900.0000",
          cost: "300.0000",
        },
      ],
    };
    await expect(postArDocument(db, s, over)).rejects.toThrow(
      /ERR_CREDIT_LIMIT_EXCEEDED: party CUST-INV/,
    );
    const released = await postArDocument(db, s, {
      ...over,
      effectiveDate: "2026-01-22",
      creditOverride: true,
    });
    expect(released.number).toBeGreaterThan(0n);
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set credit_limit = null where id = ${partyId}`,
    );
  });

  it("base = round(value × rate, 4) on every line — LEGACY-012, in a foreign currency", async () => {
    // A USD charge invoice, so the identity has a rate other than 1 to be wrong about. A charge line, not a
    // product line: `document_line.cost` is BASE currency (3B amendment A4) and converting a copied cost on a
    // foreign-currency invoice is the conversion service's question (Task 6), not this type's.
    await seedCurrency(db, s, { code: "USD" });
    const fx = await postArDocument(db, s, {
      documentTypeId: invType,
      series: "INV",
      partyId,
      effectiveDate: "2026-01-23",
      currency: "USD",
      exchangeRate: "4.68350000",
      lines: [
        {
          kind: "account",
          accountId: await accountByCode(db, s, "5900"),
          description: "export handling",
          amount: "10.0001",
        },
      ],
    });
    const legs = await db.admin<{ code: string; base_debit: string; base_credit: string }[]>`
      select a.code, e.base_debit::text as base_debit, e.base_credit::text as base_credit
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${fx.documentId} order by a.code`;
    // 10.0001 × 4.6835 = 46.83546835 → 46.8355 at scale 4, HALF_AWAY_FROM_ZERO (hazard 23).
    expect(legs).toEqual([
      { code: "1200", base_debit: "46.8355", base_credit: "0.0000" },
      { code: "5900", base_debit: "0.0000", base_credit: "46.8355" },
    ]);
    const rows = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry
       where tenant_id = ${s.tenant}
         and (base_debit <> round(debit * exchange_rate, 4) or base_credit <> round(credit * exchange_rate, 4))`;
    expect(rows[0]!.n).toBe(0); // the CHECK guarantees it; this asserts the CHECK is still attached
    const [src] = await db.admin<{ src: string | null }[]>`
      select rate_source as src from app.document where id = ${fx.documentId}`;
    expect(src!.src).toBe(`manual:${s.human}`);
  });

  it("every posted invoice carries a rate_source — a base figure with no provenance is LEGACY-012", async () => {
    // This is the NON-VACUOUS half of Task 14's legacy-012 block: that block runs against the thin regression
    // database, which holds no 4A document, so its count of null rate_sources is 0 for the wrong reason. THIS
    // database holds nothing but documents `postArDocument` built, so the same assertion here has rows to be
    // wrong about. `draftTypedDocument` (3C) does not write the column and `app.document.rate_source` has no
    // default (plan0A:1787) — without the helper's UPDATE this case is red on every row.
    const [posted] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document d
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'SALES_INVOICE' and d.status = 'posted'`;
    expect(posted!.n).toBeGreaterThan(0);
    const [nulls] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document d
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'SALES_INVOICE' and d.status = 'posted' and d.rate_source is null`;
    expect(nulls!.n).toBe(0);
    const [one] = await db.admin<{ src: string; rate: string }[]>`
      select d.rate_source as src, d.exchange_rate::text as rate from app.document d
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'SALES_INVOICE' and d.status = 'posted' order by d.number limit 1`;
    expect(one!.rate).toBe("1.00000000");
    expect(one!.src).toBe("unit"); // the label plan0A:1787's own comment gives for an unconverted rate
  });
});
