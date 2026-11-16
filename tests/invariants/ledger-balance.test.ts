import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts";
import {
  checkLedgerBalance,
  creditNoteFrom,
  issueDocument,
  postDocument,
  withTenant,
} from "@dulja/db";
import { loadDocumentTypes } from "@dulja/db/seed";
import {
  grantCodes,
  seedAccount,
  seedCurrency,
  seedDocumentType,
  seedItem,
  seedParty,
  seedRate,
  seedTenantV2,
  seedWarehouse,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { REPO_ROOT } from "../support/source";
import { postArDocument, type ArLine } from "./support/post-ar";
import {
  ensureOpenPeriods,
  postInventoryDocument,
  recordingJobs,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "./support/post-inventory";
import { postJournal } from "./support/post-journal";

describe("ledger balance invariant — Σbase debit = Σbase credit (spec:2246, 2419; SAH-003)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    b = await seedTenantV2(db, "Beta");
  });
  afterAll(async () => {
    await db.stop();
  });

  const ctxFor = async (seed: Seed) => ({
    tenantId: seed.tenant,
    actorId: seed.human,
    requestId: await uuidv7(db.admin),
  });

  it("reports nothing for a tenant whose every document balances", async () => {
    await postJournal(db, a, [
      { account: a.cash, debit: "100.0000" },
      { account: a.sales, credit: "100.0000" },
    ]);
    await postJournal(db, a, [
      { account: a.cash, debit: "250.5000" },
      { account: a.sales, credit: "250.5000" },
    ]);
    const result = await withTenant(db.rw, await ctxFor(a), (tx) => checkLedgerBalance(tx));
    expect(result).toEqual({ byPeriod: [], byDocument: [] });
  });

  it("sees only its own tenant's entries — Beta's postings never enter Alpha's totals (SAH-035)", async () => {
    await postJournal(db, b, [
      { account: b.cash, debit: "999.0000" },
      { account: b.sales, credit: "999.0000" },
    ]);
    const result = await withTenant(db.rw, await ctxFor(a), (tx) => checkLedgerBalance(tx));
    expect(result).toEqual({ byPeriod: [], byDocument: [] });
  });

  it("balances in BASE, not in document currency — a foreign-currency document is clean", async () => {
    // Seeded as well as written onto the header: assumption 3 — §4.3.2 step 6 does not say whether 1A
    // trusts document.exchange_rate or re-resolves through app.rate_for, and app.rate_for with no row
    // is ERR_RATE_NOT_FOUND (§4.2.10, §4.3.7). With both in place the case passes under either reading.
    await withTenant(
      db.rw,
      await ctxFor(a),
      (
        tx,
      ) => tx`insert into app.currency (tenant_id, code, name_en) values (${a.tenant}, 'USD', 'US dollar')
                 on conflict (tenant_id, code) do nothing`,
    );
    await seedRate(db, a, { from: "USD", to: "MYR", on: "2026-01-01", rate: "4.20000000" });
    const { documentId } = await postJournal(
      db,
      a,
      [
        { account: a.cash, debit: "100.0000" },
        { account: a.sales, credit: "100.0000" },
      ],
      { currency: "USD", rate: "4.20000000" },
    );
    const result = await withTenant(db.rw, await ctxFor(a), (tx) => checkLedgerBalance(tx));
    expect(result.byDocument.map((row) => row.subjectId)).not.toContain(documentId);
  });

  it("names the company, the period and the signed difference when a period does not balance", async () => {
    const ctx = await ctxFor(a);
    const strayPeriod = a.closedPeriod;
    const [doc] = await withTenant(
      db.migrator,
      ctx,
      (tx) => tx<{ id: string }[]>`
      select id::text from app.document where company_id = ${a.company} and status = 'posted' order by posting_seq limit 1`,
    );
    await withTenant(
      db.migrator,
      ctx,
      (
        tx,
      ) => tx`update app.fiscal_period set status = 'open', reopen_reason = 'stray-period fixture'
                  where id = ${strayPeriod}`,
    );
    // TWO lines, on one already-posted document, landing in DIFFERENT open periods: +5.0000 in the stray
    // period and −5.0000 in the document's own. The document still sums to zero, so the deferred
    // ledger_entry_balanced constraint (0001 §7, which re-sums the WHOLE document at COMMIT) passes and
    // the transaction commits; both periods are open, so assert_period_open passes on both. The imbalance
    // exists only at the (company, period) grain — which is exactly the grain the per-document constraint
    // cannot express and this function exists to cover.
    await withTenant(
      db.migrator,
      ctx,
      (tx) => tx`
      insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id, debit, credit,
                                    currency, exchange_rate, base_debit, base_credit, effective_date,
                                    fiscal_period_id, posting_policy_id)
      values (${a.tenant}, ${a.company}, ${doc!.id}, 900, ${a.cash}, 5.0000, 0, 'MYR', 1, 5.0000, 0,
              '2026-02-10', ${strayPeriod}, ${a.policy}),
             (${a.tenant}, ${a.company}, ${doc!.id}, 901, ${a.cash}, 0, 5.0000, 'MYR', 1, 0, 5.0000,
              '2026-01-16', ${a.period}, ${a.policy})`,
    );

    const result = await withTenant(db.rw, ctx, (tx) => checkLedgerBalance(tx));
    expect(
      [...result.byPeriod].toSorted((left, right) => left.subjectId.localeCompare(right.subjectId)),
    ).toEqual(
      [
        {
          scope: "period",
          companyId: a.company,
          subjectId: strayPeriod,
          baseDebit: "5.0000",
          baseCredit: "0.0000",
          difference: "5.0000",
        },
        {
          scope: "period",
          companyId: a.company,
          subjectId: a.period,
          baseDebit: expect.any(String),
          baseCredit: expect.any(String),
          difference: "-5.0000",
        },
      ].toSorted((left, right) => left.subjectId.localeCompare(right.subjectId)),
    );
    // The document itself still balances, and under migration 0001's deferred constraint it always will:
    // byDocument is unreachable in a healthy database and is kept as the backstop for a database whose
    // constraint was dropped or whose rows arrived by restore.
    expect(result.byDocument).toEqual([]);
  });

  it("narrows to one company when companyId is given", async () => {
    const result = await withTenant(db.rw, await ctxFor(a), (tx) =>
      checkLedgerBalance(tx, { companyId: a.company }),
    );
    expect(result.byPeriod.every((row) => row.companyId === a.company)).toBe(true);
  });
});

