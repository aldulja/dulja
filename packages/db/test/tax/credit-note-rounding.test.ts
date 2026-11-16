import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeDocumentTax,
  creditNoteFrom,
  issueDocument,
  linkFulfilment,
  postDocument,
  withTenant as prodWithTenant,
  type CreditNoteLine,
} from "../../src";
import { draftTypedDocument, seedCurrency, seedItem, startDb, type Db } from "../index";
import { postFromPack } from "../../../../tests/invariants/support/ar-ap";
import type { ArLine } from "../../../../tests/invariants/support/post-ar";
import { taxFixture, type TaxFixture } from "../../../../tests/invariants/support/tax";

// A PARTIAL credit note against a TAXED line (spec:2024, §4.14, 5A). `creditNoteFrom` used to pro-rate
// `amount`, `tax_amount` and `total_incl_tax` independently, each rounded on its own, so a credited line
// could carry `amount + tax_amount ≠ total_incl_tax`. Policy v2 posts the control leg from
// `line.total_incl_tax` and the revenue/expense and tax legs from `line.amount` and Σ `line.tax_amount`, and
// the evaluator's document-currency balance check has no tolerance — so the note could not post.
//
// The review's line: net 1.2344 at 11% is tax 0.1358 (0.135784) and gross 1.3702, over THREE units. A third
// of it pro-rated independently is net 0.4115, tax 0.0453 and gross 0.4567 — and 0.4115 + 0.0453 = 0.4568.
// The rule now: net and gross are pro-rated (the completing credit takes the residue of each), and the tax
// is DERIVED as gross − net, so every credited line is self-consistent and a full sequence of credits sums
// to the source line's tax exactly.

let db: Db;
let f: TaxFixture;

