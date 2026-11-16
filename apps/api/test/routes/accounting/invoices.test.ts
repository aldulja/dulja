import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConvertToInvoiceResultSchema, CreditNoteResultSchema } from "@dulja/contracts";
import { convertToInvoice, creditNoteFrom, postDocument } from "@dulja/db";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  withTenant,
  type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories up.
import { problemOf } from "../../../../../tests/support/api";
import {
  recordingJobs,
  secondPrincipal,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../../tests/invariants/support/post-inventory";
import { seedTypeFromPack } from "../../../../../tests/invariants/support/ar-ap";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let receiptType: string;
let deliveryType: string;
let invType: string;
let cnType: string;
let partyId: string;
let itemId: string;
let warehouseId: string;

const ctx = () => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/** The DELIVERY_ORDER pack policy, transcribed: stock out at `line.cost` from the item's inventory account
 *  into 1250. A REAL issue, so the line's cost is written by `applyMovements` at post — the one writer the
 *  suite leaves it to (§4.7.2) — and not by a fixture UPDATE on a posted document's line. */
const DELIVERY_POLICY = {
  version: 1,
  documentType: "API_DELIVERY",
  direction: "outbound",
  requires: ["party", "warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { code: "1250" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
  ],
  inventory: {
    effect: "issue",
    warehouse: "line.warehouse",
    costing: "consume_layers",
    allowNegative: true,
  },
  tax: { applies: false },
  numbering: { series: "ADO", assignAt: "issue" },
  reversal: { allowed: true, producesType: "API_DELIVERY" },
  approval: {
    required: false,
    approve: null,
    post: "inventory.transfer.post",
    create: "inventory.transfer.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
};

/** The invoice side of the corridor: cost of goods sold against 1250 at the copied cost. Its create code is
 *  SALES_INVOICE's own, which is what the handler's second gate asks. This suite drafts and never posts it —
 *  the corridor ARITHMETIC is the DB suite's (`packages/db/test/ar-ap/invoice-conversion.test.ts`). */
const INVOICE_POLICY = {
  version: 1,
  documentType: "API_SALES_INVOICE",
  direction: "outbound",
  requires: ["party"],
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
  numbering: { series: "AINV", assignAt: "issue" },
  // Task 8: the credit note below is this invoice's reversal target, as SALES_CREDIT_NOTE is SALES_INVOICE's
  // (spec:2024) — `creditNoteFrom` credits only into the type the invoice's pinned policy reverses into.
  reversal: { allowed: true, producesType: "API_CREDIT_NOTE" },
  approval: {
    required: false,
    approve: null,
    post: "accounting.sales.post",
    create: "accounting.sales.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};

/** 4A T8 — the credit note of API_SALES_INVOICE, built as SALES_CREDIT_NOTE is built over SALES_INVOICE: the
 *  SAME sides as the invoice, because the credit note's magnitudes are negated and A9 flips each side. Its
 *  create code is deliberately NOT the invoice's, so the handler's second gate is observable: here only a
 *  principal who may post sales may credit one (the pack gives both types `accounting.sales.create`). */
const CREDIT_NOTE_POLICY = {
  ...INVOICE_POLICY,
  documentType: "API_CREDIT_NOTE",
  direction: "inbound",
  requires: ["party", "reverses_document"],
  numbering: { series: "ACN", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: {
    required: false,
    approve: null,
    post: "accounting.sales.post",
    create: "accounting.sales.post",
  },
};

/** 5A — the invoice policy with tax APPLIED (exclusive) and its tax leg, as SALES_INVOICE's version 2 has it.
 *  Drafted here and never posted, like API_SALES_INVOICE: the tax ARITHMETIC and the ledger are the DB suite's
 *  (`packages/db/test/tax/convert-to-invoice-tax.test.ts`); this proves the wire carries the codes and the
 *  route reaches the persist-time computation. */
const TAXED_INVOICE_POLICY = {
  ...INVOICE_POLICY,
  documentType: "API_TAXED_INVOICE",
  lines: [
    ...INVOICE_POLICY.lines,
    {
      for: "each_tax",
      side: "credit",
      account: { from: "tax_code.output_account" },
      amount: "tax.amount",
    },
  ],
  tax: { applies: true, inclusive: false },
  numbering: { series: "ATI", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
};

const convertPath = (documentId: string, companyId = s.company) =>
  `/v1/companies/${companyId}/documents/${documentId}/convert-to-invoice`;
const convertBody = (effectiveDate: string, lines: unknown[] = []) => ({
  targetDocumentTypeId: invType,
  targetSeries: "AINV",
  effectiveDate,
  lines,
});

/** Draft a delivery of `quantity` at 9.0000 and post it through the real posting service. */
async function postedSource(quantity: string, amount: string, effectiveDate: string) {
  const { documentId, lineIds } = await draftTypedDocument(api.db, s, {
    documentTypeId: deliveryType,
    series: "ADO",
    effectiveDate,
    partyId,
    warehouseId,
    lines: [{ kind: "item", itemId, warehouseId, quantity, unitPrice: "9.0000", amount }],
  });
  await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
    postDocument(tx, ctx(), { documentId, jobs: recordingJobs() }),
  );
  return { documentId, lineIds };
}

/** A delivery of `quantity` converted into an invoice and POSTED — the one path that gives an invoice line
 *  its copied cost (§4.7.2 amendment 5), at 3.0000 a unit from the single layer below. */
async function postedInvoice(quantity: string, amount: string, effectiveDate: string) {
  const src = await postedSource(quantity, amount, effectiveDate);
  return withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
    const r = await convertToInvoice(tx, ctx(), {
      companyId: s.company,
      sourceDocumentId: src.documentId,
      targetDocumentTypeId: invType,
      targetSeries: "AINV",
      effectiveDate,
      lines: [],
    });
    await postDocument(tx, ctx(), { documentId: r.documentId });
    return { documentId: r.documentId, lineIds: r.lineIds };
  });
}

const creditPath = (documentId: string, companyId = s.company) =>
  `/v1/companies/${companyId}/documents/${documentId}/credit-note`;
const creditBody = (effectiveDate: string, reason: string | undefined, lines: unknown[] = []) => ({
  targetDocumentTypeId: cnType,
  targetSeries: "ACN",
  effectiveDate,
  ...(reason === undefined ? {} : { reason }),
  lines,
});

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "invoices-api");
  // The receipt's post code, the delivery's post code, and the two codes the conversion's two gates ask:
  // the SOURCE's create (`inventory.transfer.create`) and the TARGET's (`accounting.sales.create`). Task 8
  // adds the invoice's post code, which is also the credit note's create code (CREDIT_NOTE_POLICY above).
  await grantCodes(api.db, s, {
    codes: [
      "accounting.journal.post",
      "inventory.transfer.create",
      "inventory.transfer.post",
      "accounting.sales.create",
      "accounting.sales.post",
    ],
  });
  // `1300`, `5000` and `5900` come with `seedItem`, `1200` with `seedParty`, `5920` with `seedTenantV2`.
  await seedAccount(api.db, s, {
    code: "1250",
    nameEn: "Goods delivered not invoiced",
    type: "asset",
  });
  receiptType = await seedDocumentType(api.db, s, {
    code: "STOCK_RECEIPT_TEST",
    module: "inventory",
    policy: STOCK_RECEIPT_COST_POLICY,
  });
  deliveryType = await seedDocumentType(api.db, s, {
    code: "API_DELIVERY",
    module: "inventory",
    policy: DELIVERY_POLICY,
  });
  invType = await seedDocumentType(api.db, s, {
    code: "API_SALES_INVOICE",
    module: "accounting",
    policy: INVOICE_POLICY,
  });
  cnType = await seedDocumentType(api.db, s, {
    code: "API_CREDIT_NOTE",
    module: "accounting",
    policy: CREDIT_NOTE_POLICY,
  });
  partyId = await seedParty(api.db, s, { kind: "customer", code: "API-CONV" });
  ({ itemId } = await seedItem(api.db, s, {
    code: "API-CONV-IT",
    kind: "product",
    trackLots: false,
  }));
  warehouseId = await seedWarehouse(api.db, s, { code: "API-CONV-WH" });
  // Sixty units at 3.0000 in one layer, so every delivery below costs 3.0000 a unit. The deliveries below
  // take about forty; the rest is headroom, so a new case never runs a later one short (ERR_STOCK_INSUFFICIENT).
  const receipt = await draftTypedDocument(api.db, s, {
    documentTypeId: receiptType,
    series: "SRT",
    effectiveDate: "2026-01-05",
    warehouseId,
    lines: [
      {
        kind: "item",
        itemId,
        warehouseId,
        quantity: "60.000000",
        unitPrice: "3.0000",
        amount: "180.0000",
      },
    ],
  });
  await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
    postDocument(tx, ctx(), { documentId: receipt.documentId, jobs: recordingJobs() }),
  );
}, 240_000);
afterAll(async () => {
  await api.stop();
});

