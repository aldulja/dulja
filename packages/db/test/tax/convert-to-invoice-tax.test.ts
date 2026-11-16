import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertToInvoice, type ConvertToInvoiceInput } from "../../src/ar-ap/invoice";
import { linkFulfilment, openQuantity, type LinkKind } from "../../src/documents/link";
import { convertOrderToDelivery } from "../../src/inventory/fulfilment";
import { issueDocument, postDocument } from "../../src/posting";
import { createTaxCode } from "../../src/tax";
import {
  draftTypedDocument,
  grantCodes,
  seedCurrency,
  seedDocumentType,
  seedItem,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
} from "../index";
import { plus4 } from "../ar-ap/_support";
import { recordingJobs } from "../../../../tests/invariants/support/post-inventory";
import { PACK_DIR, seedTypeFromPack } from "../../../../tests/invariants/support/ar-ap";
import { taxFixture, type TaxFixture } from "../../../../tests/invariants/support/tax";

/**
 * The 4A conversions under 5A's policy VERSION 2. SALES_INVOICE and PURCHASE_INVOICE now apply tax, and a
 * converted invoice is the ordinary way one is raised — so the conversion must carry a tax code onto each
 * line and compute the tax at persist time (spec:2228, ADR 0050) exactly as `PUT …/lines` does. Before this
 * file the conversion wrote `tax_code_id` null and `tax_amount` 0 on every line, and a delivery-sourced
 * invoice could never carry tax at all.
 *
 * A line's code is its own `taxCodeId`, else the body's, else the SOURCE line's — and every one of them a
 * code of the source's company. The invoice is drafted tax-EXCLUSIVE: the residue rule sums earlier
 * conversions' `amount`, which must stay the net figure.
 */
let db: Db;
let f: TaxFixture;
let doType: string;
let grnType: string;
let soType: string;
let poType: string;
let itemId: string;
let warehouseId: string;
const ctx = () => ({ tenantId: f.s.tenant, actorId: f.s.human, requestId: "convert-tax" });

beforeAll(async () => {
  db = await startDb();
  // The tax pack's four codes, `2300`/`1350`, the four taxed 4A types off disk, a customer, a vendor and
  // every 2026 period open. The two stock types are the pack's too — the conversion is proven against the
  // SEEDED policies, never an inline one.
  f = await taxFixture(db, "convert-tax");
  doType = await seedTypeFromPack(db, f.s, "DELIVERY_ORDER");
  grnType = await seedTypeFromPack(db, f.s, "GOODS_RECEIPT");
  soType = await seedTypeFromPack(db, f.s, "SALES_ORDER");
  poType = await seedTypeFromPack(db, f.s, "PURCHASE_ORDER");
  await grantCodes(db, f.s, { codes: ["inventory.receipt.post", "inventory.transfer.post"] });
  await seedCurrency(db, f.s, { code: "USD" });
  ({ itemId } = await seedItem(db, f.s, { code: "IT-CTAX", kind: "product", trackLots: false }));
  warehouseId = await seedWarehouse(db, f.s, { code: "WH-CTAX" });
  // One layer of a hundred units at 3.0000, so every delivery below costs 3.0000 a unit and none runs the
  // warehouse short (`assert_stock_available`, 3A).
  await receive("100.000000", "3.0000", "300.0000", "2026-01-05");
}, 240_000);
afterAll(async () => {
  await db?.stop();
});

/** A GOODS_RECEIPT from the fixture's vendor, posted through the real posting service. */
async function receive(quantity: string, unitPrice: string, amount: string, date: string) {
  const { documentId, lineIds } = await draftTypedDocument(db, f.s, {
    documentTypeId: grnType,
    series: "GRN",
    effectiveDate: date,
    partyId: f.vendorId,
    warehouseId,
    lines: [{ kind: "item", itemId, warehouseId, quantity, unitPrice, amount }],
  });
  await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
    postDocument(tx, ctx(), { documentId, jobs: recordingJobs() }),
  );
  return { documentId, lineIds };
}

/**
 * A DELIVERY_ORDER to the fixture's customer, posted. A line may carry a tax code of its own — the generic
 * route accepts one on any type, and DELIVERY_ORDER's `tax.applies: false` computes nothing from it — and
 * `taxInclusive` is written on the DRAFT, because 0117 freezes the header once it leaves draft.
 */
async function deliver(
  lines: { quantity: string; amount: string; unitPrice?: string; taxCode?: string }[],
  date: string,
  opts: { taxInclusive?: boolean; currency?: string; exchangeRate?: string } = {},
) {
  const { taxInclusive, ...header } = opts;
  const { documentId, lineIds } = await draftTypedDocument(db, f.s, {
    documentTypeId: doType,
    series: "DO",
    effectiveDate: date,
    partyId: f.customerId,
    warehouseId,
    ...header,
    lines: lines.map((l) => ({
      kind: "item" as const,
      itemId,
      warehouseId,
      quantity: l.quantity,
      unitPrice: l.unitPrice ?? "9.0000",
      amount: l.amount,
      ...(l.taxCode === undefined ? {} : { taxCodeId: f.codes[l.taxCode]! }),
    })),
  });
  await withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
    if (taxInclusive === true) {
      await tx`update app.document set tax_inclusive = true where id = ${documentId}`;
    }
    // The provenance an API-drafted foreign-currency document carries (draftTypedDocument writes none).
    if (header.currency !== undefined) {
      await tx`update app.document set rate_source = ${`manual:${f.s.human}`} where id = ${documentId}`;
    }
    await postDocument(tx, ctx(), { documentId, jobs: recordingJobs() });
  });
  return { documentId, lineIds };
}

/**
 * 3D's path: a SALES_ORDER drafted (its `tax_inclusive` written on the DRAFT — 0117 freezes the header after
 * it), issued, converted into a DELIVERY_ORDER by `convertOrderToDelivery` without FEFO, and the delivery
 * posted. The order line may carry a tax code — SALES_ORDER's `tax.applies: false` computes nothing from it.
 */
