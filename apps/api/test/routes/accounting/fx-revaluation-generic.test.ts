import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RevaluationResultSchema } from "@dulja/contracts";
import { ageingTieOut, issueDocument, withTenant } from "@dulja/db";
import {
  draftTypedDocument,
  seedBranch,
  seedCurrency,
  seedItem,
  seedRate,
  seedTenantV2,
  seedWarehouse,
  uuidv7,
  type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories up.
import { problemOf } from "../../../../../tests/support/api";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../../tests/invariants/support/ar-ap";
import { startApi, type StartedApi } from "../../support/app";

/**
 * Code review 2, F8 — FX_REVALUATION is posted ONLY by the FX services (§4.14, ADR 0047).
 *
 * Three readers trust `document_line.custom_fields.fxKind` on a posted FX_REVALUATION: `ageingTieOut`'s `rev`
 * CTE subtracts every 'unrealised' one from the ledger side as legitimate revaluation, `revalueAtPeriodEnd`
 * treats the period as already revalued when one dated its last day exists, and the realised path keys its
 * documents on 'realised' plus `settlementDocumentId`. The generic `POST …/documents` accepted
 * `documentTypeCode: "FX_REVALUATION"` (its policy has no create code, so the gate asked
 * `accounting.journal.post`) and wrote `customFields` straight into `custom_fields`; `…/transitions` then
 * posted it. Before the fix a hand-made "revaluation" of 1.0000 on 1200 hid itself from the tie-out
 * (difference 0.0000 against a JOURNAL's -1.0000) and turned the period's real 500.0000 revaluation into
 * `{ documentId: null }`.
 */
/** A 400 from `refuseServiceOnlyType` itself, not from anything a route reads after it. */
async function refused(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  const problem = await problemOf(res);
  expect(problem.code).toBe("ERR_VALIDATION_FAILED");
  expect(problem.detail).toMatch(/^FX_REVALUATION is posted only by the FX services/);
}

describe("the generic document routes refuse FX_REVALUATION (F8)", () => {
  let api: StartedApi;
  let s: Seed;
  let f: ArApFixture;
  let januaryId: string;

  const ctx = async () => ({
    tenantId: s.tenant,
    actorId: s.human,
    requestId: await uuidv7(api.db.admin),
  });
  const difference1200 = async () => {
    const rows = await withTenant(api.db.rw, await ctx(), (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    return rows.find((r) => r.accountCode === "1200")!.difference;
  };
  const fxDocuments = async () => {
    const [row] = await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document d
          join app.document_type t on t.id = d.document_type_id
         where d.company_id = ${s.company} and t.code = 'FX_REVALUATION'`,
    );
    return row!.n;
  };
  const forgedLines = () => [
    {
      lineNo: 1,
      accountId: f.accountIds["1200"]!,
      debit: "1.0000",
      customFields: { fxKind: "unrealised" },
    },
    {
      lineNo: 2,
      accountId: f.accountIds["4900"]!,
      credit: "1.0000",
      customFields: { fxKind: "unrealised" },
    },
  ];

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "FxGeneric");
    // Grants s.human accounting.journal.post among others — the code the FX_REVALUATION gate resolves.
    f = await arApFixture(api.db, s);
    await seedCurrency(api.db, s, { code: "EUR" });
    await seedRate(api.db, s, {
      from: "EUR",
      to: "MYR",
      on: "2026-01-31",
      rate: "5.50000000",
      source: "manual:test",
    });
    const [january] = await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx<{ id: string }[]>`
        select id::text as id from app.fiscal_period
         where company_id = ${s.company} and starts_on = '2026-01-01'`,
    );
    januaryId = january!.id;
    // 1000 EUR open at 5.0: the January revaluation at 5.5 moves 1200 by 500.0000.
    await postFromPack(api.db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-05",
      partyId: f.partyIds.customer,
      currency: "EUR",
      exchangeRate: "5.00000000",
      rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "1000.0000" }],
    });
  }, 600_000);
  afterAll(async () => {
    await api?.stop();
  });

  it("POST …/documents refuses documentTypeCode FX_REVALUATION with ERR_VALIDATION_FAILED and writes nothing", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "FX_REVALUATION",
        effectiveDate: "2026-01-31",
        currency: "MYR",
        branchId: s.hq,
        lines: forgedLines(),
      },
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toContain("FX_REVALUATION");
    expect(await fxDocuments()).toBe(0);
  });

  it("PUT …/lines refuses an FX_REVALUATION draft, so the generic line writer never sets its markers", async () => {
    // No route can draft one any more; this one is inserted directly, dated mid-month and with no marker,
    // so it is invisible to every FX reader whatever happens here.
    // `arApFixture` returns ids for its own type list only, so FX_REVALUATION's is resolved by code.
    const draftId = await uuidv7(api.db.admin);
    await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date,
                                  currency, branch_id)
        select ${draftId}, ${s.tenant}, ${s.company}, t.id, 'FXR', '2026-01-15', 'MYR', ${s.hq}
          from app.document_type t where t.company_id = ${s.company} and t.code = 'FX_REVALUATION'`,
    );
    const [drafted] = await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx<{ status: string }[]>`
        select status::text as status from app.document where id = ${draftId}`,
    );
    expect(drafted?.status).toBe("draft");
    const res = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/documents/${draftId}/lines`,
      as: s.human,
      body: { lines: forgedLines() },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    const [lines] = await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document_line where document_id = ${draftId}`,
    );
    expect(lines!.n).toBe(0);
  });

  // Code review 3 (Phase 4), R6. The 3D conversion takes its TARGET type from the body and asked nothing of
  // it but the target policy's create code (FX_REVALUATION's resolves to accounting.journal.post), so on
  // 381bb34 an issued SALES_ORDER converted into a 201 FX_REVALUATION draft with item lines — contradicting
  // "its only producers are the FX services". It could not post (no markers, and PUT …/lines refuses one),
  // but the route is refused the way the generic create route is, through the same helper.
  it("POST …/documents/{id}/convert refuses targetDocumentTypeCode FX_REVALUATION and drafts nothing (R6)", async () => {
    const { itemId, baseUnitId } = await seedItem(api.db, s, {
      code: "FXG-ITEM",
      trackLots: false,
    });
    const warehouseId = await seedWarehouse(api.db, s, { code: "FXG-WH" });
    const [salesOrder] = await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx<{ id: string }[]>`
        select id::text as id from app.document_type
         where company_id = ${s.company} and code = 'SALES_ORDER'`,
    );
    const order = await draftTypedDocument(api.db, s, {
      documentTypeId: salesOrder!.id,
      series: "SO",
      effectiveDate: "2026-01-10",
      partyId: f.partyIds.customer,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "5.0000",
          amount: "50.0000",
        },
      ],
    });
    const issueCtx = await ctx();
    await withTenant(api.db.rw, issueCtx, (tx) =>
      issueDocument(tx, issueCtx, { documentId: order.documentId }),
    );
    const convert = (targetDocumentTypeCode: string, targetSeries: string) =>
      api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
        as: s.human,
        body: {
          targetDocumentTypeCode,
          targetSeries,
          effectiveDate: "2026-01-20",
          warehouseId,
          fefo: false,
          lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
        },
      });

    const before = await fxDocuments();
    const res = await convert("FX_REVALUATION", "FXR");
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toContain("FX_REVALUATION");
    expect(await fxDocuments()).toBe(before);

    // The refusal is the type's, not the route's: the same order still converts into a delivery.
    const delivery = await convert("DELIVERY_ORDER", "DO");
    expect(delivery.status).toBe(201);
  });

  // R6's verification: three more routes take the type code from the body. On c7d26b4 POST …/transfers with
  // FX_REVALUATION was a 201 and the company's FX_REVALUATION count went 0 → 1; …/count-sheet and
  // …/{id}/receipt looked the type up by the body's code the same way. Each now refuses it before any read,
  // through the helper the generic routes use.
  it("POST …/transfers, …/{id}/receipt and …/count-sheet refuse documentTypeCode FX_REVALUATION and draft nothing", async () => {
    const { itemId, baseUnitId } = await seedItem(api.db, s, {
      code: "FXG-STOCK",
      trackLots: false,
    });
    const source = await seedWarehouse(api.db, s, { code: "FXG-SRC" });
    const branch = await seedBranch(api.db, s, { code: "FXG-BR2", nameEn: "Branch 2" });
    const destination = await seedWarehouse(api.db, s, { code: "FXG-BR2", branchId: branch });
    await seedWarehouse(api.db, s, { code: "FXG-BR2-TR", kind: "in_transit", branchId: branch });
    // Stock in FXG-SRC, so a count sheet has a line and a dispatch has something to send.
    const { documentId: receiptId } = await postFromPack(api.db, s, {
      code: "GOODS_RECEIPT",
      effectiveDate: "2026-01-08",
      partyId: f.partyIds.vendor,
      warehouseId: source,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId: source,
          unitId: baseUnitId,
          quantity: "5.000000",
          unitPrice: "2.0000",
          amount: "10.0000",
        },
      ],
    });
    const before = await fxDocuments();
    await refused(
      await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/count-sheet`,
        as: s.human,
        body: {
          documentTypeCode: "FX_REVALUATION",
          series: "FXR",
          effectiveDate: "2026-01-16",
          warehouseId: source,
        },
      }),
    );
    await refused(
      await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/transfers`,
        as: s.human,
        body: {
          documentTypeCode: "FX_REVALUATION",
          series: "FXR",
          effectiveDate: "2026-01-16",
          fromWarehouseId: source,
          toWarehouseId: destination,
          lines: [{ itemId, unitId: baseUnitId, quantity: "1.000000" }],
        },
      }),
    );
    await refused(
      await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${receiptId}/receipt`,
        as: s.human,
        body: { documentTypeCode: "FX_REVALUATION", series: "FXR", effectiveDate: "2026-01-16" },
      }),
    );
    expect(await fxDocuments()).toBe(before);
  });

  // Code review 4, item 2. POST …/documents/settlements takes its type code from the body too. It already
  // refused FX_REVALUATION, but only inside draftSettlement, by policy shape and after the type lookup
  // ("document type FX_REVALUATION is not a settlement: …"), so the helper's "every route that takes a type
  // code from its BODY refuses the type, before any read" was not true of it. It now asks the helper first.
  it("POST …/documents/settlements refuses documentTypeCode FX_REVALUATION through the helper and drafts nothing", async () => {
    const before = await fxDocuments();
    await refused(
      await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/settlements`,
        as: s.human,
        body: {
          documentTypeCode: "FX_REVALUATION",
          series: "FXR",
          effectiveDate: "2026-01-16",
          partyId: f.partyIds.customer,
          bankAccountId: f.accountIds["1100"]!,
          branchId: s.hq,
          currency: "MYR",
          exchangeRate: "1.00000000",
          amount: "1.0000",
          allocations: [],
        },
      }),
    );
    expect(await fxDocuments()).toBe(before);
  });

  it("after a forging attempt the period's real revaluation still posts, and the tie-out still sees a JOURNAL", async () => {
    // The attacker's whole attempt: draft through the generic route and, if a draft comes back, post it.
    // Before the fix both steps succeeded, and the posted marker made the real revaluation below a no-op.
    const forged = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "FX_REVALUATION",
        effectiveDate: "2026-01-31",
        currency: "MYR",
        branchId: s.hq,
        lines: forgedLines(),
      },
    });
    if (forged.status === 201) {
      const { id: forgedId } = (await forged.json()) as { id: string };
      await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${forgedId}/transitions`,
        as: s.human,
        body: { to: "posted" },
      });
    }

    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/revaluations`,
      as: s.human,
      body: { fiscalPeriodId: januaryId },
    });
    expect(res.status).toBe(201);
    const body = RevaluationResultSchema.parse(await res.json());
    expect(body.documentId).not.toBeNull();
    expect(body.lines.map((l) => [l.accountCode, l.delta.amount])).toEqual([["1200", "500.0000"]]);
    expect(await difference1200()).toBe("0.0000");

    // The control the forged document defeated: the same 1.0000 as a JOURNAL is caught.
    const journal = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "JOURNAL",
        effectiveDate: "2026-01-31",
        currency: "MYR",
        branchId: s.hq,
        lines: forgedLines().map(({ customFields: _marker, ...line }) => line),
      },
    });
    expect(journal.status).toBe(201);
    const { id } = (await journal.json()) as { id: string };
    const posted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${id}/transitions`,
      as: s.human,
      body: { to: "posted" },
    });
    expect(posted.status).toBe(200);
    expect(await difference1200()).toBe("-1.0000");
    // Asserted last so that, on a tree that let it through, the damage above is what the case reports.
    expect(forged.status).toBe(400);
  });
});