describe("POST /v1/companies/{companyId}/documents/{documentId}/convert-to-invoice (4A T6)", () => {
  it("201s with the draft invoice, its line ids and its link ids; an empty `lines` converts everything open", async () => {
    const src = await postedSource("4.000000", "36.0000", "2026-01-10");
    const res = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: convertBody("2026-01-11"),
    });
    expect(res.status).toBe(201);
    // `parse`, not `safeParse().success`: a failure must name the member that did not match.
    const body = ConvertToInvoiceResultSchema.parse(await res.json());
    expect(body.lineIds).toHaveLength(1);
    expect(body.linkIds).toHaveLength(1);
    // The copied cost reached the draft — the one figure the whole corridor rests on — beside the price.
    const rows = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string; cost: string; q: string; amount: string }[]>`
        select d.status::text as status, l.cost::text as cost, l.quantity::text as q,
               l.amount::text as amount
          from app.document_line l join app.document d on d.id = l.document_id
         where l.document_id = ${body.documentId}`,
    );
    expect(rows).toEqual([{ status: "draft", cost: "12.0000", q: "4.000000", amount: "36.0000" }]);
  });

  it("the path parameter is the SOURCE, and the first gate resolves the SOURCE's policy", async () => {
    // §4.5.4 maps "submit" to `approval.create ?? approval.post` of the document the path names, which for
    // API_DELIVERY is `inventory.transfer.create`. A principal holding nothing is refused before the handler.
    const src = await postedSource("1.000000", "9.0000", "2026-01-12");
    const outsider = await secondPrincipal(api.db, s, "conv-outsider");
    // A member of the company holding no code: a caller with NO role in the path company is refused on the
    // company before any policy is resolved (S3, code review 2), and this case is about which policy is.
    await grantCodes(api.db, s, { principalId: outsider, roleCode: "conv-outsider" });
    const res = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: outsider,
      body: convertBody("2026-01-12"),
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toMatch(/inventory\.transfer\.create/);
    const stranger = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      body: convertBody("2026-01-12"),
    });
    expect(stranger.status).toBe(401);
  });

  it("the second gate asks the TARGET type's create code: a picker who may ship may not raise an invoice", async () => {
    const src = await postedSource("1.000000", "9.0000", "2026-01-12");
    const picker = await secondPrincipal(api.db, s, "conv-picker");
    await grantCodes(api.db, s, {
      codes: ["inventory.transfer.create"],
      principalId: picker,
      roleCode: "conv-picker",
    });
    const res = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: picker,
      body: convertBody("2026-01-12"),
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toMatch(
      /accounting\.sales\.create is required to create a API_SALES_INVOICE/,
    );
    // …and nothing was drafted: the delivery is still fully open.
    const [open] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ open: string }[]>`
        select open_quantity::text as open from app.document_open_quantity
         where document_id = ${src.documentId}`,
    );
    expect(open!.open).toBe("1.000000");
  });

  it("POST without an Idempotency-Key is 400 ERR_IDEMPOTENCY_KEY_MISSING (§4.2.9)", async () => {
    const src = await postedSource("1.000000", "9.0000", "2026-01-13");
    const res = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      idempotencyKey: null,
      body: convertBody("2026-01-13"),
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("replaying the same key does not create a second draft invoice", async () => {
    const src = await postedSource("1.000000", "9.0000", "2026-01-14");
    const key = "4a-convert-replay";
    const body = convertBody("2026-01-14");
    const first = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      idempotencyKey: key,
      body,
    });
    const again = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      idempotencyKey: key,
      body,
    });
    expect(first.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(ConvertToInvoiceResultSchema.parse(await again.json()).documentId).toBe(
      ConvertToInvoiceResultSchema.parse(await first.json()).documentId,
    );
    const [links] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document_link where source_document_id = ${src.documentId}`,
    );
    expect(links!.n).toBe(1);
  });

  it("converting more than the open quantity is 422 ERR_DOC_LINK_OVER_FULFILLED, through 3C's own guard", async () => {
    const src = await postedSource("1.000000", "9.0000", "2026-01-15");
    const res = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: convertBody("2026-01-15", [{ sourceLineId: src.lineIds[0], quantity: "5.000000" }]),
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_DOC_LINK_OVER_FULFILLED");
  });

  it("a source that is not posted is 409 ERR_DOC_STATUS_ILLEGAL — nothing is in the corridor yet", async () => {
    const { documentId } = await draftTypedDocument(api.db, s, {
      documentTypeId: deliveryType,
      series: "ADO",
      effectiveDate: "2026-01-16",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          quantity: "1.000000",
          unitPrice: "9.0000",
          amount: "9.0000",
        },
      ],
    });
    const res = await api.request({
      method: "POST",
      path: convertPath(documentId),
      as: s.human,
      body: convertBody("2026-01-16"),
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_DOC_STATUS_ILLEGAL");
  });

  it("a `targetSeries` outside the registered shape, and a line named twice, are refused on the wire", async () => {
    const src = await postedSource("2.000000", "18.0000", "2026-01-16");
    const series = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: { ...convertBody("2026-01-16"), targetSeries: "not a series" },
    });
    expect(series.status).toBe(400);
    expect((await problemOf(series)).code).toBe("ERR_VALIDATION_FAILED");
    const twice = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: convertBody("2026-01-16", [
        { sourceLineId: src.lineIds[0], quantity: "1.000000" },
        { sourceLineId: src.lineIds[0], quantity: "1.000000" },
      ]),
    });
    expect(twice.status).toBe(400);
    expect((await problemOf(twice)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("the path company binds the source AND the target type: a sibling company's either is 404 (AGENTS.md)", async () => {
    const src = await postedSource("1.000000", "9.0000", "2026-01-17");
    const other = await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
      const [company] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${s.tenant}, 'API-CONV-B', 'Conversion second company', 'MYR') returning id`;
      const [type] = await tx<{ id: string }[]>`
        insert into app.document_type (tenant_id, company_id, code, name_en, module)
        values (${s.tenant}, ${company!.id}, 'API_SALES_INVOICE', 'Sales Invoice', 'accounting')
        returning id`;
      return { companyId: company!.id, typeId: type!.id };
    });
    // s.human becomes a member of the sibling company (a role holding nothing): a caller with no role in the
    // path company is refused on the company first (S3, code review 2), and this case is about the binding.
    await grantCodes(api.db, { ...s, company: other.companyId }, { roleCode: "api-conv-b-member" });
    // This company's delivery reached through the sibling company's path: the gate 404s on the document.
    const wrongCompany = await api.request({
      method: "POST",
      path: convertPath(src.documentId, other.companyId),
      as: s.human,
      body: convertBody("2026-01-17"),
    });
    expect(wrongCompany.status).toBe(404);
    expect((await problemOf(wrongCompany)).code).toBe("ERR_NOT_FOUND");
    // The sibling company's invoice type drafted onto this company's delivery: the handler 404s on the type.
    const wrongType = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: { ...convertBody("2026-01-17"), targetDocumentTypeId: other.typeId },
    });
    expect(wrongType.status).toBe(404);
    expect((await problemOf(wrongType)).code).toBe("ERR_NOT_FOUND");
  });

  // The PROBES half of hazard 31 is asserted where PROBES lives: `tests/invariants/tenant-isolation.test.ts`
  // compares its key set to ROUTES. This workspace may not import `tests/invariants/probes.ts`
  // (dependency-rule), so the half asserted here is the one that makes the other hold: a sub-path adds no
  // route module, so ROUTES — and therefore PROBES — gains no key for it.
  it("a sub-path adds no route module — the documents module already has its probe (hazard 31)", async () => {
    const { ROUTES } = await import("../../../src/routes");
    expect(ROUTES.some((r) => r.path === "/v1/companies/:companyId/documents")).toBe(true);
    expect(ROUTES.filter((r) => r.path.includes("convert-to-invoice"))).toEqual([]);
  });
});

