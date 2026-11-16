import { join } from "node:path";
import { PERMISSIONS } from "@dulja/contracts";
import {
  grantCodes,
  draftDocument,
  seedAccount,
  seedCurrency,
  seedItem,
  seedParty,
  seedTenantV2,
  uuidv7,
} from "@dulja/db/test";
import { repoFile, sliceRegression, thinRegression } from "../support/regression";
import { postLines } from "../support/ledger";
import {
  creditNoteFrom,
  draftSettlement,
  issueDocument,
  postDocument,
  revalueAtPeriodEnd,
} from "@dulja/db";
import { loadDocumentTypes } from "@dulja/db/seed";
import { REPO_ROOT } from "../support/source";
import { postArDocument } from "../invariants/support/post-ar";
import { arApFixture, postFromPack } from "../invariants/support/ar-ap";

thinRegression(
  "SAH-012",
  "Base-currency amounts are never derived from value × rate, and the rate is never validated",
  "packages/db/test/ledger.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "sah-012" };

    const ok = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await withTenant(rw, ctx, (tx) =>
      postLines(tx, a, ok, [
        { account: a.cash, debit: "100", currency: "EUR", rate: "4.85" },
        { account: a.sales, credit: "100", currency: "EUR", rate: "4.85" },
      ]),
    );
    const [line] = await withTenant(
      rw,
      ctx,
      (tx) =>
        tx<
          { base_debit: string }[]
        >`select base_debit from app.ledger_entry where document_id = ${ok} and line_no = 1`,
    );
    expect(line!.base_debit).toBe("485.0000"); // derived, at scale 4, HALF_AWAY_FROM_ZERO

    const bad = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`insert into app.ledger_entry
      (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate,
       base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id)
      values (${a.tenant}, ${a.company}, ${bad}, 1, ${a.cash}, 100, 0, 'USD', 4.2, 500, 0, '2026-01-15', ${a.period}, ${a.policy})`,
      ),
    ).rejects.toThrow(/check constraint/); // a hand-typed base amount is refused
  },
);

sliceRegression(
  "SAH-012",
  "Base amounts never derived from value × rate",
  "1A",
  "postDocument writes base = round(value × rate, 4) and the CHECK refuses anything else",
  async ({ db, rw, withTenant, expect }) => {
    const seed = await seedTenantV2(db, "SAH012-1A");
    await grantCodes(db, seed, { codes: ["accounting.journal.post"] });
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "sah012" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, async (tx) => {
      await tx`insert into app.currency (tenant_id, code, name_en) values (${seed.tenant}, 'USD', 'US dollar')
               on conflict (tenant_id, code) do nothing`;
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate, rate_source, branch_id)
               values (${doc}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-01-15', 'USD', 4.68350000, 'BNM test', ${seed.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${seed.tenant}, ${seed.company}, ${doc}, 1, ${seed.cash}, 33.3350)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${seed.tenant}, ${seed.company}, ${doc}, 2, ${seed.sales}, 33.3350)`;
    });
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: doc }));
    const [row] = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ base_debit: string; rate_source: string }[]>`
      select l.base_debit::text as base_debit, d.rate_source from app.ledger_entry l
        join app.document d on d.id = l.document_id
       where l.document_id = ${doc} and l.debit > 0`,
    );
    // 33.3350 × 4.68350000 = 156.1244725, HALF_AWAY_FROM_ZERO at scale 4.
    expect(row!.base_debit).toBe("156.1245");
    expect(row!.rate_source).toBe("BNM test");
  },
);

// ─── 4A ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file and 1A appended; 4A appends and never edits the blocks above. Every
// AR/AP header carries the rate it was converted at AND where that rate came from (`rate_source`,
// plan0A:1787), and every ledger line is base = round(value × rate, 4) at that rate (spec:1816).

const AR_AP_TYPES = [
  "SALES_INVOICE",
  "SALES_CREDIT_NOTE",
  "PURCHASE_INVOICE",
  "PURCHASE_CREDIT_NOTE",
  "RECEIPT",
  "PAYMENT",
] as const;