// ── 3B: appended at the END of the file — the invariant holds when the amounts come from the
//        costing engine (test 1 re-run) ──────────────────────────────────────────────────────────
describe("SAH-003 ledger invariant — inventory-bearing documents (test 1 re-run, 3B)", () => {
  let db: Db;
  let s: Seed;
  let receiptType: string;
  let issueType: string;
  let itemId: string;
  let warehouseId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Invariant-3B");
    // The plan writes a bare `grantCodes(db, s)` here; that call grants NOTHING (§4.17), and 2B's
    // BEFORE UPDATE OF status trigger gates issued → posted on `policy.approval.post`, which both
    // policies below set to `accounting.journal.post`. The code is named so the post is authorised.
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    receiptType = await seedDocumentType(db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    issueType = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    // trackLots: false deliberately. app.item defaults track_lots to true (0028, spec:1022 — food is
    // batch-tracked), and planMovements refuses a DECLARED receipt of a lot-tracked item that carries no
    // lot (3A Task 7 rule 8). The receipts below carry none, so the default would raise
    // ERR_POLICY_REQUIRES_MISSING before this file's balance property ever ran.
    ({ itemId } = await seedItem(db, s, { code: "INV-1", trackLots: false }));
    warehouseId = await seedWarehouse(db, s, { code: "INV-WH" });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("Σ base debit = Σ base credit over a random receipt/issue interleaving", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            receipt: fc.boolean(),
            qty: fc.integer({ min: 1, max: 40 }),
            price: fc.integer({ min: 1, max: 9_999 }),
          }),
          { minLength: 2, maxLength: 8 },
        ),
        async (steps) => {
          const jobs = recordingJobs();
          // A receipt first, always: an issue against no layer is ERR_STOCK_INSUFFICIENT by design (Task 2),
          // which is a refusal, not an imbalance, and the property is about what DOES post.
          const script = [{ receipt: true, qty: 100, price: 1_000 }, ...steps];
          let onHand = 0;
          for (const step of script) {
            const isReceipt = step.receipt || onHand < step.qty;
            await postInventoryDocument(db, s, {
              documentTypeId: isReceipt ? receiptType : issueType,
              warehouseId,
              jobs,
              lines: [
                {
                  itemId,
                  warehouseId,
                  quantity: `${step.qty}.000000`,
                  unitPrice: `${step.price}.0000`,
                },
              ],
            });
            onHand += isReceipt ? step.qty : -step.qty;
          }
          const [sums] = await withTenant(
            db.rw,
            { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
            (tx) => tx<{ d: string; c: string }[]>`
              select coalesce(sum(base_debit), 0)::text as d, coalesce(sum(base_credit), 0)::text as c
                from app.ledger_entry where company_id = ${s.company}`,
          );
          expect(sums!.d).toBe(sums!.c);
        },
      ),
      { numRuns: 15, endOnFailure: true },
    );
  }, 600_000);

  it("every posted movement carries a non-null value and every layer a non-negative unit cost (test 6's stored-row half)", async () => {
    const bad = await withTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ movements: number; layers: number }[]>`
        select (select count(*)::int from app.inventory_movement where value is null) as movements,
               (select count(*)::int from app.cost_layer where unit_cost < 0 or qty_remaining < 0) as layers`,
    );
    expect(bad[0]).toEqual({ movements: 0, layers: 0 });
  });
});