async function orderThenDeliver(
  line: { quantity: string; unitPrice: string; amount: string; taxCode?: string },
  date: string,
  opts: { taxInclusive?: boolean } = {},
) {
  const order = await draftTypedDocument(db, f.s, {
    documentTypeId: soType,
    series: "SO",
    effectiveDate: date,
    partyId: f.customerId,
    lines: [
      {
        kind: "item" as const,
        itemId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount: line.amount,
        ...(line.taxCode === undefined ? {} : { taxCodeId: f.codes[line.taxCode]! }),
      },
    ],
  });
  return withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
    if (opts.taxInclusive === true) {
      await tx`update app.document set tax_inclusive = true where id = ${order.documentId}`;
    }
    await issueDocument(tx, ctx(), { documentId: order.documentId });
    const d = await convertOrderToDelivery(tx, ctx(), {
      sourceDocumentId: order.documentId,
      targetDocumentTypeId: doType,
      targetSeries: "DO",
      effectiveDate: date,
      warehouseId,
      fefo: false,
      lines: [{ sourceLineId: order.lineIds[0]!, quantity: line.quantity }],
    });
    await postDocument(tx, ctx(), { documentId: d.documentId, jobs: recordingJobs() });
    return { documentId: d.documentId, lineIds: d.lines.map((l) => l.targetLineId) };
  });
}

type Ask = Omit<ConvertToInvoiceInput, "companyId" | "targetDocumentTypeId" | "targetSeries"> & {
  target?: "SALES_INVOICE" | "PURCHASE_INVOICE";
};

/** Converts and leaves the invoice a DRAFT. */
function draftInvoice({ target = "SALES_INVOICE", ...input }: Ask) {
  return withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
    convertToInvoice(tx, ctx(), {
      companyId: f.s.company,
      targetDocumentTypeId: f.types[target]!,
      targetSeries: "INV",
      ...input,
    }),
  );
}

/** Converts, issues and posts in ONE transaction. */
function postedInvoice({ target = "SALES_INVOICE", ...input }: Ask) {
  return withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
    const r = await convertToInvoice(tx, ctx(), {
      companyId: f.s.company,
      targetDocumentTypeId: f.types[target]!,
      targetSeries: "INV",
      ...input,
    });
    await issueDocument(tx, ctx(), { documentId: r.documentId });
    await postDocument(tx, ctx(), { documentId: r.documentId });
    return r;
  });
}

/** Converts into an explicitly named target type and leaves the invoice a DRAFT. */
function convertInto(
  targetDocumentTypeId: string,
  input: Omit<ConvertToInvoiceInput, "companyId" | "targetDocumentTypeId" | "targetSeries">,
) {
  return withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
    convertToInvoice(tx, ctx(), {
      companyId: f.s.company,
      targetDocumentTypeId,
      targetSeries: "INV",
      ...input,
    }),
  );
}

/**
 * SALES_INVOICE's SEEDED definition under another code with its `tax` block replaced — the shape a tenant
 * admin can append through `POST /v1/admin/document-types/{id}/policies` (`posting-policy.schema.json` admits
 * a boolean `inclusive`). Everything else — direction, the 1250 corridor, the approval codes the fixture
 * grants — is the pack's. A policy that applies no tax plans no tax leg.
 */
async function salesInvoiceVariant(
  code: string,
  tax: { applies: boolean; inclusive: boolean | "header.tax_inclusive" },
): Promise<string> {
  const envelope = JSON.parse(
    readFileSync(`${PACK_DIR}document-types/SALES_INVOICE.json`, "utf8"),
  ) as { policy: { lines: { for: string }[] } };
  const policy = {
    ...envelope.policy,
    documentType: code,
    lines: tax.applies
      ? envelope.policy.lines
      : envelope.policy.lines.filter((l) => l.for !== "each_tax"),
    tax,
  };
  return seedDocumentType(db, f.s, { code, module: "accounting", policy });
}

/** The invoice's lines as written: the code, the net, the tax and the total. */
function linesOf(documentId: string) {
  return db.admin<
    { lineNo: number; taxCodeId: string | null; amount: string; tax: string; total: string }[]
  >`
    select line_no as "lineNo", tax_code_id as "taxCodeId", amount::text as amount,
           tax_amount::text as tax, total_incl_tax::text as total
      from app.document_line where document_id = ${documentId} order by line_no`;
}

/** The tax facts posting wrote (§4.3.2 step 11). */
function taxFacts(documentId: string) {
  return db.admin<{ lineNo: number; taxCodeId: string; base: string; tax: string }[]>`
    select line_no as "lineNo", tax_code_id as "taxCodeId", base::text as base, tax::text as tax
      from app.tax_transaction where document_id = ${documentId} order by line_no, tax_code_id`;
}

/** The ledger one document posted, netted per account code in base. */
function legs(documentId: string) {
  return db.admin<{ code: string; debit: string; credit: string }[]>`
    select a.code, sum(e.base_debit)::numeric(19,4)::text as debit,
           sum(e.base_credit)::numeric(19,4)::text as credit
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = ${documentId}
     group by a.code order by a.code`;
}

async function stillOpen(documentId: string): Promise<string[]> {
  const rows = await withTenant(db.rw, f.s.tenant, f.s.human, (tx) => openQuantity(tx, documentId));
  return rows.map((r) => r.openQuantity);
}