beforeAll(async () => {
  db = await startDb();
  f = await taxFixture(db, "cn-rounding");
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

type Side = "sales" | "purchase";
const SIDE = {
  sales: {
    invoice: "SALES_INVOICE",
    note: "SALES_CREDIT_NOTE",
    series: "CN",
    account: "4000",
    code: "SYN-OUT-STD",
  },
  purchase: {
    invoice: "PURCHASE_INVOICE",
    note: "PURCHASE_CREDIT_NOTE",
    series: "PCN",
    account: "5900",
    code: "SYN-IN-STD",
  },
} as const;

/** One line's figures as `app.document_line` stores them. */
interface Figures {
  quantity: string;
  amount: string;
  tax: string;
  total: string;
}

/** The review's line. */
const REVIEW_LINE: Figures = {
  quantity: "3.000000",
  amount: "1.2344",
  tax: "0.1358",
  total: "1.3702",
};

async function lineOf(documentId: string): Promise<Figures & { id: string }> {
  const [l] = await db.admin<(Figures & { id: string })[]>`
    select id, quantity::text as quantity, amount::text as amount, tax_amount::text as tax,
           total_incl_tax::text as total
      from app.document_line where document_id = ${documentId}`;
  return l!;
}

/** One posted invoice with ONE taxed account line — through 4B's `postFromPack`, which drafts, runs 5A's
 *  `computeDocumentTax` and posts through the real `postDocument`. An inclusive invoice enters the gross,
 *  which extracts to the same net and tax. */
async function taxedInvoice(
  side: Side,
  effectiveDate: string,
  source: Figures,
  inclusive: boolean,
) {
  const t = SIDE[side];
  const { documentId } = await postFromPack(db, f.s, {
    code: t.invoice,
    effectiveDate,
    partyId: side === "sales" ? f.customerId : f.vendorId,
    taxInclusive: inclusive,
    computeTax: true,
    lines: [
      {
        lineNo: 1,
        kind: "account",
        accountId: f.accounts[t.account]!,
        quantity: source.quantity,
        amount: inclusive ? source.total : source.amount,
        taxCodeId: f.codes[t.code]!,
      },
    ],
  });
  const line = await lineOf(documentId);
  // The precondition each scenario rests on: the source line it names.
  expect(line).toMatchObject(source);
  return { documentId, lineId: line.id };
}

/** Drafts the note through `creditNoteFrom`, issues and posts it in ONE transaction — the path the
 *  credit-note route and `postTaxedDocument` take. */
async function credit(
  side: Side,
  settledDocumentId: string,
  lines: readonly CreditNoteLine[],
  effectiveDate: string,
): Promise<string> {
  const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "cn-rounding" };
  return prodWithTenant(db.rw, ctx, async (tx) => {
    const note = await creditNoteFrom(tx, ctx, {
      companyId: f.s.company,
      settledDocumentId,
      targetDocumentTypeId: f.types[SIDE[side].note]!,
      targetSeries: SIDE[side].series,
      effectiveDate,
      reason: "partial credit of a taxed line",
      lines,
    });
    await issueDocument(tx, ctx, { documentId: note.documentId });
    await postDocument(tx, ctx, { documentId: note.documentId });
    return note.documentId;
  });
}

async function statusOf(documentId: string): Promise<string> {
  const [d] = await db.admin<{ status: string }[]>`
    select status::text as status from app.document where id = ${documentId}`;
  return d!.status;
}

/** `amount + tax_amount − total_incl_tax` of every line of the note, in SQL so no float touches a figure. */
async function lineGaps(documentId: string): Promise<string[]> {
  const rows = await db.admin<{ gap: string }[]>`
    select (amount + tax_amount - total_incl_tax)::numeric(19,4)::text as gap
      from app.document_line where document_id = ${documentId} order by line_no`;
  return rows.map((r) => r.gap);
}

/** Σ debit and Σ credit of one document's ledger, in its own currency. */
async function ledgerTotals(documentId: string) {
  const [r] = await db.admin<{ debit: string; credit: string }[]>`
    select sum(debit)::numeric(19,4)::text as debit, sum(credit)::numeric(19,4)::text as credit
      from app.ledger_entry where document_id = ${documentId}`;
  return r!;
}

/** Σ of the notes' line figures — the credited magnitudes, negated (A9). */
async function creditedSums(noteIds: readonly string[]) {
  const [r] = await db.admin<Figures[]>`
    select sum(quantity)::numeric(19,6)::text as quantity, sum(amount)::numeric(19,4)::text as amount,
           sum(tax_amount)::numeric(19,4)::text as tax, sum(total_incl_tax)::numeric(19,4)::text as total
      from app.document_line where document_id = any(${noteIds as string[]}::uuid[])`;
  return r!;
}

/** Σ base and Σ tax of `app.tax_transaction` over a set of documents, in the documents' own currency. */
async function taxTransactionSums(documentIds: readonly string[]) {
  const [r] = await db.admin<{ n: number; base: string; tax: string }[]>`
    select count(*)::int as n, sum(base)::numeric(19,4)::text as base,
           sum(tax)::numeric(19,4)::text as tax
      from app.tax_transaction where document_id = any(${documentIds as string[]}::uuid[])`;
  return r!;
}

/** Σ(debit − credit) in base per account over the invoice and every note — each must be exactly zero once
 *  the line is fully credited. Only for a base-currency document: at rate 1 nothing is converted. */
async function netOver(documentIds: readonly string[]) {
  return db.admin<{ net: string }[]>`
    select sum(base_debit - base_credit)::numeric(19,4)::text as net
      from app.ledger_entry where document_id = any(${documentIds as string[]}::uuid[])
     group by account_id`;
}

/** Credits the line in `pieces`, asserting each note posts balanced and self-consistent, then asserts the
 *  sums against `source`. `expected[i]` is the note's NEGATED line figures, as the note stores them. */
function creditsInPieces(
  side: Side,
  inclusive: boolean,
  month: string,
  source: Figures,
  pieces: readonly { quantity: string; expected: Omit<Figures, "quantity"> }[],
) {
  let invoice: { documentId: string; lineId: string };
  const notes: string[] = [];

  it("(a) each partial credit issues and POSTS, its line self-consistent and its ledger balanced", async () => {
    invoice = await taxedInvoice(side, `2026-${month}-01`, source, inclusive);
    for (const [i, piece] of pieces.entries()) {
      const noteId = await credit(
        side,
        invoice.documentId,
        [{ settledLineId: invoice.lineId, quantity: piece.quantity }],
        `2026-${month}-${10 + i}`,
      );
      notes.push(noteId);
      expect(await statusOf(noteId)).toBe("posted");
      expect(await lineOf(noteId)).toMatchObject({
        quantity: `-${piece.quantity}`,
        ...piece.expected,
      });
      expect(await lineGaps(noteId)).toEqual(["0.0000"]);
      const totals = await ledgerTotals(noteId);
      expect(totals.debit).toBe(totals.credit);
    }
  });

  it("(b) the notes' amount, tax and total each sum EXACTLY to the source line's, negated", async () => {
    expect(await creditedSums(notes)).toEqual({
      quantity: `-${source.quantity}`,
      amount: `-${source.amount}`,
      tax: `-${source.tax}`,
      total: `-${source.total}`,
    });
    // …so the invoice and its credits leave the control account, the revenue/expense account and the tax
    // account at exactly zero, not 0.0001 off.
    for (const r of await netOver([invoice.documentId, ...notes])) expect(r.net).toBe("0.0000");
  });

  it("(c) the notes' tax_transaction rows sum to the source's tax, negated", async () => {
    expect(await taxTransactionSums([invoice.documentId])).toEqual({
      n: 1,
      base: source.amount,
      tax: source.tax,
    });
    expect(await taxTransactionSums(notes)).toEqual({
      n: pieces.length,
      base: `-${source.amount}`,
      tax: `-${source.tax}`,
    });
  });
}

// Thirds: net 1.2344 / 3 = 0.41146… → 0.4115 and gross 1.3702 / 3 = 0.45673… → 0.4567, so the derived tax is
// 0.0452; the third credit COMPLETES the line and takes the residue of each, 0.4114 and 0.4568, tax 0.0454.
const THIRDS = [
  { quantity: "1.000000", expected: { amount: "-0.4115", tax: "-0.0452", total: "-0.4567" } },
  { quantity: "1.000000", expected: { amount: "-0.4115", tax: "-0.0452", total: "-0.4567" } },
  { quantity: "1.000000", expected: { amount: "-0.4114", tax: "-0.0454", total: "-0.4568" } },
] as const;

describe("SALES_CREDIT_NOTE of a taxed line, credited in thirds (exclusive)", () => {
  creditsInPieces("sales", false, "04", REVIEW_LINE, THIRDS);
});

describe("PURCHASE_CREDIT_NOTE of a taxed line, credited in thirds (exclusive)", () => {
  creditsInPieces("purchase", false, "05", REVIEW_LINE, THIRDS);
});

// Two thirds then one: net 0.82293… → 0.8229 and gross 0.91346… → 0.9135 (independently rounded tax would be
// 0.09053… → 0.0905, and 0.8229 + 0.0905 = 0.9134), derived tax 0.0906; the completing credit takes 0.4115
// and 0.4567, tax 0.0452.
describe("SALES_CREDIT_NOTE of a taxed line, credited two thirds then one (inclusive)", () => {
  creditsInPieces("sales", true, "06", REVIEW_LINE, [
    { quantity: "2.000000", expected: { amount: "-0.8229", tax: "-0.0906", total: "-0.9135" } },
    { quantity: "1.000000", expected: { amount: "-0.4115", tax: "-0.0452", total: "-0.4567" } },
  ]);
});

// THE RECORDED LIMIT (credit-note.ts's doc comment), pinned so the change that removes it has to move this.
// The completing credit's derived tax is a residue like its net and gross, and on a line whose tax is a few
// ten-thousandths credited in many pieces the earlier notes' tax can sum past the line's. Net 0.0017 at 11%
// is tax 0.0002 (0.000187) and gross 0.0019, over FIVE units credited one at a time: each of the first four
// takes net 0.00034 → 0.0003 and gross 0.00038 → 0.0004, so tax 0.0001 — 0.0004 of tax against the line's
// 0.0002 — and the fifth COMPLETES the line with net 0.0005, gross 0.0003 and tax −0.0002, which the note
// stores negated as +0.0002. It still posts balanced (the evaluator flips the side of a negative amount),
// and (b) and (c) still hold exactly. Independently rounded tax (0.00004 → 0.0000) refused the FIRST of
// these notes as unbalanced, so this line had no partial-credit path at all before the fix.
const ONE_OF_FIVE = {
  quantity: "1.000000",
  expected: { amount: "-0.0003", tax: "-0.0001", total: "-0.0004" },
} as const;

describe("the recorded limit: a 0.0002-tax line credited a unit at a time", () => {
  creditsInPieces(
    "sales",
    false,
    "07",
    { quantity: "5.000000", amount: "0.0017", tax: "0.0002", total: "0.0019" },
    [
      ONE_OF_FIVE,
      ONE_OF_FIVE,
      ONE_OF_FIVE,
      ONE_OF_FIVE,
      { quantity: "1.000000", expected: { amount: "-0.0005", tax: "0.0002", total: "-0.0003" } },
    ],
  );
});

// A FOREIGN-CURRENCY note mixing an ITEM line and an UNTAXED line. EUR at 4.33333333 — a rate at which
// `toBase` rounds, so the evaluator's base check and its fx_rounding line run (note 1 alone converts its AR
// legs to 3.0628 and its revenue and tax legs to 3.0629). Line 1 is an item, 3 at 0.4500 less a 0.1156
// discount, which is the review's net 1.2344 (tax 0.1358, gross 1.3702), carrying the BASE-currency cost
// 1.0000 a delivery would have written. Line 2 is an account line of 2 for 0.5001 with NO tax code. Note 1
// credits one of each, note 2 one more item, note 3 the last item and the last account unit — so two notes
// mix a taxed and an untaxed line, and the last completes both.
describe("SALES_CREDIT_NOTE in EUR mixing a taxed, discounted item line and an untaxed line", () => {
  const RATE = "4.33333333";
  /** `ArLine` declares no discount, but `postArDocument` hands the line to `draftTypedDocument`, whose
   *  `DraftLine` writes one — so it is passed through rather than added to 4A's frozen surface. */
  type DiscountedLine = ArLine & { discount: string };
  let invoiceId: string;
  let itemLineId: string;
  let plainLineId: string;
  const notes: string[] = [];

  interface NoteLine {
    quantity: string;
    discount: string;
    amount: string;
    tax: string;
    total: string;
    cost: string | null;
  }

  async function linesOf(documentId: string): Promise<NoteLine[]> {
    return db.admin<NoteLine[]>`
      select quantity::text as quantity, discount::text as discount, amount::text as amount,
             tax_amount::text as tax, total_incl_tax::text as total, cost::text as cost
        from app.document_line where document_id = ${documentId} order by line_no`;
  }

  const ITEM_THIRD: NoteLine = {
    quantity: "-1.000000",
    discount: "-0.0385",
    amount: "-0.4115",
    tax: "-0.0452",
    total: "-0.4567",
    cost: "0.3333",
  };

  it("(a) every note posts, balanced in base, every line self-consistent and the untaxed line's tax 0", async () => {
    await seedCurrency(db, f.s, { code: "EUR" });
    const { itemId } = await seedItem(db, f.s, {
      code: "IT-CN-ROUNDING",
      kind: "product",
      trackLots: false,
    });
    const item: DiscountedLine = {
      lineNo: 1,
      kind: "item",
      itemId,
      quantity: "3.000000",
      unitPrice: "0.4500",
      discount: "0.1156",
      amount: "1.2344",
      cost: "1.0000",
      taxCodeId: f.codes["SYN-OUT-STD"]!,
    };
    const plain: ArLine = {
      lineNo: 2,
      kind: "account",
      accountId: f.accounts["4000"]!,
      quantity: "2.000000",
      amount: "0.5001",
    };
    ({ documentId: invoiceId } = await postFromPack(db, f.s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-08-01",
      partyId: f.customerId,
      currency: "EUR",
      exchangeRate: RATE,
      computeTax: true,
      lines: [item, plain],
    }));
    expect(await linesOf(invoiceId)).toEqual([
      {
        quantity: "3.000000",
        discount: "0.1156",
        amount: "1.2344",
        tax: "0.1358",
        total: "1.3702",
        cost: "1.0000",
      },
      {
        quantity: "2.000000",
        discount: "0.0000",
        amount: "0.5001",
        tax: "0.0000",
        total: "0.5001",
        cost: null,
      },
    ]);
    const ids = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${invoiceId} order by line_no`;
    [itemLineId, plainLineId] = ids.map((r) => r.id) as [string, string];

    const one = "1.000000";
    const asks: CreditNoteLine[][] = [
      [
        { settledLineId: itemLineId, quantity: one },
        { settledLineId: plainLineId, quantity: one },
      ],
      [{ settledLineId: itemLineId, quantity: one }],
      [
        { settledLineId: itemLineId, quantity: one },
        { settledLineId: plainLineId, quantity: one },
      ],
    ];
    // Thirds of the item as in THIRDS, its discount 0.03853… → 0.0385 and its cost 0.3333 until the last
    // takes 0.0386 and 0.3334; halves of the untaxed line, 0.25005 → 0.2501 and then the residue 0.2500.
    const expected: NoteLine[][] = [
      [
        ITEM_THIRD,
        {
          quantity: "-1.000000",
          discount: "0.0000",
          amount: "-0.2501",
          tax: "0.0000",
          total: "-0.2501",
          cost: null,
        },
      ],
      [ITEM_THIRD],
      [
        {
          quantity: "-1.000000",
          discount: "-0.0386",
          amount: "-0.4114",
          tax: "-0.0454",
          total: "-0.4568",
          cost: "0.3334",
        },
        {
          quantity: "-1.000000",
          discount: "0.0000",
          amount: "-0.2500",
          tax: "0.0000",
          total: "-0.2500",
          cost: null,
        },
      ],
    ];

    for (const [i, lines] of asks.entries()) {
      const noteId = await credit("sales", invoiceId, lines, `2026-08-${10 + i}`);
      notes.push(noteId);
      expect(await statusOf(noteId)).toBe("posted");
      expect(await linesOf(noteId)).toEqual(expected[i]);
      expect(await lineGaps(noteId)).toEqual(lines.map(() => "0.0000"));
      // Balanced in base (the fx_rounding line included), and the EUR legs balanced on their own — the cost
      // legs and the fx_rounding line are base currency (3B amendment A4).
      const [r] = await db.admin<{ bd: string; bc: string; d: string; c: string }[]>`
        select sum(base_debit)::numeric(19,4)::text as bd, sum(base_credit)::numeric(19,4)::text as bc,
               sum(debit) filter (where currency = 'EUR')::numeric(19,4)::text as d,
               sum(credit) filter (where currency = 'EUR')::numeric(19,4)::text as c
          from app.ledger_entry where document_id = ${noteId}`;
      expect(r!.bd).toBe(r!.bc);
      expect(r!.d).toBe(r!.c);
    }

    // The base residue was real: at least one note carries an fx_rounding line.
    const [fx] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry e
        join app.company co on co.id = e.company_id
       where e.document_id = any(${notes}::uuid[]) and e.account_id = co.fx_rounding_account_id`;
    expect(fx!.n).toBeGreaterThan(0);
  });

  it("(b) per source line, the notes sum EXACTLY to the invoice's figures, negated (cost positive)", async () => {
    const rows = await db.admin<(NoteLine & { lineNo: number })[]>`
      select sl.line_no as "lineNo", sum(tl.quantity)::numeric(19,6)::text as quantity,
             sum(tl.discount)::numeric(19,4)::text as discount, sum(tl.amount)::numeric(19,4)::text as amount,
             sum(tl.tax_amount)::numeric(19,4)::text as tax, sum(tl.total_incl_tax)::numeric(19,4)::text as total,
             sum(tl.cost)::numeric(19,4)::text as cost
        from app.document_link k
        join app.document_line tl on tl.id = k.target_line_id
        join app.document_line sl on sl.id = k.source_line_id
       where k.target_document_id = any(${notes}::uuid[])
       group by sl.line_no order by sl.line_no`;
    expect(rows).toEqual([
      {
        lineNo: 1,
        quantity: "-3.000000",
        discount: "-0.1156",
        amount: "-1.2344",
        tax: "-0.1358",
        total: "-1.3702",
        cost: "1.0000",
      },
      {
        lineNo: 2,
        quantity: "-2.000000",
        discount: "0.0000",
        amount: "-0.5001",
        tax: "0.0000",
        total: "-0.5001",
        cost: null,
      },
    ]);
    // In each account's own currency the invoice and its credits net to exactly zero — AR, revenue and tax
    // in EUR, 1250 and COGS in base. Base figures are not compared across documents: each document's
    // conversion rounds per line, and the company's fx_rounding account takes that residue by design.
    const nets = await db.admin<{ net: string }[]>`
      select sum(e.debit - e.credit)::numeric(19,4)::text as net
        from app.ledger_entry e join app.company co on co.id = e.company_id
       where e.document_id = any(${[invoiceId, ...notes]}::uuid[])
         and e.account_id <> co.fx_rounding_account_id
       group by e.account_id, e.currency`;
    expect(nets.length).toBeGreaterThan(0);
    for (const r of nets) expect(r.net).toBe("0.0000");
  });

  it("(c) only the taxed line reaches tax_transaction, and the notes' rows sum to the invoice's, negated", async () => {
    expect(await taxTransactionSums([invoiceId])).toEqual({ n: 1, base: "1.2344", tax: "0.1358" });
    expect(await taxTransactionSums(notes)).toEqual({ n: 3, base: "-1.2344", tax: "-0.1358" });
  });
});