sliceRegression(
  "SAH-012",
  "Base amounts never derived from value × rate",
  "4A",
  "EVERY writer of an AR/AP document header sets rate_source — asserted on the source",
  async ({ expect }) => {
    // `app.document.rate_source` is a plain nullable `text` with no default (plan0A:1787) and 3C's
    // `draftTypedDocument` does not write it, so "every writer sets it" is a real obligation. The plan named
    // four writers; the tree has six, and each is pinned on the column list of its own header write, not on
    // the bare word (which a comment would satisfy): the two conversion-shaped services, the settlement
    // service, reverseDocument (a full credit note, a reversed receipt or payment), 1A's generic document
    // route (an invoice keyed from nothing), and the §4.17.1 test helper's post-draft UPDATE.
    const header = /insert into app\.document\s*\([^)]*\brate_source\b/;
    for (const f of [
      "packages/db/src/ar-ap/invoice.ts", // copies rate_source from the source document
      "packages/db/src/ar-ap/credit-note.ts", // copies rate_source from the settled document
      "packages/db/src/ar-ap/settlement.ts", // "unit" at 1.00000000, manual:<actor> otherwise
      "packages/db/src/posting/reverse.ts", // d.rate_source, copied onto the mirror
      "apps/api/src/routes/accounting/documents.ts", // POST …/documents
    ]) {
      expect(repoFile(f), f).toMatch(header);
    }
    expect(repoFile("tests/invariants/support/post-ar.ts")).toMatch(
      /update app\.document set rate_source = \$\{rateSource\}/,
    );
  },
);