describe("convert-to-invoice carries tax codes (5A, policy version 2)", () => {
  let taxedType: string;
  let codes: { std: string; zero: string; late: string; foreign: string };

  beforeAll(async () => {
    const outputTax = await seedAccount(api.db, s, {
      code: "2300",
      nameEn: "Output tax payable",
      type: "liability",
    });
    taxedType = await seedDocumentType(api.db, s, {
      code: "API_TAXED_INVOICE",
      module: "accounting",
      policy: TAXED_INVOICE_POLICY,
    });
    codes = await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
      const regime = async (companyId: string) => {
        const [r] = await tx<{ id: string }[]>`
          insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                      name_en, source)
          values (${s.tenant}, ${companyId}, 'SYNTH-MY-v1', 'MY', 1, '2026-01-01', 'Synthetic regime',
                  'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
          returning id`;
        return r!.id;
      };
      const code = async (
        companyId: string,
        regimeId: string,
        c: { code: string; rate: string; kind: string; account: string | null; from: string },
      ) => {
        const [row] = await tx<{ id: string }[]>`
          insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, rate, kind,
                                    rounding_mode, output_account_id, effective_from)
          values (${s.tenant}, ${companyId}, ${regimeId}, ${c.code}, ${c.code}, ${c.rate}, ${c.kind},
                  'HALF_AWAY_FROM_ZERO', ${c.account}, ${c.from})
          returning id`;
        return row!.id;
      };
      const own = await regime(s.company);
      const [sibling] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${s.tenant}, 'API-TAX-B', 'Conversion tax second company', 'MYR') returning id`;
      const theirs = await regime(sibling!.id);
      return {
        std: await code(s.company, own, {
          code: "API-OUT-STD",
          rate: "0.11000000",
          kind: "output",
          account: outputTax,
          from: "2026-01-01",
        }),
        zero: await code(s.company, own, {
          code: "API-OUT-ZERO",
          rate: "0",
          kind: "zero",
          account: null,
          from: "2026-01-01",
        }),
        late: await code(s.company, own, {
          code: "API-OUT-LATE",
          rate: "0.11000000",
          kind: "output",
          account: outputTax,
          from: "2026-07-01",
        }),
        foreign: await code(sibling!.id, theirs, {
          code: "API-OUT-ZERO",
          rate: "0",
          kind: "zero",
          account: null,
          from: "2026-01-01",
        }),
      };
    });
  });

  const taxedBody = (effectiveDate: string, extra: Record<string, unknown> = {}) => ({
    targetDocumentTypeId: taxedType,
    targetSeries: "ATI",
    effectiveDate,
    lines: [],
    ...extra,
  });

  const draftedLines = (documentId: string) =>
    withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string | null; amount: string; tax: string; total: string }[]>`
        select tax_code_id as code, amount::text as amount, tax_amount::text as tax,
               total_incl_tax::text as total
          from app.document_line where document_id = ${documentId} order by line_no`,
    );

  const openOf = async (documentId: string): Promise<string> => {
    const [row] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ open: string }[]>`
        select open_quantity::text as open from app.document_open_quantity
         where document_id = ${documentId}`,
    );
    return row!.open;
  };

  it("201s with a body-level code on every line and a line's own code overriding it, the tax computed at persist", async () => {
    const all = await postedSource("4.000000", "36.0000", "2026-01-24");
    const bodyLevel = await api.request({
      method: "POST",
      path: convertPath(all.documentId),
      as: s.human,
      body: taxedBody("2026-01-24", { taxCodeId: codes.std }),
    });
    expect(bodyLevel.status).toBe(201);
    const first = ConvertToInvoiceResultSchema.parse(await bodyLevel.json());
    expect(await draftedLines(first.documentId)).toEqual([
      { code: codes.std, amount: "36.0000", tax: "3.9600", total: "39.9600" },
    ]);

    const some = await postedSource("2.000000", "18.0000", "2026-01-24");
    const lineLevel = await api.request({
      method: "POST",
      path: convertPath(some.documentId),
      as: s.human,
      body: taxedBody("2026-01-24", {
        taxCodeId: codes.zero,
        lines: [{ sourceLineId: some.lineIds[0], quantity: "2.000000", taxCodeId: codes.std }],
      }),
    });
    expect(lineLevel.status).toBe(201);
    const second = ConvertToInvoiceResultSchema.parse(await lineLevel.json());
    expect(await draftedLines(second.documentId)).toEqual([
      { code: codes.std, amount: "18.0000", tax: "1.9800", total: "19.9800" },
    ]);
  });

  it("an unknown property is still 400, at the body and on a line — a client never states the tax (strict)", async () => {
    const src = await postedSource("1.000000", "9.0000", "2026-01-25");
    const atBody = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: taxedBody("2026-01-25", { taxCodeId: codes.std, taxAmount: "0.9900" }),
    });
    expect(atBody.status).toBe(400);
    expect((await problemOf(atBody)).code).toBe("ERR_VALIDATION_FAILED");
    const onLine = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: taxedBody("2026-01-25", {
        lines: [
          {
            sourceLineId: src.lineIds[0],
            quantity: "1.000000",
            taxCodeId: codes.std,
            taxAmount: "0.9900",
          },
        ],
      }),
    });
    expect(onLine.status).toBe(400);
    expect((await problemOf(onLine)).code).toBe("ERR_VALIDATION_FAILED");
    expect(await openOf(src.documentId)).toBe("1.000000");
  });

  it("a tax code of a sibling company is 404 ERR_NOT_FOUND and drafts nothing (AGENTS.md)", async () => {
    const src = await postedSource("1.000000", "9.0000", "2026-01-25");
    const res = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: taxedBody("2026-01-25", { taxCodeId: codes.foreign }),
    });
    expect(res.status).toBe(404);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_NOT_FOUND");
    // The TAX CODE's 404, not the source's or the type's: the same status from any other lookup would pass.
    expect(problem.detail).toMatch(/is not a tax code of company/);
    expect(await openOf(src.documentId)).toBe("1.000000");
  });

  it("a code not effective on the invoice date is 422 ERR_TAX_REGIME_MISMATCH and drafts nothing", async () => {
    const src = await postedSource("1.000000", "9.0000", "2026-01-26");
    const res = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: taxedBody("2026-01-26", { taxCodeId: codes.late }),
    });
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_TAX_REGIME_MISMATCH");
    expect(problem.detail).toMatch(/API-OUT-LATE is not effective on 2026-01-26/);
    expect(await openOf(src.documentId)).toBe("1.000000");
  });

  it("a coded conversion of a tax-INCLUSIVE source is 400 ERR_VALIDATION_FAILED", async () => {
    const { documentId } = await draftTypedDocument(api.db, s, {
      documentTypeId: deliveryType,
      series: "ADO",
      effectiveDate: "2026-01-26",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          quantity: "1.000000",
          unitPrice: "9.0000",
          amount: "9.0000",
        },
      ],
    });
    await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
      await tx`update app.document set tax_inclusive = true where id = ${documentId}`;
      await postDocument(tx, ctx(), { documentId, jobs: recordingJobs() });
    });
    const res = await api.request({
      method: "POST",
      path: convertPath(documentId),
      as: s.human,
      body: taxedBody("2026-01-26", { taxCodeId: codes.std }),
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/is tax-inclusive/);
    expect(problem.detail).toMatch(/pass taxCodeId null explicitly/);
    expect(await openOf(documentId)).toBe("1.000000");

    // The exit the refusal names: an explicit `null` converts it untaxed, on purpose.
    const untaxed = await api.request({
      method: "POST",
      path: convertPath(documentId),
      as: s.human,
      body: taxedBody("2026-01-26", { taxCodeId: null }),
    });
    expect(untaxed.status).toBe(201);
    const drafted = ConvertToInvoiceResultSchema.parse(await untaxed.json());
    expect(await draftedLines(drafted.documentId)).toEqual([
      { code: null, amount: "9.0000", tax: "0.0000", total: "9.0000" },
    ]);
    expect(await openOf(documentId)).toBe("0.000000");
  });

  it("an explicit taxCodeId null is accepted at the body and on a line, and means 'no code', not 'inherit'", async () => {
    const atBody = await postedSource("1.000000", "9.0000", "2026-01-26");
    const bodyNull = await api.request({
      method: "POST",
      path: convertPath(atBody.documentId),
      as: s.human,
      body: taxedBody("2026-01-26", { taxCodeId: null }),
    });
    expect(bodyNull.status).toBe(201);
    const first = ConvertToInvoiceResultSchema.parse(await bodyNull.json());
    expect(await draftedLines(first.documentId)).toEqual([
      { code: null, amount: "9.0000", tax: "0.0000", total: "9.0000" },
    ]);

    // A line's `null` beats the body's code.
    const onLine = await postedSource("1.000000", "9.0000", "2026-01-26");
    const lineNull = await api.request({
      method: "POST",
      path: convertPath(onLine.documentId),
      as: s.human,
      body: taxedBody("2026-01-26", {
        taxCodeId: codes.std,
        lines: [{ sourceLineId: onLine.lineIds[0], quantity: "1.000000", taxCodeId: null }],
      }),
    });
    expect(lineNull.status).toBe(201);
    const second = ConvertToInvoiceResultSchema.parse(await lineNull.json());
    expect(await draftedLines(second.documentId)).toEqual([
      { code: null, amount: "9.0000", tax: "0.0000", total: "9.0000" },
    ]);
  });

  it("PUT …/lines on a converted draft is 409 and keeps its converts_to links — the delivery cannot be invoiced twice", async () => {
    // A replacement DELETES every line, and `document_link.target_line_id` is ON DELETE CASCADE (0037), so
    // replacing a converted draft's lines would drop its links, reopen the delivery and let a second
    // conversion invoice the same goods again. The draft is deleted and converted again instead (a draft
    // cannot be voided: 0022 admits `void` from `issued` only).
    const src = await postedSource("1.000000", "9.0000", "2026-01-27");
    const converted = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: taxedBody("2026-01-27", { taxCodeId: codes.std }),
    });
    expect(converted.status).toBe(201);
    const { documentId, linkIds } = ConvertToInvoiceResultSchema.parse(await converted.json());
    expect(await openOf(src.documentId)).toBe("0.000000");

    const replaced = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/documents/${documentId}/lines`,
      as: s.human,
      body: {
        lines: [
          {
            lineNo: 1,
            kind: "item",
            itemId,
            warehouseId,
            quantity: "1.000000",
            unitPrice: "9.0000",
            amount: "9.0000",
            taxCodeId: codes.zero,
          },
        ],
      },
    });
    expect(replaced.status).toBe(409);
    const problem = await problemOf(replaced);
    expect(problem.code).toBe("ERR_DOC_STATUS_ILLEGAL");
    expect(problem.detail).toMatch(/delete the draft and convert again/);

    // Nothing moved: the delivery is still fully converted, the links stand, the draft's line is the
    // conversion's own.
    expect(await openOf(src.documentId)).toBe("0.000000");
    const links = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.document_link where target_document_id = ${documentId} order by id`,
    );
    expect(links.map((l) => l.id)).toEqual(linkIds);
    expect(await draftedLines(documentId)).toEqual([
      { code: codes.std, amount: "9.0000", tax: "0.9900", total: "9.9900" },
    ]);
    const again = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: taxedBody("2026-01-27", { taxCodeId: codes.std }),
    });
    expect(again.status).toBe(400);
    expect((await problemOf(again)).code).toBe("ERR_VALIDATION_FAILED");

    // The remedy the refusal names works: deleting the draft releases the delivery (its links go WITH the
    // lines they priced), and the delivery converts again, under another code, exactly once.
    const deleted = await api.request({
      method: "DELETE",
      path: `/v1/companies/${s.company}/documents/${documentId}`,
      as: s.human,
    });
    expect(deleted.status).toBe(200);
    expect(await openOf(src.documentId)).toBe("1.000000");
    const reconverted = await api.request({
      method: "POST",
      path: convertPath(src.documentId),
      as: s.human,
      body: taxedBody("2026-01-27", { taxCodeId: codes.zero }),
    });
    expect(reconverted.status).toBe(201);
    const redrafted = ConvertToInvoiceResultSchema.parse(await reconverted.json());
    expect(await draftedLines(redrafted.documentId)).toEqual([
      { code: codes.zero, amount: "9.0000", tax: "0.0000", total: "9.0000" },
    ]);
    expect(await openOf(src.documentId)).toBe("0.000000");
  });
});

describe("POST /v1/companies/{companyId}/documents/{documentId}/credit-note (4A T8)", () => {
  it("201s with an ISSUED note whose reverses_document_id is the invoice and whose magnitudes are NEGATED", async () => {
    const inv = await postedInvoice("5.000000", "45.0000", "2026-01-20");
    const res = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: s.human,
      body: creditBody("2026-01-21", "two units damaged in transit", [
        { settledLineId: inv.lineIds[0], quantity: "2.000000" },
      ]),
    });
    expect(res.status).toBe(201);
    const { documentId, lineIds, linkIds } = CreditNoteResultSchema.parse(await res.json());
    expect(lineIds).toHaveLength(1);
    expect(linkIds).toHaveLength(1);
    const [head] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ rev: string | null; status: string; series: string }[]>`
        select reverses_document_id as rev, status::text as status, series
          from app.document where id = ${documentId}`,
    );
    // Issued, not drafted — the handler's second call, and the reason's only route to an event row — and
    // numbered in the credit note's own series.
    expect(head).toEqual({ rev: inv.documentId, status: "issued", series: "ACN" });
    const [line] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ q: string; amount: string; cost: string }[]>`
        select quantity::text as q, amount::text as amount, cost::text as cost
          from app.document_line where document_id = ${documentId}`,
    );
    // Negated magnitudes, POSITIVE cost — §4.4.2 A9 and §4.7.2 A6, over the wire.
    expect(line).toEqual({ q: "-2.000000", amount: "-18.0000", cost: "6.0000" });
  });

  it("the reason reaches document_event.reason on the draft → issued row — it is not accepted and dropped", async () => {
    const inv = await postedInvoice("1.000000", "9.0000", "2026-01-22");
    const res = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: s.human,
      body: creditBody("2026-01-22", "short-shipped"),
    });
    expect(res.status).toBe(201);
    const { documentId } = CreditNoteResultSchema.parse(await res.json());
    const events = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ reason: string | null; to: string; kind: string }[]>`
        select reason, to_status::text as "to", event_kind::text as kind
          from app.document_event where document_id = ${documentId}`,
    );
    // Exactly one event, and it is the transition the handler caused. A `toContain` over an empty array
    // would have been the failure to expect if the note were left at draft.
    expect(events).toEqual([{ reason: "short-shipped", to: "issued", kind: "transition" }]);
  });

  it("an ABSENT reason is refused on the wire — `.min(1)` is the control, not a convention", async () => {
    const inv = await postedInvoice("1.000000", "9.0000", "2026-01-23");
    const res = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: s.human,
      body: creditBody("2026-01-23", undefined),
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a NEGATIVE quantity is refused on the wire — the caller states how many come back, never a minus", async () => {
    const inv = await postedInvoice("1.000000", "9.0000", "2026-01-24");
    const res = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: s.human,
      body: creditBody("2026-01-24", "x", [
        { settledLineId: inv.lineIds[0], quantity: "-1.000000" },
      ]),
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("crediting more than the invoiced quantity is 422 ERR_DOC_LINK_OVER_FULFILLED (SAH-018)", async () => {
    const inv = await postedInvoice("1.000000", "9.0000", "2026-01-25");
    const res = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: s.human,
      body: creditBody("2026-01-25", "too many", [
        { settledLineId: inv.lineIds[0], quantity: "99.000000" },
      ]),
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_DOC_LINK_OVER_FULFILLED");
  });

  it("the first gate resolves the INVOICE's policy, the second the credit note's: a principal needs both", async () => {
    const inv = await postedInvoice("1.000000", "9.0000", "2026-01-26");
    // Holding nothing: refused before the handler, on the invoice's `approval.create`.
    const outsider = await secondPrincipal(api.db, s, "cn-outsider");
    // A member of the company holding no code — see "the path parameter is the SOURCE" above (S3).
    await grantCodes(api.db, s, { principalId: outsider, roleCode: "cn-outsider" });
    const first = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: outsider,
      body: creditBody("2026-01-26", "x"),
    });
    expect(first.status).toBe(403);
    expect((await problemOf(first)).detail).toMatch(/accounting\.sales\.create/);
    // Holding the invoice's create code only: refused by the handler, on the credit note's.
    const clerk = await secondPrincipal(api.db, s, "cn-clerk");
    await grantCodes(api.db, s, {
      codes: ["accounting.sales.create"],
      principalId: clerk,
      roleCode: "cn-clerk",
    });
    const second = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: clerk,
      body: creditBody("2026-01-26", "x"),
    });
    expect(second.status).toBe(403);
    expect((await problemOf(second)).detail).toMatch(
      /accounting\.sales\.post is required to create a API_CREDIT_NOTE/,
    );
    // …and nothing was drafted: the invoice line is still fully open.
    const [open] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ open: string }[]>`
        select open_quantity::text as open from app.document_open_quantity
         where document_id = ${inv.documentId}`,
    );
    expect(open!.open).toBe("1.000000");
  });

  it("replaying the same key does not draft, or number, a second credit note", async () => {
    const inv = await postedInvoice("2.000000", "18.0000", "2026-01-27");
    const key = "4a-credit-note-replay";
    const body = creditBody("2026-01-27", "one unit back", [
      { settledLineId: inv.lineIds[0], quantity: "1.000000" },
    ]);
    const first = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: s.human,
      idempotencyKey: key,
      body,
    });
    const again = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: s.human,
      idempotencyKey: key,
      body,
    });
    expect(first.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(CreditNoteResultSchema.parse(await again.json()).documentId).toBe(
      CreditNoteResultSchema.parse(await first.json()).documentId,
    );
    const [links] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document_link where source_document_id = ${inv.documentId}`,
    );
    expect(links!.n).toBe(1);
  });

  it("the path company binds the invoice AND the target type: a sibling company's either is 404 (AGENTS.md)", async () => {
    const inv = await postedInvoice("1.000000", "9.0000", "2026-01-28");
    const other = await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
      const [company] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${s.tenant}, 'API-CN-B', 'Credit note second company', 'MYR') returning id`;
      const [type] = await tx<{ id: string }[]>`
        insert into app.document_type (tenant_id, company_id, code, name_en, module)
        values (${s.tenant}, ${company!.id}, 'API_CREDIT_NOTE', 'Credit Note', 'accounting')
        returning id`;
      return { companyId: company!.id, typeId: type!.id };
    });
    // A member of the sibling company, for the reason the conversion case above gives (S3).
    await grantCodes(api.db, { ...s, company: other.companyId }, { roleCode: "api-cn-b-member" });
    const wrongCompany = await api.request({
      method: "POST",
      path: creditPath(inv.documentId, other.companyId),
      as: s.human,
      body: creditBody("2026-01-28", "x"),
    });
    expect(wrongCompany.status).toBe(404);
    expect((await problemOf(wrongCompany)).code).toBe("ERR_NOT_FOUND");
    const wrongType = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: s.human,
      body: { ...creditBody("2026-01-28", "x"), targetDocumentTypeId: other.typeId },
    });
    expect(wrongType.status).toBe(404);
    expect((await problemOf(wrongType)).code).toBe("ERR_NOT_FOUND");
  });

  it("a target that is not the invoice's reversal type, and a delivery as the settled document, are 400", async () => {
    const inv = await postedInvoice("1.000000", "9.0000", "2026-01-29");
    // The invoice type itself as the target: legal to create, but not what API_SALES_INVOICE reverses into.
    const notTheTarget = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: s.human,
      body: {
        ...creditBody("2026-01-29", "x"),
        targetDocumentTypeId: invType,
        targetSeries: "AINV",
      },
    });
    expect(notTheTarget.status).toBe(400);
    expect((await problemOf(notTheTarget)).detail).toMatch(/is not API_CREDIT_NOTE/);
    // A delivery is returned by reversing it whole (Task 8's stock-return decision), never credited in part.
    const delivery = await postedSource("1.000000", "9.0000", "2026-01-29");
    const stock = await api.request({
      method: "POST",
      path: creditPath(delivery.documentId),
      as: s.human,
      body: {
        ...creditBody("2026-01-29", "x"),
        targetDocumentTypeId: deliveryType,
        targetSeries: "ADO",
      },
    });
    expect(stock.status).toBe(400);
    expect((await problemOf(stock)).detail).toMatch(/is a stock document/);
  });

  it("PUT …/lines on a DRAFT credit note is 409 and keeps its returns links — the invoice cannot be credited twice", async () => {
    // The route issues its note at once; `creditNoteFrom` itself leaves a draft, and a draft's lines are
    // what PUT …/lines would delete — dropping the `returns` links (0037's ON DELETE CASCADE) and reopening
    // the invoice's credited quantity.
    const inv = await postedInvoice("1.000000", "9.0000", "2026-01-30");
    const note = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      creditNoteFrom(tx, ctx(), {
        companyId: s.company,
        settledDocumentId: inv.documentId,
        targetDocumentTypeId: cnType,
        targetSeries: "ACN",
        effectiveDate: "2026-01-30",
        reason: "one unit returned",
        lines: [],
      }),
    );
    const openOfInvoice = async () => {
      const [row] = await withTenant(
        api.db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ open: string }[]>`
          select open_quantity::text as open from app.document_open_quantity
           where document_id = ${inv.documentId}`,
      );
      return row!.open;
    };
    expect(await openOfInvoice()).toBe("0.000000");
    const replaced = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/documents/${note.documentId}/lines`,
      as: s.human,
      body: {
        lines: [
          {
            lineNo: 1,
            kind: "item",
            itemId,
            warehouseId,
            quantity: "1.000000",
            unitPrice: "9.0000",
            amount: "9.0000",
          },
        ],
      },
    });
    expect(replaced.status).toBe(409);
    const problem = await problemOf(replaced);
    expect(problem.code).toBe("ERR_DOC_STATUS_ILLEGAL");
    expect(problem.detail).toMatch(/returns/);
    // The remedy named is the credit note's own, not a conversion's.
    expect(problem.detail).toMatch(/delete the draft and draft the credit note again/);
    expect(await openOfInvoice()).toBe("0.000000");
    const [links] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document_link where target_document_id = ${note.documentId}`,
    );
    expect(links!.n).toBe(note.linkIds.length);
  });

  it("a client's own returns claim on the invoice line is 400 naming it, and drafts nothing (PR 11 review, round 3)", async () => {
    // The client's two routes: a credit-note-typed draft through POST …/documents — which never sets
    // reverses_document_id, so it can never post — and a `returns` link of one unit from the invoice line
    // without the price copy. Its line is 1 / 0 / 0 / 0, consistent, so round 2's test of the sums passed it,
    // and the credit that completed the line took that unit at no value: two units' note at three units' net.
    const inv = await postedInvoice("3.000000", "27.0000", "2026-01-30");
    const drafted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "API_CREDIT_NOTE",
        effectiveDate: "2026-01-30",
        currency: "MYR",
        branchId: s.hq,
        partyId,
        lines: [{ lineNo: 1, kind: "item", itemId, warehouseId, quantity: "1.000000" }],
      },
    });
    expect(drafted.status).toBe(201);
    const { id: claimId } = (await drafted.json()) as { id: string };
    const claimLineOf = async () => {
      const [l] = await withTenant(
        api.db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ id: string; quantity: string; amount: string; tax: string; total: string }[]>`
          select id, quantity::text as quantity, amount::text as amount, tax_amount::text as tax,
                 total_incl_tax::text as total
            from app.document_line where document_id = ${claimId}`,
      );
      return l!;
    };
    const claimLine = await claimLineOf();
    const linked = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${claimId}/links`,
      as: s.human,
      body: {
        sourceDocumentId: inv.documentId,
        linkKind: "returns",
        priceFromSource: false,
        lines: [{ sourceLineId: inv.lineIds[0], targetLineId: claimLine.id, quantity: "1.000000" }],
      },
    });
    expect(linked.status).toBe(201);
    // The premise: a CONSISTENT claim, so what refuses it below is its provenance, not its figures.
    expect(await claimLineOf()).toMatchObject({
      quantity: "1.000000",
      amount: "0.0000",
      tax: "0.0000",
      total: "0.0000",
    });

    const res = await api.request({
      method: "POST",
      path: creditPath(inv.documentId),
      as: s.human,
      body: creditBody("2026-01-31", "two units returned", [
        { settledLineId: inv.lineIds[0], quantity: "2.000000" },
      ]),
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(
      new RegExp(`line 1 cannot be credited: returns target ${claimId} holds a claim on it`),
    );
    const [notes] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document where reverses_document_id = ${inv.documentId}`,
    );
    expect(notes!.n).toBe(0);
  });

  it("a sub-path adds no route module — the documents module already has its probe (hazard 31)", async () => {
    const { ROUTES } = await import("../../../src/routes");
    expect(ROUTES.filter((r) => r.path.includes("credit-note"))).toEqual([]);
  });
});

describe("PUT …/lines on a draft holding returns links (PR 11 review, round 2)", () => {
  it("a client-drafted PURCHASE_RETURN replaces its lines (200), and 0037's cascade drops its client-keyed returns link with them", async () => {
    // 3C's PURCHASE_RETURN is drafted and linked by the CLIENT (sah-017.test.ts; contracts 4.3.1): no service
    // derives it and no residue rule sums its links, so it is not the derived draft the 409 protects. Only a
    // credit note `creditNoteFrom` drafted — its header names `reverses_document_id`, which a draft through
    // POST …/documents never can — is frozen for `returns`.
    // The pack's own type, configured for the company; the client drafts it by code below.
    await seedTypeFromPack(api.db, s, "PURCHASE_RETURN");
    await grantCodes(api.db, s, { codes: ["accounting.purchase.create"] });
    const vendorId = await seedParty(api.db, s, { kind: "vendor", code: "API-PR-VEND" });
    // The source: two units received and posted.
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptType,
      series: "SRT",
      effectiveDate: "2026-01-31",
      partyId: vendorId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          quantity: "2.000000",
          unitPrice: "3.0000",
          amount: "6.0000",
        },
      ],
    });
    await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(), { documentId: receipt.documentId, jobs: recordingJobs() }),
    );
    const openOfReceipt = async () => {
      const [row] = await withTenant(
        api.db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ open: string }[]>`
          select open_quantity::text as open from app.document_open_quantity
           where document_id = ${receipt.documentId}`,
      );
      return row!.open;
    };
    const returnLine = (quantity: string, amount: string) => ({
      lineNo: 1,
      kind: "item",
      itemId,
      warehouseId,
      quantity,
      unitPrice: "3.0000",
      amount,
    });

    // The client's path: the generic draft, then a `returns` link onto its line.
    const drafted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "PURCHASE_RETURN",
        effectiveDate: "2026-01-31",
        currency: "MYR",
        branchId: s.hq,
        partyId: vendorId,
        lines: [returnLine("1.000000", "3.0000")],
      },
    });
    expect(drafted.status).toBe(201);
    const { id: returnId } = (await drafted.json()) as { id: string };
    const lineIdsOf = async () =>
      (
        await withTenant(
          api.db.rw,
          s.tenant,
          s.human,
          (tx) => tx<{ id: string }[]>`
            select id from app.document_line where document_id = ${returnId} order by line_no`,
        )
      ).map((r) => r.id);
    const linksOf = () =>
      withTenant(
        api.db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ targetLineId: string; quantity: string }[]>`
          select target_line_id as "targetLineId", quantity::text as quantity
            from app.document_link where target_document_id = ${returnId} and link_kind = 'returns'`,
      );
    const link = async (quantity: string) =>
      api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${returnId}/links`,
        as: s.human,
        body: {
          sourceDocumentId: receipt.documentId,
          linkKind: "returns",
          lines: [
            {
              sourceLineId: receipt.lineIds[0],
              targetLineId: (await lineIdsOf())[0],
              quantity,
            },
          ],
        },
      });
    expect((await link("1.000000")).status).toBe(201);
    expect(await linksOf()).toHaveLength(1);
    expect(await openOfReceipt()).toBe("1.000000");

    const replaced = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/documents/${returnId}/lines`,
      as: s.human,
      body: { lines: [returnLine("2.000000", "6.0000")] },
    });
    expect(replaced.status).toBe(200);
    // PINNED, not incidental: the replacement deletes the line the link was keyed to, and
    // `document_link.target_line_id … on delete cascade` (0037) takes the link with it — the release path 0037
    // names for client-keyed links, the same as for `fulfils` and `receives_against`. The receipt is open again
    // and the client links the new line itself.
    expect(await linksOf()).toEqual([]);
    expect(await openOfReceipt()).toBe("2.000000");
    expect((await link("2.000000")).status).toBe(201);
    expect(await linksOf()).toEqual([
      { targetLineId: (await lineIdsOf())[0], quantity: "2.000000" },
    ]);
    expect(await openOfReceipt()).toBe("0.000000");
  });
});