// ── 4A: appended at the END of the file — the invariant holds over the six AR/AP types, posted through the
//        real postDocument (test 1 re-run, contracts §6.1 row 1; 4A Task 14) ─────────────────────────────
type ArType =
  | "SALES_INVOICE"
  | "SALES_CREDIT_NOTE"
  | "PURCHASE_INVOICE"
  | "PURCHASE_CREDIT_NOTE"
  | "RECEIPT"
  | "PAYMENT";

const AR_TYPES: readonly ArType[] = [
  "SALES_INVOICE",
  "SALES_CREDIT_NOTE",
  "PURCHASE_INVOICE",
  "PURCHASE_CREDIT_NOTE",
  "RECEIPT",
  "PAYMENT",
];

/** Each type's `numbering.series`, as its seed-pack file declares it (§4.14). */
const AR_SERIES: Readonly<Record<ArType, string>> = {
  SALES_INVOICE: "INV",
  SALES_CREDIT_NOTE: "CN",
  PURCHASE_INVOICE: "PINV",
  PURCHASE_CREDIT_NOTE: "PCN",
  RECEIPT: "RCT",
  PAYMENT: "PAY-OUT",
};

/** One generated line. Money is an exact count of 0.0001 units in a `bigint` — never a float — and becomes a
 *  4-dp string at the edge (no-number-money, §3.7.5). `qty` is a small whole count, not money. */
interface GenLine {
  kind: "product" | "service" | "account";
  qty: number;
  unitUnits: bigint;
  /** The copied cost of a sales product line, as a share of its amount in 1/10 000ths: cost ∈ [0, amount]. */
  costShare: number;
  /** How many of `qty` a credit note takes back (0 = this line is not credited). */
  creditQty: number;
}