sliceRegression(
  "SAH-012",
  "Base amounts never derived from value × rate",
  "4A",
  "no posted AR/AP document lacks a rate_source, a credit note keeps its invoice's rate, and no line breaks the identity",
  async ({ db, withTenant, expect }) => {
    // The plan's guard ran over an empty set on this database. It is made non-vacuous here: three 4A
    // documents are posted first, through the production services, in a foreign currency and in base.
    const s = await seedTenantV2(db, "sah-012-4a");
    for (const [code, nameEn, type] of [
      ["1100", "Bank", "asset"],
      ["1200", "Trade receivables", "asset"],
      ["1250", "Goods delivered not invoiced", "asset"],
      ["5000", "Cost of goods sold", "expense"],
    ] as const) {
      await seedAccount(db, s, { code, nameEn, type });
    }
    const seeded = await loadDocumentTypes(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      join(REPO_ROOT, "packages", "db", "seed", "my", "document-types"),
      PERMISSIONS.map((p) => p.code),
    );
    const types = Object.fromEntries(seeded.map((row) => [row.code, row.documentTypeId]));
    await seedCurrency(db, s, { code: "USD" });
    const partyId = await seedParty(db, s, { kind: "customer", code: "CUST-012" });
    const { itemId } = await seedItem(db, s, { code: "SV-012", kind: "service", trackLots: false });

    // 1. A USD invoice at the caller's rate, provenance manual:<actor> (postArDocument's rule).
    const invoice = await postArDocument(db, s, {
      documentTypeId: types.SALES_INVOICE!,
      series: "INV",
      partyId,
      currency: "USD",
      exchangeRate: "4.68351234",
      lines: [
        { kind: "item", itemId, quantity: "3.000000", unitPrice: "11.1111", amount: "33.3333" },
      ],
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const [invoiceLine] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${invoice.documentId}`;
    // 2. A partial credit note, which COPIES the rate and its source from the invoice (4A Task 8).
    const note = await withTenant(db.rw, ctx, async (tx) => {
      const r = await creditNoteFrom(tx, ctx, {
        companyId: s.company,
        settledDocumentId: invoice.documentId,
        targetDocumentTypeId: types.SALES_CREDIT_NOTE!,
        targetSeries: "CN",
        effectiveDate: "2026-01-16",
        reason: "one returned",
        lines: [{ settledLineId: invoiceLine!.id, quantity: "1.000000" }],
      });
      await issueDocument(tx, ctx, { documentId: r.documentId });
      await postDocument(tx, ctx, { documentId: r.documentId });
      return r;
    });
    // 3. A base-currency receipt through draftSettlement, whose identity rate is written "unit".
    const [bank] = await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '1100'`;
    const receipt = await withTenant(db.rw, ctx, async (tx) => {
      const r = await draftSettlement(tx, ctx, {
        companyId: s.company,
        documentTypeId: types.RECEIPT!,
        series: "RCT",
        effectiveDate: "2026-01-16",
        partyId,
        bankAccountId: bank!.id,
        currency: "MYR",
        exchangeRate: "1.00000000",
        amount: "50.0000",
      });
      await issueDocument(tx, ctx, { documentId: r.documentId });
      await postDocument(tx, ctx, { documentId: r.documentId });
      return r;
    });

    const heads = await db.admin<{ id: string; rate: string; source: string | null }[]>`
      select id, exchange_rate::text as rate, rate_source as source from app.document
       where id in (${invoice.documentId}, ${note.documentId}, ${receipt.documentId})`;
    const byId = new Map(heads.map((h) => [h.id, h]));
    expect(byId.get(invoice.documentId)).toMatchObject({
      rate: "4.68351234",
      source: `manual:${s.human}`,
    });
    expect(byId.get(note.documentId)).toMatchObject({
      rate: "4.68351234",
      source: `manual:${s.human}`,
    });
    expect(byId.get(receipt.documentId)).toMatchObject({ rate: "1.00000000", source: "unit" });
    // Every ledger row of the three is at its own document's rate — the base figure has a provenance.
    const [offRate] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry e join app.document d on d.id = e.document_id
       where e.document_id in (${invoice.documentId}, ${note.documentId}, ${receipt.documentId})
         and e.currency = d.currency and e.exchange_rate <> d.exchange_rate`;
    expect(offRate!.n).toBe(0);

    // The guard, over EVERY tenant in this shared database (this block's three documents included): a posted
    // AR/AP document with a null provenance is the SAH-012 absence — a base figure nobody can account for.
    const [bad] = await db.admin<{ posted: number; missing: number }[]>`
      select count(*)::int as posted, count(*) filter (where d.rate_source is null)::int as missing
        from app.document d join app.document_type t on t.id = d.document_type_id
       where t.code = any(${[...AR_AP_TYPES]}::text[]) and d.status = 'posted'`;
    expect(bad!.posted).toBeGreaterThanOrEqual(3);
    expect(bad!.missing).toBe(0);
    // The identity itself, on every ledger row in the database — the CHECK is what this asserts is attached.
    const [broken] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry
       where base_debit <> round(debit * exchange_rate, 4) or base_credit <> round(credit * exchange_rate, 4)`;
    expect(broken!.n).toBe(0);
  },
);

sliceRegression(
  "SAH-012",
  "Base amounts never derived from value × rate",
  "4A",
  "no repair procedure exists that could restate a posted base amount (the procFixValues shape)",
  async ({ db, expect }) => {
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_proc p
       where p.pronamespace = 'app'::regnamespace and p.proname like '%fix%'`;
    expect(n!.n).toBe(0);
  },
);

// 4B (contracts §3.7.3: appended, never editing a block above). The FX documents carry BASE amounts at rate
// 1, so the identity holds on them by construction; the one place 4B applies a rate is the revaluation, and
// a rate that does not exist is refused there — the SAH-012 failure was ItmEqu = 1 against a foreign amount.
sliceRegression(
  "SAH-012",
  "Base amounts never derived from value × rate",
  "4B",
  "the revaluation converts through toBase alone, and a missing rate REFUSES rather than assuming 1",
  async ({ db, withTenant, expect }) => {
    // CODE only: a comment that writes the identity out is not a second implementation.
    const source = repoFile("packages/db/src/ar-ap/fx.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // One conversion, the domain's: toBase is round(value × rate, 4) HALF_AWAY_FROM_ZERO, the arithmetic the
    // ledger_entry CHECK itself uses. No decimal.js product and no Money multiply of a rate beside it, and no
    // SQL that multiplies by a document's exchange_rate.
    expect(source).toMatch(/toBase\(e\.amountCcy, quote\)/);
    expect(source).not.toMatch(/\.times\(/);
    expect(source).not.toMatch(/\.multiply\(/);
    expect(source).not.toMatch(/\*\s*\w*\.?exchange_rate/);

    // Behaviour: a GBP exposure with no exchange_rate row at all.
    const s = await seedTenantV2(db, "sah-012-4b");
    const f = await arApFixture(db, s);
    await seedCurrency(db, s, { code: "GBP" });
    await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-05",
      partyId: f.partyIds.customer,
      currency: "GBP",
      exchangeRate: "6.00000000",
      rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "10.0000" }],
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const [period] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ id: string }[]>`
      select id::text as id from app.fiscal_period
       where company_id = ${s.company} and starts_on = '2026-01-01'`,
    );
    await expect(
      withTenant(db.rw, ctx, (tx) =>
        revalueAtPeriodEnd(tx, ctx, { companyId: s.company, fiscalPeriodId: period!.id }),
      ),
    ).rejects.toThrow(/ERR_RATE_NOT_FOUND.*GBP.*MYR/);
    const [written] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document d
        join app.document_type t on t.id = d.document_type_id
       where d.company_id = ${s.company} and t.code = 'FX_REVALUATION'`,
    );
    expect(written!.n).toBe(0);
  },
);
