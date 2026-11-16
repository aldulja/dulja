import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema, listApplied } from "../../src";
import { allocateSettlement } from "../../src/ar-ap/allocation";
import { creditNoteFrom } from "../../src/ar-ap/credit-note";
import { issueDocument, postDocument, reverseDocument } from "../../src/posting";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedCurrency,
  seedItem,
  seedParty,
  seedPaymentTerm,
  seedRate,
  seedTenant,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";
import { accountByCode, loadTypesFromPack } from "./_support";

/**
 * 4B Task 1 — migration 0048: the two async projection tables and the two STABLE SQL functions that hold the
 * ONE definition of the ageing arithmetic and of the item split (contracts §4.6.1, §4.8.2, round 8
 * amendments 3, 6, 7). The first describe block is the plan's DDL proof. The second drives both functions
 * over documents posted through the REAL posting service — Tasks 3 and 4 own the rebuilds, the report and
 * the registered tie-out, but the arithmetic is written here, so it is proved here too: a function that
 * compiles and returns the wrong figure would otherwise stay green until Task 3.
 */
let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenant(db, "ageing-a");
  b = await seedTenant(db, "ageing-b");
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

describe("migration 0048 — the two async projections (§4.6.1, spec:1204)", () => {
  it("applies as version 48", async () => {
    expect(await listApplied(db.migrator)).toContain(48);
  });

  it("both tables carry the §3.3 binding form: tenant_id, forced RLS, one policy named tenant_isolation, created_at", async () => {
    for (const table of ["party_ageing", "item_profitability"]) {
      const [rel] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relrowsecurity, relforcerowsecurity from pg_class
         where oid = ${`app.${table}`}::regclass`;
      expect(rel, table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });

      const policies = await db.admin<{ policyname: string; permissive: string }[]>`
        select policyname, permissive from pg_policies
         where schemaname = 'app' and tablename = ${table} order by policyname`;
      expect(
        policies.map((p) => p.policyname),
        table,
      ).toEqual(["tenant_isolation"]);

      const cols = await db.admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'app' and table_name = ${table} order by column_name`;
      const names = cols.map((c) => c.column_name);
      expect(names, table).toContain("tenant_id");
      expect(names, table).toContain("created_at");
      expect(names, table).not.toContain("id"); // both join NO_ID_TABLES: a natural key

      // Derived projections: AUDIT_EXEMPT (§3.5.3), so no audit_row trigger — and no trigger at all. Not
      // IMMUTABLE: the rebuild MERGEs into them.
      expect(AUDIT_EXEMPT.has(table), table).toBe(true);
      expect(IMMUTABLE.has(table), table).toBe(false);
      const triggers = await db.admin<{ tgname: string }[]>`
        select tgname from pg_trigger where tgrelid = ${`app.${table}`}::regclass and not tgisinternal`;
      expect(triggers, table).toEqual([]);
    }
  });

  it("the two primary keys are §4.6.1's natural keys", async () => {
    const pk = async (table: string) => {
      const rows = await db.admin<{ attname: string }[]>`
        select a.attname from pg_index i
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = ${`app.${table}`}::regclass and i.indisprimary
         order by array_position(i.indkey, a.attnum)`;
      return rows.map((r) => r.attname);
    };
    expect(await pk("party_ageing")).toEqual([
      "company_id",
      "party_id",
      "currency",
      "as_of",
      "bucket",
    ]);
    expect(await pk("item_profitability")).toEqual(["company_id", "item_id", "fiscal_period_id"]);
  });

  it("app_rw may select, insert and update both, and may NOT delete either (§3.5.4's pinned list is unchanged)", async () => {
    const grants = await db.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app'
         and table_name in ('party_ageing', 'item_profitability')
       order by table_name, privilege_type`;
    const of = (t: string) =>
      grants
        .filter((g) => g.table_name === t)
        .map((g) => g.privilege_type)
        .toSorted();
    expect(of("party_ageing")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(of("item_profitability")).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("the bucket vocabulary is a named CHECK, not an enum (§3.4.4, hazard 11)", async () => {
    const [chk] = await db.admin<{ pg_get_constraintdef: string }[]>`
      select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'app.party_ageing'::regclass and conname = 'party_ageing_bucket_check'`;
    for (const bucket of ["current", "1_30", "31_60", "61_90", "over_90"]) {
      expect(chk?.pg_get_constraintdef).toContain(`'${bucket}'`);
    }
    const [col] = await db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'party_ageing' and column_name = 'bucket'`;
    expect(col!.data_type).toBe("text");
  });

  it("both SQL functions exist, are STABLE, are NOT security definer, and only app_rw may execute them", async () => {
    const fns = await db.admin<
      { proname: string; provolatile: string; prosecdef: boolean; rw: boolean; pub: boolean }[]
    >`
      select proname, provolatile, prosecdef,
             has_function_privilege('app_rw', p.oid, 'execute') as rw,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                      where x.grantee = 0 and x.privilege_type = 'EXECUTE') as pub
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and proname in ('party_ageing_rows', 'item_profitability_rows')
       order by proname`;
    expect(fns.map((f) => f.proname)).toEqual(["item_profitability_rows", "party_ageing_rows"]);
    for (const f of fns) {
      expect(f.provolatile, f.proname).toBe("s"); // STABLE
      expect(f.prosecdef, f.proname).toBe(false); // never SECURITY DEFINER (§4.5.6's reasoning)
      expect(f.rw, f.proname).toBe(true);
      expect(f.pub, f.proname).toBe(false); // PUBLIC's default EXECUTE is revoked
    }
  });

  it("both functions return zero rows for a company with no documents", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const ageing =
        await tx`select * from app.party_ageing_rows(${a.company}, '2026-01-31'::date)`;
      expect(ageing).toEqual([]);
      const profit = await tx`
        select * from app.item_profitability_rows(${a.company}, array['SALES_INVOICE']::text[])`;
      expect(profit).toEqual([]);
    });
  });

  it("tenant B cannot see tenant A's projection rows (test 12)", async () => {
    // A party FIRST. Without it the insert below selects zero rows and the test proves nothing: B would
    // read an empty table because the table IS empty, not because RLS hid anything. The function half of
    // test 12 is in the functional block below, over a company that has posted documents.
    const partyA = await seedParty(db, a, {
      kind: "customer",
      code: "ISO-C",
      receivableAccountId: a.cash,
    });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`
        insert into app.party_ageing (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount)
        values (${a.tenant}, ${a.company}, ${partyA}, 'MYR', '2026-01-31'::date, 'current', 100, 100)`;
      // Prove A can see its own row, so the zero B reads below is attributable to RLS and nothing else.
      const [own] = await tx<{ n: number }[]>`select count(*)::int as n from app.party_ageing`;
      expect(own!.n).toBe(1);
    });
    await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.party_ageing`;
      expect(n!.n).toBe(0);
      const [m] = await tx<{ n: number }[]>`select count(*)::int as n from app.item_profitability`;
      expect(m!.n).toBe(0);
    });
    // And B cannot write a row into A's tenant: the policy's WITH CHECK refuses it.
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`
          insert into app.party_ageing (tenant_id, company_id, party_id, currency, as_of, bucket)
          values (${a.tenant}, ${a.company}, ${partyA}, 'MYR', '2026-02-28'::date, 'current')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("lintSchema reports zero violations after 0048 (§3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});

// ── the two functions over posted documents ─────────────────────────────────────────────────────────────

interface AgeingRow {
  partyId: string;
  currency: string;
  bucket: string;
  amount: string;
  baseAmount: string;
}
interface ProfitRow {
  itemId: string;
  fiscalPeriodId: string;
  quantitySold: string;
  revenueBase: string;
  cogsBase: string;
  marginBase: string;
}

const ctxOf = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/** SALE_MOVEMENT_TYPES at 4B (amendment 6). Task 4 owns the constant; the function takes it as a parameter. */
const SALE_TYPES = ["DELIVERY_ORDER", "SALES_INVOICE", "SALES_CREDIT_NOTE"];

describe("app.party_ageing_rows and app.item_profitability_rows over posted documents", () => {
  let f: Seed;
  let invType: string;
  let cnType: string;
  let pinvType: string;
  let grnType: string;
  let doType: string;
  let productId: string;
  let baseUnitId: string;
  let serviceId: string;
  let warehouseId: string;
  let net30: string;
  let net90: string;
  let expenseId: string;
  const EUR = currency("EUR");

  beforeAll(async () => {
    f = await seedTenantV2(db, "ageing-f");
    // The existing authority must precede branch-keyed warehouse setup after 0068.
    await grantCodes(db, f, {
      codes: [
        "inventory.receipt.create",
        "inventory.receipt.post",
        "inventory.transfer.create",
        "inventory.transfer.post",
      ],
    });
    // `seedAccount` is idempotent on (company_id, code); 1200 and 2100 come with the first `seedParty`.
    for (const [code, nameEn, type] of [
      ["1100", "Bank", "asset"],
      ["1250", "Goods delivered not invoiced", "asset"],
      ["2150", "Goods received not invoiced", "liability"],
    ] as const) {
      await seedAccount(db, f, { code, nameEn, type });
    }
    await seedCurrency(db, f, { code: "EUR" });
    await seedRate(db, f, { from: "EUR", to: "MYR", on: "2026-01-01", rate: "4.80000000" });
    const types = await loadTypesFromPack(db, f, [
      "SALES_INVOICE",
      "SALES_CREDIT_NOTE",
      "PURCHASE_INVOICE",
      "GOODS_RECEIPT",
      "DELIVERY_ORDER",
    ]);
    invType = types.salesInvoiceType!;
    cnType = types.salesCreditNoteType!;
    pinvType = types.purchaseInvoiceType!;
    grnType = types.goodsReceiptType!;
    doType = types.deliveryOrderType!;
    ({ itemId: productId, baseUnitId } = await seedItem(db, f, {
      code: "P-AGE",
      kind: "product",
      trackLots: false,
    }));
    ({ itemId: serviceId } = await seedItem(db, f, {
      code: "S-AGE",
      kind: "service",
      baseUnitId,
    }));
    warehouseId = await seedWarehouse(db, f, { code: "WH-AGE" });
    net30 = await seedPaymentTerm(db, f, { code: "NET30", dueDays: 30 });
    net90 = await seedPaymentTerm(db, f, { code: "NET90", dueDays: 90 });
    expenseId = await accountByCode(db, f, "5900");
  }, 240_000);

  const ageing = (asOf: string, seed: Seed = f, companyId = f.company) =>
    withTenant(
      db.rw,
      seed.tenant,
      seed.human,
      (tx) => tx<AgeingRow[]>`
        select party_id as "partyId", currency::text as currency, bucket,
               amount::text as amount, base_amount::text as "baseAmount"
          from app.party_ageing_rows(${companyId}, ${asOf}::date)
         order by party_id, currency, bucket`,
    );
  const ageingOf = async (partyId: string, asOf: string) =>
    (await ageing(asOf))
      .filter((r) => r.partyId === partyId)
      .map(({ currency: c, bucket, amount, baseAmount }) => ({
        currency: c,
        bucket,
        amount,
        baseAmount,
      }));
  const profit = (seed: Seed = f, companyId = f.company) =>
    withTenant(
      db.rw,
      seed.tenant,
      seed.human,
      (tx) => tx<ProfitRow[]>`
        select item_id as "itemId", fiscal_period_id as "fiscalPeriodId",
               quantity_sold::text as "quantitySold", revenue_base::text as "revenueBase",
               cogs_base::text as "cogsBase", margin_base::text as "marginBase"
          from app.item_profitability_rows(${companyId}, ${SALE_TYPES}::text[])
         order by item_id, fiscal_period_id`,
    );
  const profitOf = async (itemId: string) => {
    const rows = (await profit()).filter((r) => r.itemId === itemId);
    expect(rows.every((r) => r.fiscalPeriodId === f.period)).toBe(true); // every fixture posts in January
    return rows.map(({ quantitySold, revenueBase, cogsBase, marginBase }) => ({
      quantitySold,
      revenueBase,
      cogsBase,
      marginBase,
    }));
  };

  /** One sales invoice of a single product line — one unit at `amount` unless `quantity`/`unitPrice` say
   *  otherwise (every figure a hand-chosen constant: no money through a float, even in a test). */
  const invoice = (
    partyId: string,
    effectiveDate: string,
    amount: string,
    opts: {
      paymentTermId?: string;
      currencyCode?: string;
      rate?: string;
      quantity?: string;
      unitPrice?: string;
    } = {},
  ) =>
    postArDocument(db, f, {
      documentTypeId: invType,
      series: "INV",
      partyId,
      effectiveDate,
      currency: opts.currencyCode ?? "MYR",
      exchangeRate: opts.rate ?? "1.00000000",
      ...(opts.paymentTermId === undefined ? {} : { paymentTermId: opts.paymentTermId }),
      lines: [
        {
          kind: "item",
          itemId: productId,
          quantity: opts.quantity ?? "1.000000",
          unitPrice: opts.unitPrice ?? amount,
          amount,
          cost: "1.0000",
        },
      ],
    });

  /** A PARTIAL credit note through 4A's creditNoteFrom: it points reverses_document_id at a still-POSTED
   *  invoice, so it is not a full reversal (which points at a document it left 'reversed') and it is an
   *  open item of its own. */
  const partialCredit = async (
    settledDocumentId: string,
    quantity: string,
    effectiveDate: string,
  ) => {
    const [line] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${settledDocumentId} order by line_no limit 1`;
    return withTenant(db.rw, f.tenant, f.human, async (tx) => {
      const r = await creditNoteFrom(tx, ctxOf(f), {
        companyId: f.company,
        settledDocumentId,
        targetDocumentTypeId: cnType,
        targetSeries: "CN",
        effectiveDate,
        reason: "part of the invoice was returned",
        lines: [{ settledLineId: line!.id, quantity }],
      });
      await issueDocument(tx, ctxOf(f), { documentId: r.documentId });
      await postDocument(tx, ctxOf(f), { documentId: r.documentId });
      return r.documentId;
    });
  };

  it("cuts buckets on the term PINNED on the document, never on the party's current term (amendment 3)", async () => {
    const c1 = await seedParty(db, f, { kind: "customer", code: "C-TERM" });
    await invoice(c1, "2026-01-05", "100.0000", { paymentTermId: net30 }); // due 2026-02-04
    await invoice(c1, "2026-01-10", "50.0000"); // no term: due on its effective date
    // The party's term changes AFTER both were drafted. Re-reading it would re-age history (SAH-013).
    await withTenant(
      db.rw,
      f.tenant,
      f.human,
      (tx) => tx`update app.party set payment_term_id = ${net90} where id = ${c1}`,
    );

    expect(await ageingOf(c1, "2026-01-31")).toEqual([
      { currency: "MYR", bucket: "1_30", amount: "50.0000", baseAmount: "50.0000" }, // 21 days past due
      { currency: "MYR", bucket: "current", amount: "100.0000", baseAmount: "100.0000" }, // due in 4 days
    ]);
    expect(await ageingOf(c1, "2026-04-30")).toEqual([
      { currency: "MYR", bucket: "61_90", amount: "100.0000", baseAmount: "100.0000" }, // 85 days
      { currency: "MYR", bucket: "over_90", amount: "50.0000", baseAmount: "50.0000" }, // 110 days
    ]);
    // As of a date before the second invoice existed, only the first is open.
    expect(await ageingOf(c1, "2026-01-07")).toEqual([
      { currency: "MYR", bucket: "current", amount: "100.0000", baseAmount: "100.0000" },
    ]);
  });

  it("a vendor's open bill is POSITIVE: the payable side is sign-flipped (§4.8.2)", async () => {
    const v1 = await seedParty(db, f, { kind: "vendor", code: "V-AGE" });
    await postArDocument(db, f, {
      documentTypeId: pinvType,
      series: "PINV",
      partyId: v1,
      effectiveDate: "2026-01-08",
      lines: [
        {
          kind: "account",
          accountId: expenseId,
          description: "stationery",
          amount: "80.0000",
          totalInclTax: "80.0000",
        },
      ],
    });
    expect(await ageingOf(v1, "2026-01-31")).toEqual([
      { currency: "MYR", bucket: "1_30", amount: "80.0000", baseAmount: "80.0000" },
    ]);
  });

  it("a FULL reversal nets its original once it is effective; before that the original is an ordinary open item", async () => {
    const c3 = await seedParty(db, f, { kind: "customer", code: "C-REV" });
    const inv = await invoice(c3, "2026-01-12", "70.0000");
    await withTenant(db.rw, f.tenant, f.human, (tx) =>
      reverseDocument(tx, ctxOf(f), {
        documentId: inv.documentId,
        effectiveDate: "2026-01-20",
        reason: "raised against the wrong customer",
      }),
    );
    // Both documents exist; the original is now 'reversed' and the mirror points at it.
    const docs = await db.admin<{ status: string; reverses: boolean }[]>`
      select status::text as status, reverses_document_id is not null as reverses
        from app.document where party_id = ${c3} order by effective_date`;
    expect(docs).toEqual([
      { status: "reversed", reverses: false },
      { status: "posted", reverses: true },
    ]);
    // As of the 15th the reversal does not exist yet, and the ledger as of that date still holds the invoice.
    expect(await ageingOf(c3, "2026-01-15")).toEqual([
      { currency: "MYR", bucket: "1_30", amount: "70.0000", baseAmount: "70.0000" },
    ]);
    // From the 20th the pair cancels: neither the 'reversed' original nor the posted mirror is open.
    expect(await ageingOf(c3, "2026-01-20")).toEqual([]);
    expect(await ageingOf(c3, "2026-04-30")).toEqual([]);
  });

  it("a reversal that is itself reversed pairs with ITS reversal: the chain nets in pairs, as the ledger does", async () => {
    // A JOURNAL (reversal.producesType JOURNAL, so it can be reversed twice) that charges the party's 1200.
    // Netting every document that touches a 'reversed' one would drop all three while the control account
    // still holds the re-instated charge — the tie-out off by exactly that charge.
    await grantCodes(db, f, { codes: ["accounting.journal.post"] });
    const c7 = await seedParty(db, f, { kind: "customer", code: "C-CHAIN" });
    const receivable = await accountByCode(db, f, "1200");
    const sales = await accountByCode(db, f, "4000");
    const jv = await postArDocument(db, f, {
      documentTypeId: f.docType,
      series: "JV",
      partyId: c7,
      effectiveDate: "2026-01-14",
      lines: [
        { kind: "account", accountId: receivable, debit: "40.0000" },
        { kind: "account", accountId: sales, credit: "40.0000" },
      ],
    });
    const reverse = (documentId: string, effectiveDate: string) =>
      withTenant(db.rw, f.tenant, f.human, (tx) =>
        reverseDocument(tx, ctxOf(f), { documentId, effectiveDate, reason: "chain case" }),
      );
    const r1 = await reverse(jv.documentId, "2026-01-16");
    await reverse(r1.reversalDocumentId, "2026-01-18");

    expect(await ageingOf(c7, "2026-01-15")).toEqual([
      { currency: "MYR", bucket: "1_30", amount: "40.0000", baseAmount: "40.0000" },
    ]);
    expect(await ageingOf(c7, "2026-01-17")).toEqual([]); // the journal and its reversal cancel
    // The re-reversal re-instates the charge on the 18th, and it is open from then — at its own date.
    expect(await ageingOf(c7, "2026-01-31")).toEqual([
      { currency: "MYR", bucket: "1_30", amount: "40.0000", baseAmount: "40.0000" },
    ]);
    const [ledger] = await db.admin<{ net: string }[]>`
      select sum(l.base_debit - l.base_credit)::numeric(19,4)::text as net
        from app.ledger_entry l join app.document d on d.id = l.document_id
       where d.party_id = ${c7} and l.account_id = ${receivable}`;
    expect(ledger!.net).toBe("40.0000");
  });

  it("a PARTIAL credit note is a negative open item until allocated; the allocation relieves both sides, the settlement at its own base", async () => {
    const c4 = await seedParty(db, f, { kind: "customer", code: "C-CN" });
    // inv4: 2 × 100 EUR at 4.8 → 960.0000 base; inv5: 150 EUR at 5.0 → 750.0000 base.
    const inv4 = await invoice(c4, "2026-01-02", "200.0000", {
      currencyCode: "EUR",
      rate: "4.80000000",
      quantity: "2.000000",
      unitPrice: "100.0000",
    });
    const inv5 = await invoice(c4, "2026-01-03", "150.0000", {
      currencyCode: "EUR",
      rate: "5.00000000",
    });
    // One unit of inv4 credited on the 31st, so the note lands in `current` and is visible on its own.
    // creditNoteFrom copies inv4's rate (4.8) and 4A negates its magnitudes: −100 EUR, −480 base.
    const cn = await partialCredit(inv4.documentId, "1.000000", "2026-01-31");
    const [note] = await db.admin<{ t: string; rate: string; reversesPosted: boolean }[]>`
      select coalesce(sum(dl.total_incl_tax), 0)::text as t, d.exchange_rate::text as rate,
             (select o.status = 'posted' from app.document o where o.id = d.reverses_document_id)
               as "reversesPosted"
        from app.document d join app.document_line dl on dl.document_id = d.id
       where d.id = ${cn} group by d.id`;
    expect(note).toEqual({ t: "-100.0000", rate: "4.80000000", reversesPosted: true });

    // Before any allocation: every document is open at its own figure; the note is NEGATIVE.
    expect(await ageingOf(c4, "2026-01-31")).toEqual([
      { currency: "EUR", bucket: "1_30", amount: "350.0000", baseAmount: "1710.0000" },
      { currency: "EUR", bucket: "current", amount: "-100.0000", baseAmount: "-480.0000" },
    ]);

    // The note settles inv5, not inv4: what relieves a document is an allocation, never a
    // reverses_document_id. At the note's rate its 100 EUR is 480.0000; at inv5's it is 500.0000, so
    // fx_difference = settlement base − settled base = −20.0000 (§4.8.1).
    const { fxDifference } = await withTenant(db.rw, f.tenant, f.human, (tx) =>
      allocateSettlement(tx, ctxOf(f), {
        companyId: f.company,
        settlementDocumentId: cn,
        lines: [{ settledDocumentId: inv5.documentId, amount: Money.of("100.0000", EUR) }],
      }),
    );
    expect(fxDifference.toString()).toBe("-20.0000");

    // inv5 is relieved at ITS rate (500.0000 of 750.0000) and the note at ITS OWN base (480.0000 of
    // 480.0000), so the note leaves the ageing in both currency and base, and inv4 is untouched.
    expect(await ageingOf(c4, "2026-01-31")).toEqual([
      { currency: "EUR", bucket: "1_30", amount: "250.0000", baseAmount: "1210.0000" },
    ]);
    // As of the 20th the note does not exist, so its allocation counts on NEITHER side (the as-of guard is
    // symmetric) and inv5 is fully open again.
    expect(await ageingOf(c4, "2026-01-20")).toEqual([
      { currency: "EUR", bucket: "1_30", amount: "350.0000", baseAmount: "1710.0000" },
    ]);
  });

  it("a relief always shrinks |open|: a refund applied to a credit note clears both, though each sits on the other side", async () => {
    const c6 = await seedParty(db, f, { kind: "customer", code: "C-REFUND" });
    const bank = await accountByCode(db, f, "1100");
    const inv = await invoice(c6, "2026-01-11", "60.0000", {
      quantity: "2.000000",
      unitPrice: "30.0000",
    });
    const cn = await partialCredit(inv.documentId, "1.000000", "2026-01-12"); // −30.0000, on the credit side
    // The refund DEBITS the receivable (an account line paid out of the bank), so it and the note sit on
    // opposite sides of the control account. A relief added to a negative figure, or subtracted from a
    // positive one, regardless of side would put −60 and +60 in this party's ageing instead of nothing. The
    // refund carries NET30 so it ages in `current` while the note ages in `1_30`: in one bucket the two wrong
    // figures would net to zero and hide each other. The NOTE is the settlement: since the Phase 4 review (S2)
    // the settlement side must be a settlement or a credit note by its pinned policy, and the refund here is
    // drafted as a SALES_INVOICE — so it is the settled document, and the relief still shrinks both.
    const refund = await postArDocument(db, f, {
      documentTypeId: invType,
      series: "INV",
      partyId: c6,
      effectiveDate: "2026-01-13",
      paymentTermId: net30,
      lines: [
        {
          kind: "account",
          accountId: bank,
          description: "refund of the credited unit",
          amount: "30.0000",
          totalInclTax: "30.0000",
        },
      ],
    });
    await withTenant(db.rw, f.tenant, f.human, (tx) =>
      allocateSettlement(tx, ctxOf(f), {
        companyId: f.company,
        settlementDocumentId: cn,
        lines: [
          { settledDocumentId: refund.documentId, amount: Money.of("30.0000", currency("MYR")) },
        ],
      }),
    );
    // Only the invoice is open; the note and the refund cancel through the allocation.
    expect(await ageingOf(c6, "2026-01-31")).toEqual([
      { currency: "MYR", bucket: "1_30", amount: "60.0000", baseAmount: "60.0000" },
    ]);
  });

  it("Σ base_amount ties to the control accounts: 1200 plus the unposted realised FX, and 2100 un-flipped (amendment 4)", async () => {
    const asOf = "2026-04-30";
    const [tie] = await withTenant(
      db.rw,
      f.tenant,
      f.human,
      (tx) => tx<
        {
          ageingCustomer: string;
          ageingVendor: string;
          ledger1200: string;
          ledger2100: string;
          fx: string;
        }[]
      >`
        with r as (select * from app.party_ageing_rows(${f.company}, ${asOf}::date))
        select
          (select coalesce(sum(r.base_amount), 0) from r join app.party p on p.id = r.party_id
            where p.kind <> 'vendor')::numeric(19,4)::text as "ageingCustomer",
          (select coalesce(sum(r.base_amount), 0) from r join app.party p on p.id = r.party_id
            where p.kind = 'vendor')::numeric(19,4)::text as "ageingVendor",
          (select coalesce(sum(l.base_debit - l.base_credit), 0) from app.ledger_entry l
             join app.account ac on ac.id = l.account_id
            where l.company_id = ${f.company} and ac.code = '1200'
              and l.effective_date <= ${asOf}::date)::numeric(19,4)::text as "ledger1200",
          (select coalesce(sum(l.base_debit - l.base_credit), 0) from app.ledger_entry l
             join app.account ac on ac.id = l.account_id
            where l.company_id = ${f.company} and ac.code = '2100'
              and l.effective_date <= ${asOf}::date)::numeric(19,4)::text as "ledger2100",
          (select coalesce(sum(al.fx_difference), 0) from app.allocation al
            where al.company_id = ${f.company} and al.unallocated_at is null)::numeric(19,4)::text as fx`,
    );
    // Task 5 posts the realised difference to the control account; until then the ageing is the ledger
    // plus that difference, exactly (ADR 0047). With it posted the equality is the DoD's.
    const base = currency("MYR");
    expect(Money.of(tie!.ageingCustomer, base).toString()).toBe(
      Money.of(tie!.ledger1200, base).add(Money.of(tie!.fx, base)).toString(),
    );
    expect(Money.of(tie!.ageingVendor, base).toString()).toBe(
      Money.of(tie!.ledger2100, base).negate().toString(),
    );
    expect(Money.of(tie!.fx, base).isZero()).toBe(false); // the FX case above really ran
  });

  it("item_profitability_rows: quantity and COGS from the delivery, revenue from the invoice, on one (item, period) row", async () => {
    const vendor = await seedParty(db, f, { kind: "vendor", code: "V-GRN" });
    const customer = await seedParty(db, f, { kind: "customer", code: "C-PROFIT" });
    const post = async (documentId: string) =>
      withTenant(db.rw, f.tenant, f.human, async (tx) => {
        await issueDocument(tx, ctxOf(f), { documentId });
        await postDocument(tx, ctxOf(f), { documentId });
      });
    // 10 in at 3.0000; 4 out on a delivery → one consumption of 12.0000.
    const grn = await draftTypedDocument(db, f, {
      documentTypeId: grnType,
      series: "GRN",
      effectiveDate: "2026-01-04",
      partyId: vendor,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId: productId,
          warehouseId,
          unitId: baseUnitId,
          quantity: "10.000000",
          unitPrice: "3.0000",
          amount: "30.0000",
        },
      ],
    });
    await post(grn.documentId);
    const delivery = await draftTypedDocument(db, f, {
      documentTypeId: doType,
      series: "DO",
      effectiveDate: "2026-01-06",
      partyId: customer,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId: productId,
          warehouseId,
          unitId: baseUnitId,
          quantity: "4.000000",
          unitPrice: "9.0000",
          amount: "36.0000",
        },
      ],
    });
    await post(delivery.documentId);
    const before = await profitOf(productId);
    // The delivery alone: quantity and cost, NO revenue (it posts to 1250, not the item's revenue account).
    // Every product invoice above also sits in this row with its revenue; read the delta, not the total.
    const inv = await postArDocument(db, f, {
      documentTypeId: invType,
      series: "INV",
      partyId: customer,
      effectiveDate: "2026-01-07",
      lines: [
        {
          kind: "item",
          itemId: productId,
          quantity: "4.000000",
          unitPrice: "9.0000",
          amount: "36.0000",
          cost: "12.0000",
        },
      ],
    });
    const after = await profitOf(productId);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    const MYR = currency("MYR");
    const delta = (k: "quantitySold" | "revenueBase" | "cogsBase" | "marginBase") =>
      k === "quantitySold"
        ? [before[0]![k], after[0]![k]]
        : Money.of(after[0]![k], MYR).subtract(Money.of(before[0]![k], MYR)).toString();
    // The invoice adds revenue only: its COGS debit (5000) never moves doc_sign, and it carries no movement.
    expect(delta("revenueBase")).toBe("36.0000");
    expect(delta("cogsBase")).toBe("0.0000");
    expect(after[0]!.quantitySold).toBe(before[0]!.quantitySold);
    // And the delivery's own contribution is quantity 4 at a cost of 12.0000.
    const [mv] = await db.admin<{ q: string; v: string }[]>`
      select sum(-m.quantity)::numeric(19,6)::text as q, sum(c.value)::numeric(19,4)::text as v
        from app.inventory_movement m join app.cost_consumption c on c.movement_id = m.id
       where m.document_id = ${delivery.documentId} and c.invalidated_at is null`;
    expect(mv).toEqual({ q: "4.000000", v: "12.0000" });
    expect(after[0]!.quantitySold).toBe("4.000000"); // the only movement of a sale type for this item
    expect(after[0]!.cogsBase).toBe("12.0000");
    expect(Money.of(after[0]!.marginBase, MYR).toString()).toBe(
      Money.of(after[0]!.revenueBase, MYR).subtract(Money.of("12.0000", MYR)).toString(),
    );
    // A partial credit of one unit subtracts 9.0000 of revenue and moves no stock (ADR 0044).
    await partialCredit(inv.documentId, "1.000000", "2026-01-08");
    const credited = await profitOf(productId);
    expect(
      Money.of(after[0]!.revenueBase, MYR)
        .subtract(Money.of(credited[0]!.revenueBase, MYR))
        .toString(),
    ).toBe("9.0000");
    expect(credited[0]!.quantitySold).toBe("4.000000");
  });

  it("item_profitability_rows: revenue is at the document's rate and keeps each LINE's sign (a mixed-sign invoice)", async () => {
    const customer = await seedParty(db, f, { kind: "customer", code: "C-MIXED" });
    // +2 × 50 and −1 × 50 EUR at 4.8: the ledger credits revenue 480.0000 and debits it 240.0000.
    const inv = await postArDocument(db, f, {
      documentTypeId: invType,
      series: "INV",
      partyId: customer,
      effectiveDate: "2026-01-09",
      currency: "EUR",
      exchangeRate: "4.80000000",
      lines: [
        {
          kind: "item",
          itemId: serviceId,
          quantity: "2.000000",
          unitPrice: "50.0000",
          amount: "100.0000",
        },
        {
          kind: "item",
          itemId: serviceId,
          quantity: "-1.000000",
          unitPrice: "50.0000",
          amount: "-50.0000",
        },
      ],
    });
    const [ledger] = await db.admin<{ net: string }[]>`
      select sum(l.base_credit - l.base_debit)::numeric(19,4)::text as net
        from app.ledger_entry l join app.item i on i.revenue_account_id = l.account_id
       where l.document_id = ${inv.documentId} and i.id = ${serviceId}`;
    expect(ledger!.net).toBe("240.0000");
    // The projection agrees with the ledger: 480 − 240, not abs() → 480 + 240.
    expect(await profitOf(serviceId)).toEqual([
      {
        quantitySold: "0.000000",
        revenueBase: "240.0000",
        cogsBase: "0.0000",
        marginBase: "240.0000",
      },
    ]);
  });

  it("tenant B sees none of the company's figures through either function (test 12)", async () => {
    // The company HAS rows — asserted first, so the empty reads below are RLS and nothing else.
    expect((await ageing("2026-04-30")).length).toBeGreaterThan(0);
    expect((await profit()).length).toBeGreaterThan(0);
    expect(await ageing("2026-04-30", b, f.company)).toEqual([]);
    expect(await profit(b, f.company)).toEqual([]);
  });
});