interface GenDoc {
  type: ArType;
  eur: boolean;
  /** An 8-dp EUR→MYR rate as a count of 1e-8 units, ∈ [0.5, 9.5]. */
  rateUnits: bigint;
  month: number;
  day: number;
  lines: GenLine[];
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
/** An exact decimal string from a count of 10^-scale units. */
const decimal = (units: bigint, scale: number): string => {
  const unit = 10n ** BigInt(scale);
  return `${units / unit}.${(units % unit).toString().padStart(scale, "0")}`;
};

/** fast-check over: type ∈ the six, currency ∈ {MYR, EUR}, rate ∈ [0.5, 9.5] at 8 dp, a date anywhere in
 *  2026, 1–5 lines of product / service / charge, amount = qty × unit price ∈ [0.0100, 99 999.9980] at 4 dp,
 *  and for a sales product line a copied cost ∈ [0, amount] — the plan's generator, with the amount built
 *  from a unit price so every line's figures are the ones a real line carries. */
function arArbitrary(): fc.Arbitrary<GenDoc> {
  return fc.record({
    type: fc.constantFrom(...AR_TYPES),
    eur: fc.boolean(),
    rateUnits: fc.bigInt({ min: 50_000_000n, max: 950_000_000n }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    lines: fc.array(
      fc
        .record({
          kind: fc.constantFrom<GenLine["kind"]>("product", "service", "account"),
          qty: fc.integer({ min: 1, max: 20 }),
          // Bounded so qty × unit ≤ 99 999.9980 for any qty ≤ 20: amount ∈ [0.0100, 99 999.99].
          unitUnits: fc.bigInt({ min: 100n, max: 49_999_999n }),
          costShare: fc.integer({ min: 0, max: 10_000 }),
          creditFraction: fc.integer({ min: 0, max: 100 }),
        })
        .map(({ creditFraction, ...line }) => ({
          ...line,
          creditQty: Math.floor((line.qty * creditFraction) / 100),
        })),
      { minLength: 1, maxLength: 5 },
    ),
  });
}

describe("SAH-003 ledger invariant — the six 4A AR/AP types under fuzz (test 1 re-run, 4A)", () => {
  let db: Db;
  let s: Seed;
  let types: Record<string, string>;
  let customer: string;
  let vendor: string;
  let bank: string;
  let expense: string;
  let productItem: string;
  let serviceItem: string;
  const posted = new Map<ArType, number>();

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Invariant-4A");
    // Every month of 2026 open, so the property can land a document in any period and the balance is
    // checked per (company, fiscal period) — spec:2419's grain — not only in seedTenant's January.
    await ensureOpenPeriods(db, s, 2026);
    // The accounts the six policies resolve (4A seeds none — hazard 33's converse; §4.15 names each one's
    // seeder). `4000` is seedTenantV2's; `5900` is the charge account a purchase invoice's expense line debits.
    const ids: Record<string, string> = {};
    for (const [code, nameEn, type] of [
      ["1100", "Bank", "asset"],
      ["1200", "Trade receivables", "asset"],
      ["1250", "Goods delivered not invoiced", "asset"],
      ["2100", "Trade payables", "liability"],
      ["2150", "Goods received not invoiced", "liability"],
      ["5000", "Cost of goods sold", "expense"],
      ["5900", "Other operating expense", "expense"],
    ] as const) {
      ids[code] = await seedAccount(db, s, { code, nameEn, type });
    }
    bank = ids["1100"]!;
    expense = ids["5900"]!;
    // The policies come from the SEED PACK, through 0C's own loader — never a transcription of them.
    const seeded = await loadDocumentTypes(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      join(REPO_ROOT, "packages", "db", "seed", "my", "document-types"),
      PERMISSIONS.map((p) => p.code),
    );
    types = Object.fromEntries(seeded.map((row) => [row.code, row.documentTypeId]));
    for (const code of AR_TYPES) expect(types[code], code).toBeDefined();
    await seedCurrency(db, s, { code: "EUR" });
    await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-01-01", rate: "4.80000000" });
    customer = await seedParty(db, s, { kind: "customer", code: "CUST-4A-FUZZ" });
    vendor = await seedParty(db, s, { kind: "vendor", code: "VEND-4A-FUZZ" });
    ({ itemId: productItem } = await seedItem(db, s, { code: "FUZZ-P", trackLots: false }));
    ({ itemId: serviceItem } = await seedItem(db, s, {
      code: "FUZZ-S",
      kind: "service",
      trackLots: false,
    }));
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  const tally = (type: ArType): void => {
    posted.set(type, (posted.get(type) ?? 0) + 1);
  };

  const ctxFor = async () => ({
    tenantId: s.tenant,
    actorId: s.human,
    requestId: await uuidv7(db.admin),
  });

  /** A generated line as `postArDocument` takes it. A credit note's parent carries item lines only, because
   *  `creditNoteFrom` bounds a credit by quantity and a charge line has none (4A Task 8). */
  function arLine(line: GenLine, side: "sales" | "purchase", itemOnly: boolean): ArLine {
    const kind = itemOnly && line.kind === "account" ? "service" : line.kind;
    const amountUnits = line.unitUnits * BigInt(line.qty);
    const amount = decimal(amountUnits, 4);
    if (kind === "account") {
      return { kind: "account", accountId: side === "sales" ? s.sales : expense, amount };
    }
    return {
      kind: "item",
      itemId: kind === "product" ? productItem : serviceItem,
      quantity: `${line.qty}.000000`,
      unitPrice: decimal(line.unitUnits, 4),
      amount,
      // A SALES_INVOICE product line carries the cost a conversion copies from its delivery (§4.7.2), in
      // base; a null one is refused by design (4A Task 4), so the fuzz always supplies one, zero included.
      ...(side === "sales" && kind === "product"
        ? { cost: decimal((amountUnits * BigInt(line.costShare)) / 10_000n, 4) }
        : {}),
    };
  }

  /** Posts one generated document through the REAL services — `postArDocument` for the four that are drafted
   *  directly (PAYMENT's second principal included), and `creditNoteFrom` over a posted invoice for the two
   *  credit notes, which `requires: [reverses_document]` makes impossible to draft any other way. */
  async function postGenerated(spec: GenDoc): Promise<void> {
    const effectiveDate = `2026-${pad2(spec.month)}-${pad2(spec.day)}`;
    const money = spec.eur ? { currency: "EUR", exchangeRate: decimal(spec.rateUnits, 8) } : {};
    const sales = spec.type.startsWith("SALES_") || spec.type === "RECEIPT";
    const partyId = sales ? customer : vendor;

    if (spec.type === "RECEIPT" || spec.type === "PAYMENT") {
      await postArDocument(db, s, {
        documentTypeId: types[spec.type]!,
        series: AR_SERIES[spec.type],
        effectiveDate,
        partyId,
        ...money,
        lines: spec.lines.map((line) => ({
          kind: "account",
          accountId: bank,
          amount: decimal(line.unitUnits * BigInt(line.qty), 4),
        })),
        // Money out needs two principals (spec:2147): submitted by the maker, approved and posted by another.
        twoPrincipal: spec.type === "PAYMENT",
      });
      tally(spec.type);
      return;
    }

    const creditNote = spec.type === "SALES_CREDIT_NOTE" || spec.type === "PURCHASE_CREDIT_NOTE";
    const invoiceType: ArType = sales ? "SALES_INVOICE" : "PURCHASE_INVOICE";
    const invoice = await postArDocument(db, s, {
      documentTypeId: types[invoiceType]!,
      series: AR_SERIES[invoiceType],
      effectiveDate,
      partyId,
      ...money,
      lines: spec.lines.map((line) => arLine(line, sales ? "sales" : "purchase", creditNote)),
    });
    tally(invoiceType);
    if (!creditNote) return;

    const invoiceLines = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${invoice.documentId} order by line_no`;
    const credited = spec.lines.flatMap((line, i) =>
      line.creditQty > 0
        ? [{ settledLineId: invoiceLines[i]!.id, quantity: `${line.creditQty}.000000` }]
        : [],
    );
    // At least one line comes back; a line credited for its whole quantity exercises the residue path.
    const lines =
      credited.length > 0
        ? credited
        : [{ settledLineId: invoiceLines[0]!.id, quantity: `${spec.lines[0]!.qty}.000000` }];
    const ctx = await ctxFor();
    await withTenant(db.rw, ctx, async (tx) => {
      const note = await creditNoteFrom(tx, ctx, {
        companyId: s.company,
        settledDocumentId: invoice.documentId,
        targetDocumentTypeId: types[spec.type]!,
        targetSeries: AR_SERIES[spec.type],
        effectiveDate,
        reason: "fuzz: goods returned",
        lines,
      });
      await issueDocument(tx, ctx, { documentId: note.documentId });
      await postDocument(tx, ctx, { documentId: note.documentId });
    });
    tally(spec.type);
  }

  it("test 1 re-run — Σdebit = Σcredit over 200 random AR/AP documents of the six 4A types", async () => {
    await fc.assert(
      fc.asyncProperty(arArbitrary(), async (spec) => {
        await postGenerated(spec);
        const ctx = await ctxFor();
        const [row] = await withTenant(
          db.rw,
          ctx,
          (tx) => tx<{ diff: string; broken: number }[]>`
            select coalesce(sum(base_debit) - sum(base_credit), 0)::numeric(19,4)::text as diff,
                   count(*) filter (where base_debit  <> round(debit  * exchange_rate, 4)
                                       or base_credit <> round(credit * exchange_rate, 4))::int as broken
              from app.ledger_entry where company_id = ${s.company}`,
        );
        expect(row!.diff).toBe("0.0000");
        // Test 8's share that is 4A's: base = round(value × rate, 4) on every line this slice posts.
        expect(row!.broken).toBe(0);
        // …and per (company, fiscal period) and per document, spec:2419's wording — 1B's own check.
        const balance = await withTenant(db.rw, ctx, (tx) =>
          checkLedgerBalance(tx, { companyId: s.company }),
        );
        expect(balance).toEqual({ byPeriod: [], byDocument: [] });
      }),
      { numRuns: 200, endOnFailure: true },
    );
    // The property ranged over all six types, and over more than one period.
    for (const code of AR_TYPES) expect(posted.get(code) ?? 0, code).toBeGreaterThan(0);
    const [periods] = await db.admin<{ n: number }[]>`
      select count(distinct fiscal_period_id)::int as n from app.ledger_entry where company_id = ${s.company}`;
    expect(periods!.n).toBeGreaterThan(1);
  }, 600_000);

  it("app.series_gaps is empty for INV, CN, PINV, PCN, RCT and PAY-OUT in every period the fuzz numbered", async () => {
    // Reads the counters the property above advanced (spec:2222, 2288; §4.5.5). Non-vacuous: each of the six
    // series must have issued at least one number, or the empty gap set proves nothing.
    const ctx = await ctxFor();
    const counters = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ series: string; period: string; issued: number; gaps: number }[]>`
        select s.series, s.fiscal_period_id::text as period, (s.next_number - 1)::int as issued,
               (select count(*)::int from app.series_gaps(s.company_id, s.series, s.fiscal_period_id)) as gaps
          from app.document_series s
         where s.company_id = ${s.company}
           and s.series in ('INV', 'CN', 'PINV', 'PCN', 'RCT', 'PAY-OUT')
         order by 1, 2`,
    );
    for (const series of Object.values(AR_SERIES)) {
      const issued = counters.filter((c) => c.series === series).reduce((n, c) => n + c.issued, 0);
      expect(issued, series).toBeGreaterThan(0);
    }
    expect(counters.filter((c) => c.gaps > 0)).toEqual([]);
  });
});