describe("convertToInvoice under policy v2 — a converted invoice carries tax (spec:2228, ADR 0050)", () => {
  it("a body-level taxCodeId taxes every converted line; posting writes the tax fact and credits 2300", async () => {
    const dO = await deliver([{ quantity: "4.000000", amount: "36.0000" }], "2026-01-10");
    const inv = await postedInvoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-11",
      taxCodeId: f.codes["SYN-OUT-STD"]!,
      lines: [],
    });
    // round(36.0000 × 0.11, 4) = 3.9600 on the NET, which stays the net (tax-exclusive draft).
    expect(await linesOf(inv.documentId)).toEqual([
      {
        lineNo: 1,
        taxCodeId: f.codes["SYN-OUT-STD"],
        amount: "36.0000",
        tax: "3.9600",
        total: "39.9600",
      },
    ]);
    const [head] = await db.admin<{ inclusive: boolean }[]>`
      select tax_inclusive as inclusive from app.document where id = ${inv.documentId}`;
    expect(head!.inclusive).toBe(false);
    expect(await taxFacts(inv.documentId)).toEqual([
      { lineNo: 1, taxCodeId: f.codes["SYN-OUT-STD"], base: "36.0000", tax: "3.9600" },
    ]);
    // The receivable takes the gross, revenue the net, 2300 the tax — and the cost legs relieve 1250 as before.
    expect(await legs(inv.documentId)).toEqual([
      { code: "1200", debit: "39.9600", credit: "0.0000" },
      { code: "1250", debit: "0.0000", credit: "12.0000" },
      { code: "2300", debit: "0.0000", credit: "3.9600" },
      { code: "4000", debit: "0.0000", credit: "36.0000" },
      { code: "5000", debit: "12.0000", credit: "0.0000" },
    ]);
  });

  it("a line's own taxCodeId overrides the body's; a line naming none takes the body's", async () => {
    const dO = await deliver(
      [
        { quantity: "4.000000", amount: "36.0000" },
        { quantity: "2.000000", amount: "18.0000" },
      ],
      "2026-01-12",
    );
    const inv = await draftInvoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-12",
      taxCodeId: f.codes["SYN-OUT-STD"]!,
      lines: [
        {
          sourceLineId: dO.lineIds[0]!,
          quantity: "4.000000",
          taxCodeId: f.codes["SYN-OUT-ZERO"]!,
        },
        { sourceLineId: dO.lineIds[1]!, quantity: "2.000000" },
      ],
    });
    expect(await linesOf(inv.documentId)).toEqual([
      {
        lineNo: 1,
        taxCodeId: f.codes["SYN-OUT-ZERO"],
        amount: "36.0000",
        tax: "0.0000",
        total: "36.0000",
      },
      {
        lineNo: 2,
        taxCodeId: f.codes["SYN-OUT-STD"],
        amount: "18.0000",
        tax: "1.9800",
        total: "19.9800",
      },
    ]);
  });

  it("a source line's own tax_code_id is carried when the body names none — and a body code overrides it", async () => {
    const coded = await deliver(
      [{ quantity: "4.000000", amount: "36.0000", taxCode: "SYN-OUT-STD" }],
      "2026-01-13",
    );
    const inv = await postedInvoice({
      sourceDocumentId: coded.documentId,
      effectiveDate: "2026-01-13",
      lines: [],
    });
    expect(await linesOf(inv.documentId)).toEqual([
      {
        lineNo: 1,
        taxCodeId: f.codes["SYN-OUT-STD"],
        amount: "36.0000",
        tax: "3.9600",
        total: "39.9600",
      },
    ]);
    expect(await taxFacts(inv.documentId)).toEqual([
      { lineNo: 1, taxCodeId: f.codes["SYN-OUT-STD"], base: "36.0000", tax: "3.9600" },
    ]);
    expect((await legs(inv.documentId)).find((l) => l.code === "2300")).toEqual({
      code: "2300",
      debit: "0.0000",
      credit: "3.9600",
    });

    const overridden = await deliver(
      [{ quantity: "4.000000", amount: "36.0000", taxCode: "SYN-OUT-STD" }],
      "2026-01-13",
    );
    const zero = await draftInvoice({
      sourceDocumentId: overridden.documentId,
      effectiveDate: "2026-01-13",
      taxCodeId: f.codes["SYN-OUT-ZERO"]!,
      lines: [],
    });
    expect((await linesOf(zero.documentId)).map((l) => [l.taxCodeId, l.tax])).toEqual([
      [f.codes["SYN-OUT-ZERO"], "0.0000"],
    ]);
  });

  it("a two-step partial conversion (1/3 then 2/3) keeps the NET residue exact, and both invoices are taxed", async () => {
    // The residue rule sums the earlier conversion's `amount`. Were the draft computed inclusive, that
    // `amount` would be rewritten to an extracted base (3.3333 / 1.11 = 3.0030) and the closing conversion
    // would take 10.0000 − 3.0030 = 6.9970, so the two nets would not add up to the delivery's value.
    const dO = await deliver(
      [{ quantity: "3.333333", amount: "10.0000", unitPrice: "3.0000" }],
      "2026-01-14",
    );
    const line = dO.lineIds[0]!;
    const first = await postedInvoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-14",
      taxCodeId: f.codes["SYN-OUT-STD"]!,
      lines: [{ sourceLineId: line, quantity: "1.111111" }],
    });
    const second = await postedInvoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-15",
      taxCodeId: f.codes["SYN-OUT-STD"]!,
      lines: [{ sourceLineId: line, quantity: "2.222222" }],
    });
    const [a] = await linesOf(first.documentId);
    const [b] = await linesOf(second.documentId);
    // round(10.0000 / 3, 4) = 3.3333 pro-rata; the closing conversion takes the residue 6.6667.
    expect(a).toMatchObject({ amount: "3.3333", tax: "0.3667", total: "3.7000" }); // 0.366663 → 0.3667
    expect(b).toMatchObject({ amount: "6.6667", tax: "0.7333", total: "7.4000" }); // 0.733337 → 0.7333
    expect(plus4(a!.amount, b!.amount)).toBe("10.0000");
    expect((await taxFacts(first.documentId)).map((t) => t.tax)).toEqual(["0.3667"]);
    expect((await taxFacts(second.documentId)).map((t) => t.tax)).toEqual(["0.7333"]);
    expect(await stillOpen(dO.documentId)).toEqual(["0.000000"]);
  });

  it("a tax code of ANOTHER company is refused with ERR_NOT_FOUND, at the body and on a line, drafting nothing", async () => {
    // RLS bounds the tenant and nothing else, and `document_line_tax_code_fk` (0055) is tenant-composite: a
    // sibling company's code would satisfy it, and its accounts would take this company's tax.
    const foreign = await withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      const [company] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${f.s.tenant}, 'CTAX-B', 'Conversion tax second company', 'MYR') returning id`;
      const [regime] = await tx<{ id: string }[]>`
        insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                    name_en, source)
        values (${f.s.tenant}, ${company!.id}, 'SYNTH-MY-v1', 'MY', 1, '2026-01-01',
                'Sibling regime', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
        returning id`;
      const [code] = await tx<{ id: string }[]>`
        insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, rate, kind, rounding_mode,
                                  effective_from)
        values (${f.s.tenant}, ${company!.id}, ${regime!.id}, 'SYN-OUT-ZERO', 'Sibling zero', 0, 'zero',
                'HALF_AWAY_FROM_ZERO', '2026-01-01')
        returning id`;
      return code!.id;
    });
    const dO = await deliver([{ quantity: "1.000000", amount: "9.0000" }], "2026-01-16");
    await expect(
      draftInvoice({
        sourceDocumentId: dO.documentId,
        effectiveDate: "2026-01-16",
        taxCodeId: foreign,
        lines: [],
      }),
    ).rejects.toThrow(/ERR_NOT_FOUND: tax code .* is not a tax code of company/);
    await expect(
      draftInvoice({
        sourceDocumentId: dO.documentId,
        effectiveDate: "2026-01-16",
        lines: [{ sourceLineId: dO.lineIds[0]!, quantity: "1.000000", taxCodeId: foreign }],
      }),
    ).rejects.toThrow(/ERR_NOT_FOUND: tax code .* is not a tax code of company/);
    expect(await stillOpen(dO.documentId)).toEqual(["1.000000"]);
  });

  it("a code NAMED for a tax-INCLUSIVE source is refused, at the body and on a line; an uncoded conversion of it still drafts", async () => {
    // A conversion residue is defined over net figures; an inclusive source's price is gross, and nothing
    // here may guess the net of it (an owner question, not a silent choice).
    const dO = await deliver([{ quantity: "1.000000", amount: "9.0000" }], "2026-01-17", {
      taxInclusive: true,
    });
    await expect(
      draftInvoice({
        sourceDocumentId: dO.documentId,
        effectiveDate: "2026-01-17",
        taxCodeId: f.codes["SYN-OUT-STD"]!,
        lines: [],
      }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: source document .* is tax-inclusive/);
    await expect(
      draftInvoice({
        sourceDocumentId: dO.documentId,
        effectiveDate: "2026-01-17",
        lines: [
          {
            sourceLineId: dO.lineIds[0]!,
            quantity: "1.000000",
            taxCodeId: f.codes["SYN-OUT-STD"]!,
          },
        ],
      }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: source document .* is tax-inclusive/);
    expect(await stillOpen(dO.documentId)).toEqual(["1.000000"]);

    const plain = await draftInvoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-17",
      lines: [],
    });
    expect(await linesOf(plain.documentId)).toEqual([
      { lineNo: 1, taxCodeId: null, amount: "9.0000", tax: "0.0000", total: "9.0000" },
    ]);
  });

  it("a tax-INCLUSIVE source's own line codes are inherited and refused — never dropped silently; an explicit taxCodeId null converts it untaxed", async () => {
    // Dropping the inherited code would draft an untaxed invoice under a policy that applies tax with no
    // signal, booking the gross as revenue. The refusal is the default; the caller who means "untaxed" says
    // so with `taxCodeId: null` — at the body or on the line — so the source is never a dead end either.
    const inherited = await deliver(
      [{ quantity: "1.000000", amount: "9.0000", taxCode: "SYN-OUT-STD" }],
      "2026-01-17",
      { taxInclusive: true },
    );
    await expect(
      draftInvoice({
        sourceDocumentId: inherited.documentId,
        effectiveDate: "2026-01-17",
        lines: [],
      }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: source document .* is tax-inclusive.*taxCodeId null/);
    expect(await stillOpen(inherited.documentId)).toEqual(["1.000000"]);

    const atBody = await draftInvoice({
      sourceDocumentId: inherited.documentId,
      effectiveDate: "2026-01-17",
      taxCodeId: null,
      lines: [{ sourceLineId: inherited.lineIds[0]!, quantity: "0.500000" }],
    });
    expect(await linesOf(atBody.documentId)).toEqual([
      { lineNo: 1, taxCodeId: null, amount: "4.5000", tax: "0.0000", total: "4.5000" },
    ]);
    const onLine = await draftInvoice({
      sourceDocumentId: inherited.documentId,
      effectiveDate: "2026-01-17",
      lines: [{ sourceLineId: inherited.lineIds[0]!, quantity: "0.500000", taxCodeId: null }],
    });
    expect(await linesOf(onLine.documentId)).toEqual([
      { lineNo: 1, taxCodeId: null, amount: "4.5000", tax: "0.0000", total: "4.5000" },
    ]);
    expect(await stillOpen(inherited.documentId)).toEqual(["0.000000"]);
  });

  it("an explicit null is 'no code', not 'fall through': a line's null beats the body's code, the body's null beats the source line's", async () => {
    const coded = await deliver(
      [
        { quantity: "1.000000", amount: "9.0000", taxCode: "SYN-OUT-STD" },
        { quantity: "1.000000", amount: "9.0000", taxCode: "SYN-OUT-STD" },
      ],
      "2026-01-23",
    );
    const inv = await draftInvoice({
      sourceDocumentId: coded.documentId,
      effectiveDate: "2026-01-23",
      taxCodeId: null,
      lines: [
        {
          sourceLineId: coded.lineIds[0]!,
          quantity: "1.000000",
          taxCodeId: f.codes["SYN-OUT-ZERO"]!,
        },
        { sourceLineId: coded.lineIds[1]!, quantity: "1.000000" },
      ],
    });
    expect((await linesOf(inv.documentId)).map((l) => [l.taxCodeId, l.tax, l.total])).toEqual([
      [f.codes["SYN-OUT-ZERO"], "0.0000", "9.0000"],
      [null, "0.0000", "9.0000"],
    ]);

    const plain = await deliver([{ quantity: "1.000000", amount: "9.0000" }], "2026-01-23");
    const cleared = await draftInvoice({
      sourceDocumentId: plain.documentId,
      effectiveDate: "2026-01-23",
      taxCodeId: f.codes["SYN-OUT-STD"]!,
      lines: [{ sourceLineId: plain.lineIds[0]!, quantity: "1.000000", taxCodeId: null }],
    });
    expect((await linesOf(cleared.documentId)).map((l) => [l.taxCodeId, l.tax])).toEqual([
      [null, "0.0000"],
    ]);
  });

  it("3D carries the ORDER's tax_inclusive onto the delivery: an inclusive order's gross price is never taxed again on conversion", async () => {
    // An order entered at a gross 111.00 with taxInclusive true. Were the delivery's header left at 0054's
    // default (false), a coded conversion would invoice 111.00 as the NET and add 12.21 on top.
    const dO = await orderThenDeliver(
      { quantity: "1.000000", unitPrice: "111.0000", amount: "111.0000" },
      "2026-01-24",
      { taxInclusive: true },
    );
    const [head] = await db.admin<{ inclusive: boolean }[]>`
      select tax_inclusive as inclusive from app.document where id = ${dO.documentId}`;
    expect(head!.inclusive).toBe(true);
    await expect(
      draftInvoice({
        sourceDocumentId: dO.documentId,
        effectiveDate: "2026-01-24",
        taxCodeId: f.codes["SYN-OUT-STD"]!,
        lines: [],
      }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: source document .* is tax-inclusive/);
    expect(await stillOpen(dO.documentId)).toEqual(["1.000000"]);
  });

  it("3D carries the ORDER line's tax code onto the delivery, so order → delivery → invoice is taxed by default", async () => {
    const dO = await orderThenDeliver(
      { quantity: "2.000000", unitPrice: "9.0000", amount: "18.0000", taxCode: "SYN-OUT-STD" },
      "2026-01-25",
    );
    const delivered = await db.admin<{ taxCodeId: string | null; inclusive: boolean }[]>`
      select dl.tax_code_id as "taxCodeId", d.tax_inclusive as inclusive
        from app.document_line dl join app.document d on d.id = dl.document_id
       where dl.document_id = ${dO.documentId}`;
    expect(delivered).toEqual([{ taxCodeId: f.codes["SYN-OUT-STD"], inclusive: false }]);

    const inv = await postedInvoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-25",
      lines: [],
    });
    expect(await linesOf(inv.documentId)).toEqual([
      {
        lineNo: 1,
        taxCodeId: f.codes["SYN-OUT-STD"],
        amount: "18.0000",
        tax: "1.9800",
        total: "19.9800",
      },
    ]);
    expect(await taxFacts(inv.documentId)).toEqual([
      { lineNo: 1, taxCodeId: f.codes["SYN-OUT-STD"], base: "18.0000", tax: "1.9800" },
    ]);
    expect((await legs(inv.documentId)).find((l) => l.code === "2300")).toEqual({
      code: "2300",
      debit: "0.0000",
      credit: "1.9800",
    });
  });

  it("a FOREIGN-CURRENCY delivery converted with a code: the tax fact's base twins are round(x × rate, 4) and 2300 takes tax_base", async () => {
    // 2 × 9.0000 USD at 4.6835: net 18.0000 USD = 84.3030 MYR; tax round(18 × 0.11, 4) = 1.9800 USD,
    // round(1.98 × 4.6835, 4) = 9.2733 MYR (9.27333). The receivable is 19.9800 USD = 93.5763 MYR (93.57633),
    // which is exactly 84.3030 + 9.2733 — the two roundings tie, no rounding leg.
    const dO = await deliver([{ quantity: "2.000000", amount: "18.0000" }], "2026-01-26", {
      currency: "USD",
      exchangeRate: "4.68350000",
    });
    const [deliveredCost] = await db.admin<{ cost: string }[]>`
      select cost::numeric(19,4)::text as cost from app.document_line where document_id = ${dO.documentId}`;
    const inv = await postedInvoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-26",
      taxCodeId: f.codes["SYN-OUT-STD"]!,
      lines: [],
    });
    expect(await linesOf(inv.documentId)).toEqual([
      {
        lineNo: 1,
        taxCodeId: f.codes["SYN-OUT-STD"],
        amount: "18.0000",
        tax: "1.9800",
        total: "19.9800",
      },
    ]);
    expect(
      await db.admin<{ base: string; tax: string; baseBase: string; taxBase: string }[]>`
        select base::text as base, tax::text as tax, base_base::text as "baseBase",
               tax_base::text as "taxBase"
          from app.tax_transaction where document_id = ${inv.documentId}`,
    ).toEqual([{ base: "18.0000", tax: "1.9800", baseBase: "84.3030", taxBase: "9.2733" }]);
    // `legs` is netted per account in BASE: 2300's credit is the fact's tax_base; the cost legs are base at
    // rate 1 — the delivery's own cost, never converted a second time.
    expect(await legs(inv.documentId)).toEqual([
      { code: "1200", debit: "93.5763", credit: "0.0000" },
      { code: "1250", debit: "0.0000", credit: deliveredCost!.cost },
      { code: "2300", debit: "0.0000", credit: "9.2733" },
      { code: "4000", debit: "0.0000", credit: "84.3030" },
      { code: "5000", debit: deliveredCost!.cost, credit: "0.0000" },
    ]);
  });

  it("a code named for a tax-INCLUSIVE source is accepted when the target applies no tax — nothing is computed from it", async () => {
    // The refusal guards a residue over GROSS figures being taxed as net; a target that computes no tax
    // computes nothing from the code, so there is nothing to refuse.
    const untaxedType = await salesInvoiceVariant("SALES_INVOICE_UNTAXED", {
      applies: false,
      inclusive: false,
    });
    const dO = await deliver([{ quantity: "1.000000", amount: "9.0000" }], "2026-01-21", {
      taxInclusive: true,
    });
    const inv = await convertInto(untaxedType, {
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-21",
      taxCodeId: f.codes["SYN-OUT-STD"]!,
      lines: [],
    });
    expect(await linesOf(inv.documentId)).toEqual([
      {
        lineNo: 1,
        taxCodeId: f.codes["SYN-OUT-STD"],
        amount: "9.0000",
        tax: "0.0000",
        total: "9.0000",
      },
    ]);
  });

  it("a target type whose policy DECLARES tax inclusive is refused for any coded line, named or inherited, drafting nothing", async () => {
    // Writing the draft's header `tax_inclusive = false` does not make it exclusive: `resolveInclusive` takes
    // the policy's literal `true` over the header, and `computeDocumentTax` would then rewrite the converted
    // NET `amount` to an extracted base — which the residue rule would sum, stranding the difference in 1250.
    // The target type is the caller's choice, so this refusal has an exit: a type that is exclusive or
    // follows the header.
    const inclusiveType = await salesInvoiceVariant("SALES_INVOICE_INCL", {
      applies: true,
      inclusive: true,
    });
    const dO = await deliver([{ quantity: "3.000000", amount: "27.0000" }], "2026-01-22");
    await expect(
      convertInto(inclusiveType, {
        sourceDocumentId: dO.documentId,
        effectiveDate: "2026-01-22",
        taxCodeId: f.codes["SYN-OUT-STD"]!,
        lines: [{ sourceLineId: dO.lineIds[0]!, quantity: "1.000000" }],
      }),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: target type SALES_INVOICE_INCL computes tax inclusive/,
    );
    expect(await stillOpen(dO.documentId)).toEqual(["3.000000"]);

    const coded = await deliver(
      [{ quantity: "1.000000", amount: "9.0000", taxCode: "SYN-OUT-STD" }],
      "2026-01-22",
    );
    await expect(
      convertInto(inclusiveType, {
        sourceDocumentId: coded.documentId,
        effectiveDate: "2026-01-22",
        lines: [],
      }),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: target type SALES_INVOICE_INCL computes tax inclusive/,
    );
    expect(await stillOpen(coded.documentId)).toEqual(["1.000000"]);

    // The refusal is about CODES: an uncoded conversion into the same type drafts, its net untouched.
    const plain = await convertInto(inclusiveType, {
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-22",
      lines: [],
    });
    expect(await linesOf(plain.documentId)).toEqual([
      { lineNo: 1, taxCodeId: null, amount: "27.0000", tax: "0.0000", total: "27.0000" },
    ]);
  });

  it("a code not effective on the invoice date is refused with ERR_TAX_REGIME_MISMATCH, drafting nothing", async () => {
    // A code of THIS company passes the company check; the effective-date refusal is computeDocumentTax's,
    // the one rule `PUT …/lines` meets too.
    const late = await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      createTaxCode(tx, ctx(), {
        companyId: f.s.company,
        regimeId: f.regimeId,
        code: "SYN-OUT-LATE",
        nameEn: "Standard-rated from July (synthetic)",
        rate: "0.11000000",
        kind: "output",
        roundingMode: "HALF_AWAY_FROM_ZERO",
        accountCode: "2300",
        effectiveFrom: "2026-07-01",
      }),
    );
    const dO = await deliver([{ quantity: "1.000000", amount: "9.0000" }], "2026-01-18");
    await expect(
      draftInvoice({
        sourceDocumentId: dO.documentId,
        effectiveDate: "2026-01-18",
        taxCodeId: late.id,
        lines: [],
      }),
    ).rejects.toThrow(
      /ERR_TAX_REGIME_MISMATCH: line 1: tax code SYN-OUT-LATE is not effective on 2026-01-18/,
    );
    expect(await stillOpen(dO.documentId)).toEqual(["1.000000"]);
  });

  it("GOODS_RECEIPT → PURCHASE_INVOICE with an input code: the tax debits 1350 and the payable takes the gross", async () => {
    const grn = await receive("5.000000", "4.0000", "20.0000", "2026-01-19");
    const inv = await postedInvoice({
      target: "PURCHASE_INVOICE",
      sourceDocumentId: grn.documentId,
      effectiveDate: "2026-01-20",
      taxCodeId: f.codes["SYN-IN-STD"]!,
      lines: [],
    });
    expect(await linesOf(inv.documentId)).toEqual([
      {
        lineNo: 1,
        taxCodeId: f.codes["SYN-IN-STD"],
        amount: "20.0000",
        tax: "2.2000",
        total: "22.2000",
      },
    ]);
    expect(await taxFacts(inv.documentId)).toEqual([
      { lineNo: 1, taxCodeId: f.codes["SYN-IN-STD"], base: "20.0000", tax: "2.2000" },
    ]);
    // 2150 is relieved by the NET — exactly the receipt's accrual — and 1350 takes the input tax.
    expect(await legs(inv.documentId)).toEqual([
      { code: "1350", debit: "2.2000", credit: "0.0000" },
      { code: "2100", debit: "0.0000", credit: "22.2000" },
      { code: "2150", debit: "20.0000", credit: "0.0000" },
    ]);
  });
});

/**
 * 3C's CLIENT path to a priced stock document (PR 11 review, round 2). 3D's `convertOrderToDelivery` carries
 * the order's `tax_inclusive` and line codes onto the delivery it drafts. The purchase side has no such
 * service: a GOODS_RECEIPT is drafted by the client and priced from its order through `POST …/links`
 * (`linkFulfilment`, `priceFromSource` defaulted true), as a client-drafted DELIVERY_ORDER is. That copy took
 * the order's `unit_price` — GROSS on an inclusive order — and none of its tax facts, so the receipt read
 * exclusive and uncoded: `convertToInvoice`'s inclusive-source refusal never fired and the gross was taxed as
 * net (a PO at 111.00 incl. 11% → receipt 111 → invoice base 111, tax 12.21, payable 123.21). A copy between
 * documents of different `tax_inclusive` is refused now, and the order line's code rides the copy for the two
 * order → stock-document kinds.
 */
describe("3C's link price copy carries the order's tax facts (fulfils, receives_against)", () => {
  /** An order of one item line, its `tax_inclusive` written on the DRAFT (0117 freezes the header after), then
   *  issued — 3C links only from an issued or posted source. */
  async function issuedOrder(
    typeId: string,
    series: string,
    partyId: string,
    line: { quantity: string; unitPrice: string; amount: string; taxCode?: string },
    date: string,
    opts: { taxInclusive?: boolean } = {},
  ) {
    const order = await draftTypedDocument(db, f.s, {
      documentTypeId: typeId,
      series,
      effectiveDate: date,
      partyId,
      lines: [
        {
          kind: "item" as const,
          itemId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          amount: line.amount,
          ...(line.taxCode === undefined ? {} : { taxCodeId: f.codes[line.taxCode]! }),
        },
      ],
    });
    await withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      if (opts.taxInclusive === true) {
        await tx`update app.document set tax_inclusive = true where id = ${order.documentId}`;
      }
      await issueDocument(tx, ctx(), { documentId: order.documentId });
    });
    return order;
  }

  /** A stock document as a client drafts it before linking: a quantity and NO price, `tax_inclusive` on the
   *  draft, and optionally a code of its own. */
  async function unpriced(
    typeId: string,
    series: string,
    partyId: string,
    quantity: string,
    date: string,
    opts: { taxInclusive?: boolean; taxCode?: string } = {},
  ) {
    const doc = await draftTypedDocument(db, f.s, {
      documentTypeId: typeId,
      series,
      effectiveDate: date,
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item" as const,
          itemId,
          warehouseId,
          quantity,
          ...(opts.taxCode === undefined ? {} : { taxCodeId: f.codes[opts.taxCode]! }),
        },
      ],
    });
    if (opts.taxInclusive === true) {
      await withTenant(
        db.rw,
        f.s.tenant,
        f.s.human,
        (tx) => tx`update app.document set tax_inclusive = true where id = ${doc.documentId}`,
      );
    }
    return doc;
  }

  type Drafted = { documentId: string; lineIds: string[] };

  /** `POST …/links` as the route calls it: `priceFromSource` left to its default. */
  function link(kind: LinkKind, source: Drafted, target: Drafted, quantity: string) {
    return withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      linkFulfilment(tx, ctx(), {
        sourceDocumentId: source.documentId,
        targetDocumentId: target.documentId,
        linkKind: kind,
        lines: [{ sourceLineId: source.lineIds[0]!, targetLineId: target.lineIds[0]!, quantity }],
      }),
    );
  }

  /** The target line's price, net and code as the copy left them. */
  function copied(documentId: string) {
    return db.admin<{ unitPrice: string | null; amount: string; taxCodeId: string | null }[]>`
      select unit_price::text as "unitPrice", amount::text as amount, tax_code_id as "taxCodeId"
        from app.document_line where document_id = ${documentId} order by line_no`;
  }

  function post(documentId: string) {
    return withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      postDocument(tx, ctx(), { documentId, jobs: recordingJobs() }),
    );
  }

  const MISMATCH =
    /ERR_VALIDATION_FAILED: source document .* is tax-inclusive and target document .* is tax-exclusive.*draft the target with the same taxInclusive as its order/;
  const INCLUSIVE_PO = {
    quantity: "1.000000",
    unitPrice: "111.0000",
    amount: "111.0000",
    taxCode: "SYN-IN-STD",
  };

  it("a PO drafted taxInclusive true is refused onto a GRN drafted without it — nothing linked, nothing priced", async () => {
    const po = await issuedOrder(poType, "PO", f.vendorId, INCLUSIVE_PO, "2026-02-02", {
      taxInclusive: true,
    });
    const grn = await unpriced(grnType, "GRN", f.vendorId, "1.000000", "2026-02-02");
    await expect(link("receives_against", po, grn, "1.000000")).rejects.toThrow(MISMATCH);
    expect(await stillOpen(po.documentId)).toEqual(["1.000000"]);
    expect(await copied(grn.documentId)).toEqual([
      { unitPrice: null, amount: "0.0000", taxCodeId: null },
    ]);
  });

  it("a GRN drafted taxInclusive true too links and is priced gross; a coded conversion is then refused, and taxCodeId null converts it untaxed", async () => {
    const po = await issuedOrder(poType, "PO", f.vendorId, INCLUSIVE_PO, "2026-02-03", {
      taxInclusive: true,
    });
    const grn = await unpriced(grnType, "GRN", f.vendorId, "1.000000", "2026-02-03", {
      taxInclusive: true,
    });
    await link("receives_against", po, grn, "1.000000");
    expect(await copied(grn.documentId)).toEqual([
      { unitPrice: "111.0000", amount: "111.0000", taxCodeId: f.codes["SYN-IN-STD"] },
    ]);
    await post(grn.documentId);

    // B3's inclusive-source rule now sees what the order said: a code named for the conversion is refused, and
    // so is the code the receipt line took from the order line — never taxing the gross 111 as a net.
    for (const named of [{ taxCodeId: f.codes["SYN-IN-STD"]! }, {}]) {
      await expect(
        draftInvoice({
          target: "PURCHASE_INVOICE",
          sourceDocumentId: grn.documentId,
          effectiveDate: "2026-02-04",
          ...named,
          lines: [],
        }),
      ).rejects.toThrow(/ERR_VALIDATION_FAILED: source document .* is tax-inclusive/);
    }
    expect(await stillOpen(grn.documentId)).toEqual(["1.000000"]);
    const untaxed = await draftInvoice({
      target: "PURCHASE_INVOICE",
      sourceDocumentId: grn.documentId,
      effectiveDate: "2026-02-04",
      taxCodeId: null,
      lines: [],
    });
    expect(await linesOf(untaxed.documentId)).toEqual([
      { lineNo: 1, taxCodeId: null, amount: "111.0000", tax: "0.0000", total: "111.0000" },
    ]);
  });

  it("an exclusive coded PO → GRN carries the order line's code, and a conversion naming none taxes the invoice: input tax debits 1350", async () => {
    const po = await issuedOrder(
      poType,
      "PO",
      f.vendorId,
      { quantity: "5.000000", unitPrice: "4.0000", amount: "20.0000", taxCode: "SYN-IN-STD" },
      "2026-02-05",
    );
    const grn = await unpriced(grnType, "GRN", f.vendorId, "5.000000", "2026-02-05");
    await link("receives_against", po, grn, "5.000000");
    expect(await copied(grn.documentId)).toEqual([
      { unitPrice: "4.0000", amount: "20.0000", taxCodeId: f.codes["SYN-IN-STD"] },
    ]);
    await post(grn.documentId);

    const inv = await postedInvoice({
      target: "PURCHASE_INVOICE",
      sourceDocumentId: grn.documentId,
      effectiveDate: "2026-02-06",
      lines: [],
    });
    expect(await linesOf(inv.documentId)).toEqual([
      {
        lineNo: 1,
        taxCodeId: f.codes["SYN-IN-STD"],
        amount: "20.0000",
        tax: "2.2000",
        total: "22.2000",
      },
    ]);
    expect(await taxFacts(inv.documentId)).toEqual([
      { lineNo: 1, taxCodeId: f.codes["SYN-IN-STD"], base: "20.0000", tax: "2.2000" },
    ]);
    expect(await legs(inv.documentId)).toEqual([
      { code: "1350", debit: "2.2000", credit: "0.0000" },
      { code: "2100", debit: "0.0000", credit: "22.2000" },
      { code: "2150", debit: "20.0000", credit: "0.0000" },
    ]);
  });

  it("a target line's own code is kept, and converts_to — a service's kind — prices through the route but carries no code", async () => {
    const po = await issuedOrder(
      poType,
      "PO",
      f.vendorId,
      { quantity: "1.000000", unitPrice: "4.0000", amount: "4.0000", taxCode: "SYN-IN-STD" },
      "2026-02-07",
    );
    const grn = await unpriced(grnType, "GRN", f.vendorId, "1.000000", "2026-02-07", {
      taxCode: "SYN-EXEMPT",
    });
    await link("receives_against", po, grn, "1.000000");
    expect(await copied(grn.documentId)).toEqual([
      { unitPrice: "4.0000", amount: "4.0000", taxCodeId: f.codes["SYN-EXEMPT"] },
    ]);

    // 3D's and 4A's conversions write `converts_to` with `priceFromSource: false` and carry the codes
    // themselves; the carry here is the order → stock-document copy's alone.
    const so = await issuedOrder(
      soType,
      "SO",
      f.customerId,
      { quantity: "1.000000", unitPrice: "9.0000", amount: "9.0000", taxCode: "SYN-OUT-STD" },
      "2026-02-07",
    );
    const dO = await unpriced(doType, "DO", f.customerId, "1.000000", "2026-02-07");
    await link("converts_to", so, dO, "1.000000");
    expect(await copied(dO.documentId)).toEqual([
      { unitPrice: "9.0000", amount: "9.0000", taxCodeId: null },
    ]);
  });

  it("SALES_ORDER → client-drafted DELIVERY_ORDER 'fulfils': an inclusive order onto an exclusive delivery is refused, and an exclusive coded order's code reaches the invoice (2300)", async () => {
    const inclusive = await issuedOrder(
      soType,
      "SO",
      f.customerId,
      { ...INCLUSIVE_PO, taxCode: "SYN-OUT-STD" },
      "2026-02-09",
      { taxInclusive: true },
    );
    const refused = await unpriced(doType, "DO", f.customerId, "1.000000", "2026-02-09");
    await expect(link("fulfils", inclusive, refused, "1.000000")).rejects.toThrow(MISMATCH);
    expect(await stillOpen(inclusive.documentId)).toEqual(["1.000000"]);

    const so = await issuedOrder(
      soType,
      "SO",
      f.customerId,
      { quantity: "2.000000", unitPrice: "9.0000", amount: "18.0000", taxCode: "SYN-OUT-STD" },
      "2026-02-09",
    );
    const dO = await unpriced(doType, "DO", f.customerId, "2.000000", "2026-02-09");
    await link("fulfils", so, dO, "2.000000");
    expect(await copied(dO.documentId)).toEqual([
      { unitPrice: "9.0000", amount: "18.0000", taxCodeId: f.codes["SYN-OUT-STD"] },
    ]);
    await post(dO.documentId);

    const inv = await postedInvoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-02-10",
      lines: [],
    });
    expect(await linesOf(inv.documentId)).toEqual([
      {
        lineNo: 1,
        taxCodeId: f.codes["SYN-OUT-STD"],
        amount: "18.0000",
        tax: "1.9800",
        total: "19.9800",
      },
    ]);
    expect((await legs(inv.documentId)).find((l) => l.code === "2300")).toEqual({
      code: "2300",
      debit: "0.0000",
      credit: "1.9800",
    });
  });
});