// AN INCONSISTENT CREDIT HISTORY (PR 11 review, round 2). The derived tax above — gross − net, the completing
// credit taking the residue of each — is right only while every earlier credit of the line holds
// `total = amount + tax`: then Σ gross − Σ net is Σ tax and the residue is the line's remaining tax exactly.
// Every credit `creditNoteFrom` writes holds it; a CLIENT path need not. A SALES_CREDIT_NOTE drafted through
// the generic `POST …/documents` with an unpriced line (quantity −1, amount 0, so tax 0 and total 0 at persist
// time) and linked `returns` from the invoice through `POST …/links` — `priceFromSource` defaults true — has its
// amount rewritten to −100.0000 by 3C's price copy and its tax and total left at 0. The draft holds its claim
// (`creditNoteFrom` counts every `returns` target that is not void or reversed), so the credit that completed
// the line took net 300 − 100 = 200 and gross 333 − 0 = 333 and DERIVED a tax of 133: a wrong note that
// posted balanced, where c2c3bb1 refused it as unbalanced. It is refused now, naming the draft.
describe("a credit history breaking total = net + tax is refused, naming the note that breaks it", () => {
  const SOURCE: Figures = {
    quantity: "3.000000",
    amount: "300.0000",
    tax: "33.0000",
    total: "333.0000",
  };
  const ctx = () => ({ tenantId: f.s.tenant, actorId: f.s.human, requestId: "cn-history" });
  let invoiceId: string;
  let lineId: string;
  let clientDraft: string;

  it("(a) a client-drafted note priced through a returns link blocks every further credit of the line", async () => {
    // A PRICED line — 3C's copy needs the source's `unit_price` — of 3 × 100.0000 at 11%.
    ({ documentId: invoiceId } = await postFromPack(db, f.s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-09-01",
      partyId: f.customerId,
      computeTax: true,
      lines: [
        {
          lineNo: 1,
          kind: "account",
          accountId: f.accounts["4000"]!,
          quantity: SOURCE.quantity,
          unitPrice: "100.0000",
          amount: SOURCE.amount,
          taxCodeId: f.codes["SYN-OUT-STD"]!,
        },
      ],
    }));
    const invoiceLine = await lineOf(invoiceId);
    expect(invoiceLine).toMatchObject(SOURCE);
    lineId = invoiceLine.id;

    // The client's path, through the services its two routes call: the generic draft — the line as
    // `DocumentLineInput` admits it, a signed quantity, no price, `amount` defaulted to 0 — computed at persist
    // time, then the `returns` link with the route's default `priceFromSource`.
    const draft = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types["SALES_CREDIT_NOTE"]!,
      series: "CN",
      effectiveDate: "2026-09-05",
      partyId: f.customerId,
      lines: [
        {
          kind: "account",
          accountId: f.accounts["4000"]!,
          quantity: "-1.000000",
          taxCodeId: f.codes["SYN-OUT-STD"]!,
        },
      ],
    });
    clientDraft = draft.documentId;
    await prodWithTenant(db.rw, ctx(), async (tx) => {
      await computeDocumentTax(tx, ctx(), clientDraft);
      await linkFulfilment(tx, ctx(), {
        sourceDocumentId: invoiceId,
        targetDocumentId: clientDraft,
        linkKind: "returns",
        lines: [{ sourceLineId: lineId, targetLineId: draft.lineIds[0]!, quantity: "1.000000" }],
      });
    });
    // The finding's state was the copy rewriting the net and leaving the tax and the total at 0. Since MON-14
    // (2026-11-16) the copy recomputes the draft's tax, so the draft is consistent — and it is still refused
    // below, by provenance: no credit note of the invoice wrote it as a share of the line (case (d)'s rule).
    expect(await lineOf(clientDraft)).toMatchObject({
      quantity: "-1.000000",
      amount: "-100.0000",
      tax: "-11.0000",
      total: "-111.0000",
    });

    // The credit that would COMPLETE the line — the one that derived 133 of tax — is refused, naming the draft;
    // so is a partial one, and the whole-invoice call that asks the line implicitly. Fail closed: nothing is
    // drafted, and the remedy is the client's draft, not a guess at what it meant.
    const refusal = new RegExp(`ERR_VALIDATION_FAILED: line 1 .*${clientDraft}`);
    for (const lines of [
      [{ settledLineId: lineId, quantity: "2.000000" }],
      [{ settledLineId: lineId, quantity: "1.000000" }],
      [],
    ]) {
      await expect(credit("sales", invoiceId, lines, "2026-09-10")).rejects.toThrow(refusal);
    }
    const [links] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document_link
       where source_document_id = ${invoiceId} and link_kind = 'returns'`;
    expect(links!.n).toBe(1);
  });

  it("(b) with the draft deleted, a consistent two-note history completes the line exactly", async () => {
    // The DELETE route's own statement; 0037's cascade takes the draft's link with it and releases the unit.
    await prodWithTenant(
      db.rw,
      ctx(),
      (tx) =>
        tx`delete from app.document where id = ${clientDraft} and company_id = ${f.s.company}`,
    );
    const first = await credit(
      "sales",
      invoiceId,
      [{ settledLineId: lineId, quantity: "1.000000" }],
      "2026-09-11",
    );
    const last = await credit(
      "sales",
      invoiceId,
      [{ settledLineId: lineId, quantity: "2.000000" }],
      "2026-09-12",
    );
    expect(await statusOf(first)).toBe("posted");
    expect(await statusOf(last)).toBe("posted");
    expect(await lineOf(first)).toMatchObject({
      quantity: "-1.000000",
      amount: "-100.0000",
      tax: "-11.0000",
      total: "-111.0000",
    });
    expect(await lineOf(last)).toMatchObject({
      quantity: "-2.000000",
      amount: "-200.0000",
      tax: "-22.0000",
      total: "-222.0000",
    });
    expect(await creditedSums([first, last])).toEqual({
      quantity: `-${SOURCE.quantity}`,
      amount: `-${SOURCE.amount}`,
      tax: `-${SOURCE.tax}`,
      total: `-${SOURCE.total}`,
    });
    for (const r of await netOver([invoiceId, first, last])) expect(r.net).toBe("0.0000");
  });
});

// A CLAIM NO CREDIT NOTE OF THE INVOICE WROTE (PR 11 review, round 3). Round 2's refusal compared the SUMS of
// the credits already counted (Σ total against Σ net + Σ tax), which guards only the tax derivation. The
// completing credit takes the residue of the net and the gross as well, so it trusts every counted claim to be
// a share of THIS line written by a credit note of THIS invoice — and a `returns` claim reaches `done` by other
// paths: a client draft through `POST …/documents` linked through `POST …/links` (it can never post: its policy
// requires `reverses_document`, which no client route sets), or a client link from ANOTHER invoice line onto a
// derived note's line. A claim is trusted on three conditions — its document reverses the invoice, its line is
// linked from this line alone, its line holds total = amount + tax — and (d), (e) and (f) each break exactly one
// of them, so each condition is shown to refuse on its own; (c), the review's probe as it was built, breaks the
// first and the third; (g) breaks none. Every refusal names the claim's document. Before, (c), (d) and (e)
// posted a wrong note, and (f) was refused only by the sums.
describe("a returns claim no credit note of the invoice wrote as a share of the line is refused, naming it", () => {
  const ctx = () => ({ tenantId: f.s.tenant, actorId: f.s.human, requestId: "cn-claims" });

  /** A posted SALES_INVOICE with one PRICED line of 3 units at 11% per entry — 3C's copy needs a price. */
  async function pricedInvoice(
    effectiveDate: string,
    priced: readonly { unitPrice: string; amount: string }[],
  ) {
    const { documentId } = await postFromPack(db, f.s, {
      code: "SALES_INVOICE",
      effectiveDate,
      partyId: f.customerId,
      computeTax: true,
      lines: priced.map((p, i) => ({
        lineNo: i + 1,
        kind: "account" as const,
        accountId: f.accounts["4000"]!,
        quantity: "3.000000",
        unitPrice: p.unitPrice,
        amount: p.amount,
        taxCodeId: f.codes["SYN-OUT-STD"]!,
      })),
    });
    const rows = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${documentId} order by line_no`;
    return { invoiceId: documentId, lineIds: rows.map((r) => r.id) };
  }
  const HUNDRED = { unitPrice: "100.0000", amount: "300.0000" };
  const FIFTY = { unitPrice: "50.0000", amount: "150.0000" };

  /** The client's path, through the services its two routes call: the generic draft (an unpriced line,
   *  computed at persist time), then a `returns` link of one unit from the invoice line onto it. */
  async function clientClaim(
    invoiceId: string,
    lineId: string,
    quantity: string,
    priceFromSource: boolean,
  ): Promise<string> {
    const draft = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types["SALES_CREDIT_NOTE"]!,
      series: "CN",
      effectiveDate: "2026-10-05",
      partyId: f.customerId,
      lines: [
        {
          kind: "account",
          accountId: f.accounts["4000"]!,
          quantity,
          taxCodeId: f.codes["SYN-OUT-STD"]!,
        },
      ],
    });
    await prodWithTenant(db.rw, ctx(), async (tx) => {
      await computeDocumentTax(tx, ctx(), draft.documentId);
      await linkFulfilment(tx, ctx(), {
        sourceDocumentId: invoiceId,
        targetDocumentId: draft.documentId,
        linkKind: "returns",
        lines: [{ sourceLineId: lineId, targetLineId: draft.lineIds[0]!, quantity: "1.000000" }],
        priceFromSource,
      });
    });
    return draft.documentId;
  }

  /** `creditNoteFrom`'s own draft of one unit, left a draft: a derived note, `reverses_document_id` set. */
  async function derivedDraft(invoiceId: string, lineId: string) {
    const note = await prodWithTenant(db.rw, ctx(), (tx) =>
      creditNoteFrom(tx, ctx(), {
        companyId: f.s.company,
        settledDocumentId: invoiceId,
        targetDocumentTypeId: f.types["SALES_CREDIT_NOTE"]!,
        targetSeries: "CN",
        effectiveDate: "2026-10-06",
        reason: "a derived draft",
        lines: [{ settledLineId: lineId, quantity: "1.000000" }],
      }),
    );
    return { noteId: note.documentId, noteLineId: note.lineIds[0]! };
  }

  /** The notes reversing the invoice — `creditNoteFrom` names it on every note it drafts. */
  async function notesOf(invoiceId: string): Promise<string[]> {
    const rows = await db.admin<{ id: string }[]>`
      select id from app.document where reverses_document_id = ${invoiceId} order by id`;
    return rows.map((r) => r.id);
  }

  it("(c) two price-copied client drafts whose figures cancel are refused, naming both", async () => {
    // The review's probe (ii): each draft breaks total = amount + tax, but between them the sums agree, so
    // round 2's check passed and the 1-unit credit took the line's whole net — 300 − (100 − 100) — posting
    // quantity −1 at −300.0000 / −33.0000 / −333.0000: three units' value on a one-unit note.
    const { invoiceId, lineIds } = await pricedInvoice("2026-10-01", [HUNDRED]);
    const plus = await clientClaim(invoiceId, lineIds[0]!, "1.000000", true);
    const minus = await clientClaim(invoiceId, lineIds[0]!, "-1.000000", true);
    // Since MON-14 (2026-11-16) each copy recomputes its draft's tax, so each draft is consistent on its own;
    // between them they still claim nothing net, and both are refused by provenance.
    expect(await lineOf(plus)).toMatchObject({
      amount: "100.0000",
      tax: "11.0000",
      total: "111.0000",
    });
    expect(await lineOf(minus)).toMatchObject({
      amount: "-100.0000",
      tax: "-11.0000",
      total: "-111.0000",
    });

    const named = [plus, minus].toSorted().join(", ");
    await expect(
      credit(
        "sales",
        invoiceId,
        [{ settledLineId: lineIds[0]!, quantity: "1.000000" }],
        "2026-10-10",
      ),
    ).rejects.toThrow(new RegExp(`ERR_VALIDATION_FAILED: line 1 cannot be credited: .*${named}`));
    // Fail closed: nothing was drafted.
    expect(await notesOf(invoiceId)).toEqual([]);
  });

  it("(d) a client draft whose figures ARE consistent is refused too: it does not credit this invoice", async () => {
    // The review's probe (i): an unpriced client draft linked without the copy is 0 / 0 / 0, which holds
    // total = amount + tax — no identity check can see it — yet it holds one unit of the line at no value, and
    // the 2-unit credit that completed the line took all of it: quantity −2 at −300.0000 / −33.0000 / −333.0000.
    const { invoiceId, lineIds } = await pricedInvoice("2026-10-02", [HUNDRED]);
    const claim = await clientClaim(invoiceId, lineIds[0]!, "-1.000000", false);
    expect(await lineOf(claim)).toMatchObject({
      quantity: "-1.000000",
      amount: "0.0000",
      tax: "0.0000",
      total: "0.0000",
    });

    await expect(
      credit(
        "sales",
        invoiceId,
        [{ settledLineId: lineIds[0]!, quantity: "2.000000" }],
        "2026-10-11",
      ),
    ).rejects.toThrow(new RegExp(`ERR_VALIDATION_FAILED: line 1 cannot be credited: .*${claim}`));
    expect(await notesOf(invoiceId)).toEqual([]);
  });

  it("(e) a derived note's line linked from ANOTHER invoice line is refused on both lines", async () => {
    // A derived note of line 1, its line priced from line 1 (−1 / −100 / −11 / −111), and a client `returns`
    // link from line 2 onto that same note line: the line is already priced, so nothing is copied and its
    // figures stay consistent. Counted against line 2, line 1's −100 / −11 / −111 made the 2-unit credit that
    // completed line 2 (3 × 50.0000) take 150 − 100 net and 166.5 − 111 gross: −50.0000 / −5.5000 / −55.5000.
    const { invoiceId, lineIds } = await pricedInvoice("2026-10-03", [HUNDRED, FIFTY]);
    const { noteId, noteLineId } = await derivedDraft(invoiceId, lineIds[0]!);
    await prodWithTenant(db.rw, ctx(), (tx) =>
      linkFulfilment(tx, ctx(), {
        sourceDocumentId: invoiceId,
        targetDocumentId: noteId,
        linkKind: "returns",
        lines: [{ sourceLineId: lineIds[1]!, targetLineId: noteLineId, quantity: "1.000000" }],
      }),
    );
    expect(await lineOf(noteId)).toMatchObject({
      quantity: "-1.000000",
      amount: "-100.0000",
      tax: "-11.0000",
      total: "-111.0000",
    });

    await expect(
      credit(
        "sales",
        invoiceId,
        [{ settledLineId: lineIds[1]!, quantity: "2.000000" }],
        "2026-10-12",
      ),
    ).rejects.toThrow(new RegExp(`ERR_VALIDATION_FAILED: line 2 cannot be credited: .*${noteId}`));
    // Line 1's own claim is that same note line, now a share of two lines: refused as well.
    await expect(
      credit(
        "sales",
        invoiceId,
        [{ settledLineId: lineIds[0]!, quantity: "2.000000" }],
        "2026-10-12",
      ),
    ).rejects.toThrow(new RegExp(`ERR_VALIDATION_FAILED: line 1 cannot be credited: .*${noteId}`));
    expect(await notesOf(invoiceId)).toEqual([noteId]);
  });

  it("(f) a derived note whose line a direct app_rw statement rewrote is refused on that line alone", async () => {
    // Provenance and a single link both hold; only the line's own figures break total = amount + tax. Round 2
    // refused this through the sums; the per-line test is what refuses it now.
    const { invoiceId, lineIds } = await pricedInvoice("2026-10-04", [HUNDRED]);
    const { noteId, noteLineId } = await derivedDraft(invoiceId, lineIds[0]!);
    await prodWithTenant(
      db.rw,
      ctx(),
      (tx) => tx`update app.document_line set tax_amount = tax_amount - 1 where id = ${noteLineId}`,
    );
    expect(await lineOf(noteId)).toMatchObject({
      amount: "-100.0000",
      tax: "-12.0000",
      total: "-111.0000",
    });

    await expect(
      credit(
        "sales",
        invoiceId,
        [{ settledLineId: lineIds[0]!, quantity: "2.000000" }],
        "2026-10-13",
      ),
    ).rejects.toThrow(new RegExp(`ERR_VALIDATION_FAILED: line 1 cannot be credited: .*${noteId}`));
    expect(await notesOf(invoiceId)).toEqual([noteId]);
  });

  it("(g) a derived draft left as written is trusted: the credit that completes the line takes the residue", async () => {
    const { invoiceId, lineIds } = await pricedInvoice("2026-10-05", [HUNDRED]);
    const { noteId } = await derivedDraft(invoiceId, lineIds[0]!);
    const last = await credit(
      "sales",
      invoiceId,
      [{ settledLineId: lineIds[0]!, quantity: "2.000000" }],
      "2026-10-14",
    );
    expect(await statusOf(last)).toBe("posted");
    expect(await lineOf(last)).toMatchObject({
      quantity: "-2.000000",
      amount: "-200.0000",
      tax: "-22.0000",
      total: "-222.0000",
    });
    expect(await creditedSums([noteId, last])).toEqual({
      quantity: "-3.000000",
      amount: "-300.0000",
      tax: "-33.0000",
      total: "-333.0000",
    });
  });
});
